import { readFileSync } from "node:fs";
import { app, shell } from "electron";
import type { AppImageUpdater, DebUpdater, MacUpdater } from "electron-updater";
import { z } from "zod";
import { DEB, type AppUpdate, type Release, type UpdatesState } from "../shared/updates";
import { compareVersions } from "../shared/pairing";
import { RELEASE_BUILD } from "./build";
import { feedUrl } from "./update-feed";
import { failureReason } from "./update-messages";
import { fetchRelease } from "./update-release";
import { step, type UpdateEffect, type UpdateInput } from "./update-state";

/**
 * A background check runs when this much wall-clock time has passed since the last one. The timer only looks at the
 * clock: a timer's own clock stops while the computer sleeps, so a long interval on it alone almost never fires on a
 * laptop that sleeps between uses.
 */
export const CHECK_EVERY_MS = 10 * 60 * 1000;
/** How often the timer looks. */
const TICK_MS = 60 * 1000;
/** A window coming to the front checks too, unless a check ran this recently. */
export const FOCUS_GAP_MS = 60 * 1000;

/** The app's own update, for the page (IPC.updates*) and the app menu. */
export interface Updates {
  /** Loads electron-updater and starts the checks: now, then every 10 minutes. Call once the window is up. */
  readonly start: () => void;
  /** A window came to the front: checks unless one just ran. */
  readonly focused: () => void;
  readonly state: () => UpdatesState;
  /** A check someone asked for: "Checking…", then its answer, failure included. */
  readonly check: () => void;
  /** "Update and restart": restarts now when the update is in, or as soon as it is; the deb opens its download. */
  readonly install: () => void;
  /** Takes back "Update and restart" while the download runs. */
  readonly keep: () => void;
  readonly onChange: (listener: (state: UpdatesState) => void) => void;
}

/** The state, its listeners, and the machine's steps; `act` runs what a step asks of main. */
const holder = (initial: AppUpdate, deb: boolean, act: (effect: UpdateEffect) => void, release: Release | null = null) => {
  let current: AppUpdate = initial;
  let files = release;
  const listeners = new Set<(state: UpdatesState) => void>();
  const state = (): UpdatesState => ({ current: app.getVersion(), app: current, release: files });
  const changed = () => {
    const s = state();
    for (const listener of listeners) listener(s);
  };
  return {
    state,
    get: () => current,
    onChange: (listener: (state: UpdatesState) => void) => void listeners.add(listener),
    send: (input: UpdateInput) => {
      const [next, effect] = step({ app: current, deb }, input);
      if (next !== current) {
        current = next;
        changed();
      }
      act(effect);
    },
    setRelease: (next: Release) => {
      files = next;
      changed();
    },
  };
};

/** Under FLEETD_FIXTURE: the fixture's `update` section, so the QA gate shoots every state without a release feed. */
const FixtureSection = z.object({
  update: z
    .object({
      current: z.string().optional(),
      app: z.custom<AppUpdate>((v) => typeof v === "object" && v !== null && typeof (v as { kind?: unknown }).kind === "string"),
      release: z.custom<Release>((v) => typeof v === "object" && v !== null && Array.isArray((v as { changes?: unknown }).changes)).nullish(),
    })
    .optional(),
});

const fixtureUpdates = (file: string): Updates => {
  const section = FixtureSection.parse(JSON.parse(readFileSync(file, "utf8"))).update;
  const h = holder(
    section?.app ?? { kind: "current" },
    false,
    (effect) => {
      if (effect !== null) console.info(`fixture update: ${effect}`);
    },
    section?.release ?? null,
  );
  const version = section?.current;
  return {
    start: () => undefined,
    focused: () => undefined,
    state: () => (version === undefined ? h.state() : { ...h.state(), current: version }),
    // A fixture's answer is the state it starts in.
    check: () => undefined,
    install: () => h.send({ type: "install" }),
    keep: () => h.send({ type: "keep" }),
    onChange: (listener) => h.onChange((s) => listener(version === undefined ? s : { ...s, current: version })),
  };
};

const unsupported = (): Updates => {
  const h = holder({ kind: "unsupported" }, false, () => undefined);
  return {
    start: () => undefined,
    focused: () => undefined,
    state: h.state,
    check: () => undefined,
    install: () => undefined,
    keep: () => undefined,
    onChange: h.onChange,
  };
};

/**
 * Checks the release feed at launch, every 10 minutes and when a window comes to the front. The packaged macOS app
 * and the AppImage download an update in the background; the page offers "Update and restart", and the next quit
 * installs it anyway (Squirrel.Mac requires it signed by the same team). Any other Linux install is the deb (the installer only installs the
 * AppImage), which can't update itself because dpkg needs root: it only checks, and the page offers the download and
 * the command. Dev and test builds have nothing to update to; a fixture (`fixtureFile`) stands in for the feed.
 */
export const updates = (fixtureFile: string | null): Updates => {
  if (fixtureFile !== null) return fixtureUpdates(fixtureFile);
  if (!RELEASE_BUILD || !app.isPackaged || (process.platform !== "darwin" && process.platform !== "linux")) return unsupported();
  const url = feedUrl(app.getVersion(), process.env["FLEETD_BASE_URL"]);
  const deb = process.platform === "linux" && process.env["APPIMAGE"] === undefined;
  let updater: MacUpdater | AppImageUpdater | DebUpdater | null = null;
  const h = holder({ kind: "idle" }, deb, (effect) => {
    if (effect === "quit-and-install") updater?.quitAndInstall();
    if (effect === "open-download") void shell.openExternal(`${url}/${DEB}`);
  });

  let loading: Promise<boolean> | null = null;
  const load = async (): Promise<boolean> => {
    const { AppImageUpdater, DebUpdater, MacUpdater } = await import("electron-updater");
    const options = { provider: "generic" as const, url };
    const u = process.platform === "darwin" ? new MacUpdater(options) : deb ? new DebUpdater(options) : new AppImageUpdater(options);
    // The staple-later flow replaces a published zip, so blockmaps aren't published; always download the whole file.
    u.disableDifferentialDownload = true;
    u.autoDownload = !deb;
    u.autoInstallOnAppQuit = !deb;
    u.on("update-available", ({ version }) => {
      // The deb's update check (desktop-update-check.sh) waits for this line.
      if (deb) console.info(`update notice: fleetd ${version} is available as ${DEB}`);
      h.send({ type: "available", version });
    });
    u.on("update-not-available", () => h.send({ type: "none" }));
    // electron-updater reports every chunk; the page's percent changes at most once a second.
    let progressAt = 0;
    u.on("download-progress", ({ percent }) => {
      const now = Date.now();
      if (now - progressAt < 1000) return;
      progressAt = now;
      h.send({ type: "progress", percent });
    });
    u.on("update-downloaded", ({ version }) => h.send({ type: "downloaded", version }));
    u.on("error", (error) => h.send({ type: "error", reason: failureReason(error) }));
    updater = u;
    return true;
  };
  const loaded = (): Promise<boolean> =>
    (loading ??= load().catch((error: unknown) => {
      // Never an unhandled rejection: the app runs on without updates, and an asked-for check says why.
      console.error("couldn't load the updater:", error instanceof Error ? error.message : error);
      return false;
    }));

  let checkedAt = 0;
  const run = (manual: boolean): void => {
    checkedAt = Date.now();
    h.send({ type: "check", manual });
    // What's new and the hub's newest build, read on every check: the hub can fall behind while this app is current.
    const release = fetchRelease(url).then((r) => {
      h.setRelease(r);
      return r;
    });
    void loaded().then(async (ok) => {
      if (!ok) {
        if (manual) h.send({ type: "error", reason: "The updater didn't load. Reinstall fleetd to get updates again." });
        return;
      }
      // A ready update is checked against release.json first: electron-updater would fetch it again for nothing, but a
      // newer build than the ready one is downloaded, or the restart would install a stale one.
      const ready = h.get();
      if (ready.kind === "ready") {
        const newest = (await release).app;
        if (newest === null || compareVersions(newest, ready.version) !== 1) return;
      }
      updater?.checkForUpdates().catch((error: unknown) => {
        console.warn("update check failed:", error instanceof Error ? error.message : error);
        h.send({ type: "error", reason: failureReason(error) });
      });
    });
  };

  return {
    start: () => {
      run(false);
      setInterval(() => {
        if (Date.now() - checkedAt >= CHECK_EVERY_MS) run(false);
      }, TICK_MS).unref();
    },
    focused: () => {
      if (Date.now() - checkedAt >= FOCUS_GAP_MS) run(false);
    },
    state: h.state,
    check: () => run(true),
    install: () => h.send({ type: "install" }),
    keep: () => h.send({ type: "keep" }),
    onChange: h.onChange,
  };
};
