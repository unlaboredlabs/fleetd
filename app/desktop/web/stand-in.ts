// The preload in a plain browser (web/vite.config.ts): window.fleetd with a fixture standing in for the hub, as
// FLEETD_FIXTURE does in the app, then the renderer. `?fixture=<name>` picks the fixture; the picker in the corner
// lists them all. Calls a fixture has no answer for fail as they do under FLEETD_FIXTURE.
import { FixtureSource, type FixtureFile } from "../src/main/hub/fixture.ts";
import { sessionHash } from "../src/main/sessionWindow.ts";
import type { FleetdApi } from "../src/preload/api";
import type { HubFrame } from "../src/shared/hub";
import { FIRST_HUB, type HubEntry } from "../src/shared/hubs";
import type { CallRequest } from "../src/shared/ipc";
import type { UpdatesState } from "../src/shared/updates";

const DEFAULT_FIXTURE = "sessions-page";
const notHere = { code: "web_preview", message: "The web preview can't do this; the app can." };

// The fixture's clock, running on from its "now", so "3 min ago" reads as the fixture was written.
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
  select.addEventListener("change", () => {
    const q = new URLSearchParams(location.search);
    q.set("fixture", select.value);
    location.search = `?${q.toString()}`;
  });
  Object.assign(select.style, { position: "fixed", right: "8px", bottom: "8px", zIndex: "2147483647", font: "11px system-ui", opacity: "0.5" });
  if (new URLSearchParams(location.search).get("shot") === null) document.body.append(select);
};

const failed = () => Promise.resolve({ ok: false as const, error: notHere });
const done = () => Promise.resolve();

const fleetdApi = (file: FixtureFile): FleetdApi => {
  const listeners = new Set<(frame: HubFrame) => void>();
  const awaitingSnapshot = new Set<(frame: HubFrame) => void>();
  const source = new FixtureSource(file, (frame) => {
    for (const listener of listeners) {
      if (frame.t === "snapshot") awaitingSnapshot.delete(listener);
      else if ((frame.t === "event" || frame.t === "live") && awaitingSnapshot.has(listener)) continue;
      listener(frame);
    }
  });
  const updates: UpdatesState = { current: "0.0.0", app: { kind: "current" }, release: null } as unknown as UpdatesState;
  const hubs: readonly HubEntry[] = [{ id: FIRST_HUB, label: file.label ?? "devbox", ...(file.color === undefined ? {} : { color: file.color }) }];
  return {
    fixture: null,
    vibrancy: false,
    version: "design preview",
    platform: "darwin",
    copy: (text) => navigator.clipboard.writeText(text).catch(() => undefined),
    secret: { submit: failed, projectEnv: failed, mcpServer: failed, hubLink: failed, mcpOauthClient: failed, claudeAccount: failed, onePassword: failed, telegram: failed },
    github: { createApp: failed, connect: failed, cancel: done },
    openExternal: (url) => {
      window.open(url, "_blank", "noopener");
      return Promise.resolve({ ok: true });
    },
    files: { open: () => Promise.resolve({ ok: false, message: notHere.message }), save: () => Promise.resolve({ ok: false, message: notHere.message }) },
    hubs: { initial: hubs, list: () => Promise.resolve(hubs), subscribe: () => () => undefined, update: () => Promise.resolve({ ok: false, message: notHere.message }) },
    hub: {
      subscribe: (_hub, listener) => {
        listeners.add(listener);
        awaitingSnapshot.add(listener);
        listener({ t: "state", state: source.state });
        source.resync();
        return () => {
          listeners.delete(listener);
          awaitingSnapshot.delete(listener);
        };
      },
      call: (_hub, tool, input) => source.call({ tool, input: input as CallRequest["input"] }),
      chat: done,
      focus: done,
      watch: (_hub, session) => {
        source.watch(session);
        return done();
      },
      input: done,
      resync: () => {
        source.resync();
        return done();
      },
      retryNow: () => {
        source.reconnectNow();
        return done();
      },
      cache: { read: () => Promise.resolve(file.cache === undefined ? null : JSON.stringify(file.cache)), write: done },
      connect: () => Promise.resolve(source.connectAnswer),
      forget: done,
    },
    pair: {
      start: () => Promise.resolve({ appPair: null, problem: null, probe: { answers: false, hub: "http://devbox:4790" } }),
      probe: (hub: string) => Promise.resolve({ answers: false, hub }),
      redeem: () => Promise.resolve({ ok: false, failure: { code: "", message: notHere.message } }),
      auto: () => Promise.resolve({ ok: false, failure: { code: "", message: notHere.message } }),
      store: () => Promise.resolve({ kind: "os", where: "the OS keychain" }),
      setup: () => Promise.resolve({ ok: false, message: "Run this in a terminal:", command: "fleetd init" }),
    } as unknown as FleetdApi["pair"],
    system: { hostName: () => Promise.resolve("devbox") },
    machines: {
      joinHere: () => Promise.resolve({ phase: "failed", message: notHere.message }),
      thisComputer: () => Promise.resolve({ kind: "none" }),
      joinHereState: () => Promise.resolve(null),
      onJoinHere: () => () => undefined,
    } as unknown as FleetdApi["machines"],
    projects: { pickFolder: () => Promise.resolve(null), readDrop: () => Promise.resolve({ kind: "other" }) },
    updates: { state: () => Promise.resolve(updates), subscribe: () => () => undefined, check: done, install: done, keep: done },
    app: {
      onMenuCommand: () => () => undefined,
      onOpen: () => () => undefined,
      notify: () => Promise.resolve(false),
      setBadge: done,
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
if (answer.ok) {
  const file = (await answer.json()) as FixtureFile;
  runClockFrom(file.now);
  Object.defineProperty(window, "fleetd", { value: fleetdApi(file) });
  const entry = "/src/main.tsx";
  await import(/* @vite-ignore */ entry);
  picker(names, name);
} else {
  const root = document.getElementById("root");
  if (root !== null) root.textContent = await answer.text();
}
