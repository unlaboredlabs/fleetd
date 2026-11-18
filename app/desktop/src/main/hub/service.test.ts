import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubCacheFile } from "./cache";
import { HELD_EVENTS_MAX, HubService } from "./service";
import type { CredentialEnv } from "./credentials";
import type { FixtureFile } from "./fixture";
import type { ConnectionEvents, Transport } from "./transport";

const dirs: string[] = [];
const cacheFile = (): { file: string; cache: HubCacheFile } => {
  const dir = mkdtempSync(join(tmpdir(), "fleetd-cache-"));
  dirs.push(dir);
  const file = join(dir, "hub-cache.json");
  return { file, cache: new HubCacheFile(file) };
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const noSocket: Transport = () => ({ send: () => undefined, ping: () => undefined, close: () => undefined });
const cacheText = (hub: string) => JSON.stringify({ version: 1, hub, asOf: "2026-10-19T09:02:00.000Z", projects: [], chatStates: [], chats: [], sends: {} });

describe("hub service", () => {
  it("keeps the offline cache for the paired hub only, and Forget deletes it", () => {
    const { file, cache } = cacheFile();
    const vars = { FLEETD_HUB_URL: "http://devbox:4790", FLEETD_AGENT_KEY: "k1" };
    const service = new HubService({ kind: "hub", id: "hub", credentials: {} as CredentialEnv, loaded: { saved: { url: vars.FLEETD_HUB_URL, key: vars.FLEETD_AGENT_KEY } }, ephemeral: true, transport: noSocket, cache });
    // Another hub's cache is neither kept nor handed back.
    service.cacheWrite(cacheText("http://other:4790"));
    expect(service.cacheRead()).toBeNull();
    service.cacheWrite("not json");
    expect(service.cacheRead()).toBeNull();
    service.cacheWrite(cacheText("http://devbox:4790"));
    expect(service.cacheRead()).toBe(cacheText("http://devbox:4790"));
    service.forget();
    expect(existsSync(file)).toBe(false);
    expect(service.cacheRead()).toBeNull();
    service.stop();
  });

  it("dials only once started, and a pairing made after that at once", () => {
    const urls: string[] = [];
    const transport: Transport = (url) => {
      urls.push(url);
      return { send: () => undefined, ping: () => undefined, close: () => undefined };
    };
    const saved = { url: "http://devbox:4790", key: "k1" };
    const service = new HubService({ kind: "hub", id: "hub", credentials: {} as CredentialEnv, loaded: { saved }, ephemeral: true, transport, cache: cacheFile().cache });
    // The window is on its way: the saved hub isn't dialled yet, and says it is connecting meanwhile.
    expect(urls).toEqual([]);
    expect(service.state()).toMatchObject({ phase: "connecting", hub: "http://devbox:4790" });
    service.start();
    service.start();
    expect(urls).toEqual(["ws://devbox:4790/app"]);
    expect(service.connect({ url: "http://other:4790", key: "k2" })).toEqual({ ok: true });
    expect(urls).toEqual(["ws://devbox:4790/app", "ws://other:4790/app"]);
    service.stop();
  });

  it("keeps the focus across a forget and a new pairing", () => {
    const sent: Record<string, unknown>[] = [];
    let events: ConnectionEvents | null = null;
    const transport: Transport = (_url, e) => {
      events = e;
      return { send: (text) => sent.push(JSON.parse(text) as Record<string, unknown>), ping: () => undefined, close: () => undefined };
    };
    // Scripted credentials: nothing is read from or written to a store, so `credentials` is never used.
    const vars = { FLEETD_HUB_URL: "http://devbox:4790", FLEETD_AGENT_KEY: "k1" };
    const service = new HubService({ kind: "hub", id: "hub", credentials: {} as CredentialEnv, loaded: { saved: { url: vars.FLEETD_HUB_URL, key: vars.FLEETD_AGENT_KEY } }, ephemeral: true, transport, cache: cacheFile().cache });
    service.start();
    service.focus("ws-1");
    service.forget();
    expect(service.connect({ url: "http://devbox:4790", key: "k2" })).toEqual({ ok: true });
    const hub = events as ConnectionEvents | null;
    hub?.onOpen();
    hub?.onText(JSON.stringify({ t: "ready", protocol: 1 }));
    expect(sent.filter((m) => m["t"] === "live")).toEqual([{ t: "live", board: true, focus: "ws-1" }]);
    service.stop();
  });

  it("starts a window that subscribes after the hub answered from what main holds, not a round trip", () => {
    const sent: Record<string, unknown>[] = [];
    let events: ConnectionEvents | null = null;
    const transport: Transport = (_url, e) => {
      events = e;
      return { send: (text) => sent.push(JSON.parse(text) as Record<string, unknown>), ping: () => undefined, close: () => undefined };
    };
    const service = new HubService({ kind: "hub", id: "hub", credentials: {} as CredentialEnv, loaded: { saved: { url: "http://devbox:4790", key: "k1" } }, ephemeral: true, transport, cache: cacheFile().cache });
    const frames: { t: string; seq?: number }[] = [];
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: (_channel: string, _hub: string, frame: { t: string; event?: { seq: number } }) => frames.push(frame.event === undefined ? { t: frame.t } : { t: frame.t, seq: frame.event.seq }),
    }) as unknown as WebContents;
    const snapshots = () => sent.filter((m) => m["t"] === "snapshot").length;
    // Dialled as the window opens; the hub answers while its page still loads.
    service.start();
    const hub = events as ConnectionEvents | null;
    hub?.onOpen();
    hub?.onText(JSON.stringify({ t: "ready", protocol: 1 }));
    hub?.onText(JSON.stringify({ t: "snapshot", cursor: 10, machines: [] }));
    hub?.onText(JSON.stringify({ t: "event", seq: 11, type: "task.started" }));
    expect(snapshots()).toBe(1);
    // The page subscribes: the state, the held snapshot and the event since, at once; no second snapshot is asked for.
    service.subscribe(window);
    expect(frames).toEqual([{ t: "state" }, { t: "snapshot" }, { t: "event", seq: 11 }]);
    expect(snapshots()).toBe(1);
    // What comes after reaches it as it comes.
    hub?.onText(JSON.stringify({ t: "event", seq: 12, type: "task.started" }));
    expect(frames.at(-1)).toEqual({ t: "event", seq: 12 });
    // Too much since the snapshot to be worth playing back: a window subscribing now asks for a fresh one.
    for (let seq = 13; seq <= 13 + HELD_EVENTS_MAX; seq++) hub?.onText(JSON.stringify({ t: "event", seq, type: "task.started" }));
    frames.length = 0;
    service.subscribe(window);
    expect(frames).toEqual([{ t: "state" }]);
    expect(snapshots()).toBe(2);
    // Its answer is held again for the next; a dropped link holds nothing.
    hub?.onText(JSON.stringify({ t: "snapshot", cursor: 300, machines: [] }));
    frames.length = 0;
    service.subscribe(window);
    expect(frames).toEqual([{ t: "state" }, { t: "snapshot" }]);
    hub?.onClose(1006, "");
    frames.length = 0;
    service.subscribe(window);
    expect(frames).toEqual([{ t: "state" }]);
    service.stop();
  });

  it("sends a reloaded window nothing from its page before until the new page subscribes", () => {
    vi.useFakeTimers();
    const fixture: FixtureFile = {
      version: 1,
      name: "back",
      note: "",
      now: "2026-10-19T10:30:00.000Z",
      state: { phase: "live", hub: "http://devbox:4790", protocol: 1 },
      frames: [{ t: "snapshot", snapshot: { cursor: 1 }, afterMs: 1200 }],
      calls: [],
    };
    const service = new HubService({ kind: "fixture", id: "hub", fixture });
    const sent: string[] = [];
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_channel: string, _hub: string, frame: { t: string }) => sent.push(frame.t) });
    const window = contents as unknown as WebContents;
    service.subscribe(window);
    expect(sent).toEqual(["state"]);
    // Reloaded, and the new page still reading its cache when the first page's snapshot is due.
    vi.advanceTimersByTime(1000);
    contents.emit("did-navigate");
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(["state"]);
    // Its own subscribe plays the fixture from the start.
    service.subscribe(window);
    vi.advanceTimersByTime(1199);
    expect(sent).toEqual(["state", "state"]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["state", "state", "snapshot"]);
    expect(contents.listenerCount("destroyed") + contents.listenerCount("did-navigate")).toBe(2);
    service.stop();
    vi.useRealTimers();
  });
});
