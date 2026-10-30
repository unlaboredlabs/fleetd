// The preload in a plain browser (web/vite.config.ts): window.fleetd with a fixture standing in for the hub, as
// FLEETD_FIXTURE does in the app, then the renderer. `?fixture=<name>` picks the fixture (agents-work by default); the
// picker in the corner lists them all. Calls a fixture has no answer for fail as they do under FLEETD_FIXTURE.
import { FixtureSource, type FixtureFile } from "../src/main/hub/fixture.ts";
import { sessionHash } from "../src/main/sessionWindow.ts";
import type { FleetdApi } from "../src/preload/api";
import type { HubFrame } from "../src/shared/hub";
import { FIRST_HUB, type HubEntry } from "../src/shared/hubs";
import type { CallRequest } from "../src/shared/ipc";
import type { UpdatesState } from "../src/shared/updates";

const DEFAULT_FIXTURE = "agents-work";
const HUB = "http://devbox:4790";
const notHere = { code: "web_preview", message: "The web preview can't do this; the app can." };

type File = FixtureFile & { update?: { current?: string; app: UpdatesState["app"]; release?: UpdatesState["release"] } };

// The fixture's clock, running on from its "now" as QA pins it, so "3 min ago" reads as the fixture was written.
const runClockFrom = (now: string) => {
  const RealDate = Date;
  const offset = RealDate.parse(now) - RealDate.now();
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args: unknown[]) => (args.length === 0 ? new target(RealDate.now() + offset) : (Reflect.construct(target, args) as object)),
    apply: () => new RealDate(RealDate.now() + offset).toString(),
    get: (target, key) => (key === "now" ? () => RealDate.now() + offset : (Reflect.get(target, key) as unknown)),
  });
};

const picker = (names: readonly string[], current: string) => {
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Fixture");
  select.title = "The sample data this preview shows";
  for (const name of names) select.add(new Option(name, name, false, name === current));
  select.addEventListener("change", () => (location.search = `?fixture=${encodeURIComponent(select.value)}`));
  Object.assign(select.style, { position: "fixed", right: "8px", bottom: "8px", zIndex: "2147483647", font: "12px system-ui", opacity: "0.85" });
  document.body.append(select);
};

/** One hub of the fixture's, as main's HubService serves it. */
const hubOf = (fixture: FixtureFile) => {
  const listeners = new Set<(frame: HubFrame) => void>();
  // As main's HubService: a subscriber gets no events or live frames until its snapshot.
  const awaitingSnapshot = new Set<(frame: HubFrame) => void>();
  const source = new FixtureSource(fixture, (frame) => {
    for (const listener of listeners) {
      if (frame.t === "snapshot") awaitingSnapshot.delete(listener);
      else if ((frame.t === "event" || frame.t === "live") && awaitingSnapshot.has(listener)) continue;
      listener(frame);
    }
  });
  return { listeners, awaitingSnapshot, source, file: fixture };
};

const fleetdApi = (file: File): FleetdApi => {
  // The file's own hub first, then any it lists beside it, with ids as main gives them (main/hub/hubs.ts).
  const { hubs: more = [], label, color, ...first } = file;
  const entries: HubEntry[] = [
    { id: FIRST_HUB, label: label ?? "devbox", ...(color === undefined ? {} : { color }) },
    ...more.map((h, i): HubEntry => ({ id: `h${String(i + 2)}`, label: h.label, ...(h.color === undefined ? {} : { color: h.color }) })),
  ];
  const hubs = new Map([[FIRST_HUB, hubOf(first)], ...more.map((h, i) => [`h${String(i + 2)}`, hubOf(h.fixture)] as const)]);
  const of = (id: string) => {
    const hub = hubs.get(id);
    if (hub === undefined) throw new Error(`no hub ${id} in this fixture`);
    return hub;
  };
  const updates: UpdatesState = { current: file.update?.current ?? "0.0.0", app: file.update?.app ?? { kind: "current" }, release: file.update?.release ?? null };
  const done = () => Promise.resolve();
  return {
    fixture: file.name,
    vibrancy: false,
    version: "web preview",
    platform: "linux",
    copy: (text) => navigator.clipboard.writeText(text).catch(() => undefined),
    secret: {
      submit: () => Promise.resolve({ ok: false, error: notHere }),
      projectEnv: () => Promise.resolve({ ok: false, error: notHere }),
      mcpServer: () => Promise.resolve({ ok: false, error: notHere }),
      hubLink: () => Promise.resolve({ ok: false, error: notHere }),
      googleClient: () => Promise.resolve({ ok: false, error: notHere }),
      googlePubsub: () => Promise.resolve({ ok: false, error: notHere }),
      claudeAccount: () => Promise.resolve({ ok: false, error: notHere }),
      onePassword: () => Promise.resolve({ ok: false, error: notHere }),
    },
    google: {
      connect: () => Promise.resolve({ ok: false, error: notHere }),
      cancel: done,
    },
    github: {
      createApp: () => Promise.resolve({ ok: false, error: notHere }),
      connect: () => Promise.resolve({ ok: false, error: notHere }),
      cancel: done,
    },
    openExternal: (url) => {
      window.open(url, "_blank", "noopener");
      return Promise.resolve({ ok: true });
    },
    hubs: {
      initial: entries,
      list: () => Promise.resolve(entries),
      subscribe: () => () => undefined,
      update: () => Promise.resolve({ ok: false, message: notHere.message }),
    },
    hub: {
      subscribe: (id, listener) => {
        const { listeners, awaitingSnapshot, source } = of(id);
        listeners.add(listener);
        awaitingSnapshot.add(listener);
        listener({ t: "state", state: source.state });
        source.resync();
        source.refreshLive();
        return () => {
          listeners.delete(listener);
          awaitingSnapshot.delete(listener);
        };
      },
      call: (id, tool, input) => of(id).source.call({ tool, input: input as CallRequest["input"] }),
      chat: done,
      focus: done,
      watch: (id, session) => {
        of(id).source.watch(session);
        return done();
      },
      input: done,
      resync: (id) => {
        of(id).source.resync();
        return done();
      },
      retryNow: (id) => {
        of(id).source.reconnectNow();
        return done();
      },
      cache: {
        read: (id) => {
          const cache = of(id).file.cache;
          return Promise.resolve(cache === undefined ? null : JSON.stringify(cache));
        },
        write: done,
      },
      connect: () => Promise.resolve(of(FIRST_HUB).source.connectAnswer),
      forget: done,
    },
    pair: {
      start: () => Promise.resolve({ appPair: null, problem: null, probe: { answers: false, hub: HUB } }),
      probe: (hub) => Promise.resolve({ answers: false, hub }),
      redeem: () => Promise.resolve({ ok: false, failure: { code: "", message: notHere.message } }),
      auto: () => Promise.resolve({ ok: false, failure: { code: "", message: notHere.message } }),
      store: () => Promise.resolve({ kind: "os", where: "the OS keychain" }),
      setup: () => Promise.resolve({ ok: false, message: "Run this in a terminal:", command: "fleetd init" }),
    },
    system: { hostName: () => Promise.resolve("devbox") },
    machines: {
      joinHere: (_hub, machineId) => Promise.resolve({ machineId, state: "failed", steps: [], message: notHere.message }),
      joinHereState: () => Promise.resolve(null),
      thisComputer: () => Promise.resolve({ kind: "none" }),
      onJoinHere: () => () => undefined,
    },
    projects: { pickFolder: () => Promise.resolve(null), readDrop: () => Promise.resolve({ kind: "other" }) },
    updates: { state: () => Promise.resolve(updates), subscribe: () => () => undefined, check: done, install: done, keep: done },
    app: {
      onMenuCommand: () => () => undefined,
      onOpen: () => () => undefined,
      notify: () => Promise.resolve(false),
      setBadge: done,
      // The pop-out: the same page at the session's route, in a tab of its own.
      sessionWindow: (request) => {
        window.open(`${location.pathname}${location.search}${sessionHash(request)}`, "_blank");
        return done();
      },
      setTheme: done,
      linkHandler: () => Promise.resolve({ packaged: false, handler: false }),
      presence: () => Promise.resolve(false),
      setMenuState: done,
      logError: (report) => {
        console.error(report);
        return done();
      },
    },
  };
};

const name = new URLSearchParams(location.search).get("fixture") ?? DEFAULT_FIXTURE;
const [names, answer] = await Promise.all([
  fetch("/@fleetd-web/fixtures").then((r) => r.json() as Promise<string[]>),
  fetch(`/@fleetd-web/fixture/${encodeURIComponent(name)}`),
]);
picker(names, name);
if (answer.ok) {
  const file = (await answer.json()) as File;
  runClockFrom(file.now);
  Object.defineProperty(window, "fleetd", { value: fleetdApi(file) });
  // The renderer's entry as index.html names it, from the server's root (src/renderer).
  const entry = "/src/main.tsx";
  await import(/* @vite-ignore */ entry);
} else {
  const root = document.getElementById("root");
  if (root !== null) root.textContent = await answer.text();
}
