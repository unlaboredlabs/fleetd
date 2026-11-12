import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubFrame } from "../../shared/hub";
import { DEFLATE_UP_BYTES, HubClient, MAX_FRAME_BYTES, PING_EVERY_MS, PONG_WAIT_MS, READY_TIMEOUT_MS, RESUME_MAX_EVENTS, STABLE_MS } from "./client";
import type { ConnectionEvents, Transport } from "./transport";

/** A hub on the other end of a fake transport: records what the client sends, lets the test answer. */
class FakeHub {
  readonly urls: Array<string> = [];
  readonly headers: Array<Readonly<Record<string, string>> | undefined> = [];
  sent: Array<Record<string, unknown>> = [];
  /** The tools of the frames sent compressed. */
  compressed: Array<unknown> = [];
  events: ConnectionEvents | null = null;
  closedByClient = 0;
  pings = 0;

  readonly transport: Transport = (url, events, headers) => {
    this.urls.push(url);
    this.headers.push(headers);
    this.events = events;
    this.sent = [];
    return {
      send: (text, compress) => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        this.sent.push(frame);
        if (compress === true) this.compressed.push(frame["tool"]);
      },
      ping: () => {
        this.pings++;
      },
      close: () => {
        this.closedByClient++;
      },
    };
  };

  open(): void {
    this.events?.onOpen();
  }

  pong(): void {
    this.events?.onHeard();
  }

  frame(frame: Record<string, unknown>): void {
    this.events?.onText(JSON.stringify(frame));
  }

  close(code: number, reason = ""): void {
    this.events?.onClose(code, reason);
  }

  /** Opens, accepts the key and answers the snapshot with `cursor`. */
  ready(cursor = 10): void {
    this.open();
    this.frame({ t: "ready", protocol: 1 });
    this.frame({ t: "snapshot", cursor, machines: [] });
  }
}

/** What every connection opens with: the auth, its opt-ins, and what every hub reads after it. */
const AUTH = { t: "auth", key: "k1", features: ["deflate"] };

const setup = () => {
  const hub = new FakeHub();
  const frames: Array<HubFrame> = [];
  // No jitter, so delays read exactly.
  const client = new HubClient({ hub: "http://devbox:4790", key: "k1", transport: hub.transport, emit: (f) => frames.push(f), random: () => 0.5 });
  const states = () => frames.flatMap((f) => (f.t === "state" ? [f.state.phase] : []));
  return { hub, frames, client, states };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("HubClient", () => {
  it("authenticates, snapshots, then streams events from the snapshot's cursor", () => {
    const { hub, frames, client, states } = setup();
    client.start();
    expect(hub.urls).toEqual(["ws://devbox:4790/app"]);
    // The auth rides the upgrade too, for a hub that answers it a round trip sooner.
    expect(hub.headers).toEqual([{ authorization: "Bearer k1", "x-fleetd-features": "deflate" }]);
    hub.open();
    // The snapshot and the live feed go with the auth, not a round trip after ready.
    expect(hub.sent).toEqual([AUTH, { t: "snapshot" }, { t: "live", board: true }]);
    hub.frame({ t: "ready", protocol: 1 });
    expect(hub.sent).toHaveLength(3);
    hub.frame({ t: "snapshot", cursor: 41, machines: [] });
    expect(hub.sent.at(-1)).toEqual({ t: "events", cursor: 41 });
    hub.frame({ t: "event", seq: 42, type: "task.started" });
    expect(states()).toEqual(["connecting", "live"]);
    expect(frames.filter((f) => f.t !== "state")).toEqual([
      { t: "snapshot", snapshot: { cursor: 41, machines: [] } },
      { t: "event", event: { seq: 42, type: "task.started" } },
    ]);
  });

  it("sends an upload's piece compressed, only to a hub whose ready said it reads them", () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    const piece = { dataB64: "QUJD".repeat(DEFLATE_UP_BYTES) };
    void client.call({ tool: "attachment_part", input: piece });
    void client.call({ tool: "hub_info", input: {} });
    expect(hub.compressed).toEqual([]);
    const reads = setup();
    reads.client.start();
    reads.hub.open();
    reads.hub.frame({ t: "ready", protocol: 1, features: ["deflate"] });
    void reads.client.call({ tool: "attachment_part", input: piece });
    void reads.client.call({ tool: "hub_info", input: {} });
    expect(reads.hub.compressed).toEqual(["attachment_part"]);
  });

  it("resumes a reconnect after the last event the old link applied, when it missed few enough", () => {
    const { hub, frames, client } = setup();
    const snapshots = () => frames.flatMap((f) => (f.t === "snapshot" ? [f] : []));
    client.start();
    hub.ready(10);
    hub.frame({ t: "event", seq: 11, type: "x" });
    hub.close(1006);
    // A dial that fails before its snapshot keeps the point to resume from.
    vi.advanceTimersByTime(500);
    hub.open();
    hub.close(1006);
    vi.advanceTimersByTime(1000);
    hub.ready(15);
    expect(hub.sent.at(-1)).toEqual({ t: "events", cursor: 11 });
    expect(snapshots().at(-1)).toEqual({ t: "snapshot", snapshot: { cursor: 15, machines: [] }, resumed: true });
    // The missed events come through; a resync on the same link is a plain snapshot again.
    hub.frame({ t: "event", seq: 12, type: "x" });
    expect(frames.at(-1)).toEqual({ t: "event", event: { seq: 12, type: "x" } });
    client.resync();
    hub.frame({ t: "snapshot", cursor: 16, machines: [] });
    expect(snapshots().at(-1)).toEqual({ t: "snapshot", snapshot: { cursor: 16, machines: [] } });
    expect(hub.sent.at(-1)).toEqual({ t: "events", cursor: 16 });
  });

  it("reads everything again after a reconnect that missed too many events, or whose hub went back", () => {
    const { hub, frames, client } = setup();
    const last = () => frames.filter((f) => f.t === "snapshot").at(-1);
    client.start();
    hub.ready(10);
    hub.close(1006);
    vi.advanceTimersByTime(500);
    hub.ready(11 + RESUME_MAX_EVENTS);
    expect(last()).toEqual({ t: "snapshot", snapshot: { cursor: 11 + RESUME_MAX_EVENTS, machines: [] } });
    expect(hub.sent.at(-1)).toEqual({ t: "events", cursor: 11 + RESUME_MAX_EVENTS });
    hub.close(1006);
    vi.advanceTimersByTime(1000);
    // A hub whose log is behind the app's cursor (a restored database): nothing to resume from.
    hub.ready(5);
    expect(last()).toEqual({ t: "snapshot", snapshot: { cursor: 5, machines: [] } });
  });

  it("counts the hub's own pings as hearing from it", () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(PING_EVERY_MS);
      hub.pong();
    }
    expect(client.state.phase).toBe("live");
  });

  it("says the hub's version from each ready frame, so a restarted hub's new version shows", () => {
    const { hub, frames, client } = setup();
    const lives = () => frames.flatMap((f) => (f.t === "state" && f.state.phase === "live" ? [f.state] : []));
    client.start();
    hub.open();
    hub.frame({ t: "ready", protocol: 1, version: "0.0.0-edge.202610221107+333368c" });
    expect(lives().at(-1)).toEqual({ phase: "live", hub: "http://devbox:4790", protocol: 1, version: "0.0.0-edge.202610221107+333368c" });
    hub.close(1012);
    vi.advanceTimersByTime(60_000);
    hub.open();
    hub.frame({ t: "ready", protocol: 1 });
    expect(lives().at(-1)).toEqual({ phase: "live", hub: "http://devbox:4790", protocol: 1 });
  });

  it("drops events it already applied", () => {
    const { hub, frames, client } = setup();
    client.start();
    hub.ready(10);
    for (const seq of [11, 12, 12, 9, 13]) hub.frame({ t: "event", seq, type: "x" });
    expect(frames.flatMap((f) => (f.t === "event" ? [f.event.seq] : []))).toEqual([11, 12, 13]);
  });

  it("resumes the stream after the last event when the hub ends it with an error", () => {
    const { hub, frames, client } = setup();
    client.start();
    hub.ready(10);
    hub.frame({ t: "event", seq: 11, type: "x" });
    hub.frame({ t: "error", code: "internal", message: "events_wait failed" });
    expect(frames.at(-1)).toEqual({ t: "error", error: { code: "internal", message: "events_wait failed", fix: undefined } });
    vi.advanceTimersByTime(500);
    expect(hub.sent.at(-1)).toEqual({ t: "events", cursor: 11 });
  });

  it("answers calls by id, and times out the ones the hub never answers", async () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    const ok = client.call({ tool: "fleetd_status", input: {} });
    const refused = client.call({ tool: "task_cancel", input: { taskId: "t1" } });
    const slow = client.call({ tool: "events_wait", input: {}, timeoutMs: 1000 });
    const calls = hub.sent.filter((m) => m["t"] === "call");
    expect(calls.map((c) => c["id"])).toEqual(["c1", "c2", "c3"]);
    hub.frame({ t: "result", id: "c1", output: { cursor: 3 } });
    hub.frame({ t: "error", id: "c2", code: "forbidden", message: "This key lacks the operate role.", fix: "Use an operator key.", reason: "no_project" });
    await expect(ok).resolves.toEqual({ ok: true, output: { cursor: 3 } });
    // Which refusal it is goes through with it, for a screen that acts on one.
    await expect(refused).resolves.toMatchObject({ ok: false, error: { code: "forbidden", fix: "Use an operator key.", reason: "no_project" } });
    vi.advanceTimersByTime(1000);
    await expect(slow).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });
    // A late answer to a timed-out call is ignored.
    hub.frame({ t: "result", id: "c3", output: {} });
  });

  it("fails calls at once while offline, and fails in-flight calls when the link drops", async () => {
    const { hub, client } = setup();
    await expect(client.call({ tool: "x", input: {} })).resolves.toMatchObject({ ok: false, error: { code: "offline" } });
    client.start();
    hub.ready();
    const inFlight = client.call({ tool: "x", input: {} });
    hub.close(1006);
    await expect(inFlight).resolves.toMatchObject({ ok: false, error: { code: "disconnected" } });
  });

  it("reconnects with backoff, and resyncs on every new connection", () => {
    const { hub, client, states } = setup();
    client.start();
    hub.close(1006);
    expect(client.state).toMatchObject({ phase: "retrying", retryAt: Date.now() + 500 });
    vi.advanceTimersByTime(499);
    expect(hub.urls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(hub.urls).toHaveLength(2);
    hub.close(1006);
    expect(client.state).toMatchObject({ phase: "retrying", retryAt: Date.now() + 1000 });
    vi.advanceTimersByTime(1000);
    hub.open();
    hub.frame({ t: "ready", protocol: 1 });
    expect(hub.sent).toEqual([AUTH, { t: "snapshot" }, { t: "live", board: true }]);
    expect(states()).toEqual(["connecting", "retrying", "connecting", "retrying", "connecting", "live"]);
  });

  it("redials every 250 ms for a minute after the hub closes to restart, saying since when, then backs off", () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    const at = Date.now();
    hub.close(1012);
    expect(client.state).toMatchObject({ phase: "retrying", retryAt: at + 250, restarting: at });
    // Down a while: each refused dial is tried again 250 ms later, still restarting since the close.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(250);
      expect(client.state).toMatchObject({ phase: "connecting", attempt: 0, restarting: at });
      hub.close(1006);
      expect(client.state).toMatchObject({ phase: "retrying", retryAt: Date.now() + 250, restarting: at });
    }
    vi.advanceTimersByTime(60_000 - (Date.now() - at));
    hub.close(1006);
    expect(client.state).toMatchObject({ phase: "retrying", retryAt: Date.now() + 500, restarting: at });
    vi.advanceTimersByTime(500);
    hub.ready();
    expect(client.state).toMatchObject({ phase: "live" });
    // Back: the next drop that isn't a restart backs off as ever, and says nothing of one.
    hub.close(1006);
    expect(client.state).toMatchObject({ phase: "retrying", retryAt: Date.now() + 1000 });
    expect(client.state).not.toHaveProperty("restarting");
  });

  it("takes a hub's going-away close as a restart too, saying the build only when it updates, but not a close before the link opened", () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    hub.close(1001, "hub restarting");
    expect(client.state).toMatchObject({ phase: "retrying", retryAt: Date.now() + 250, restarting: Date.now() });
    expect(client.state).not.toHaveProperty("updatingTo");
    vi.advanceTimersByTime(250);
    hub.ready();
    hub.close(1001, "updating to 0.0.0-edge.202611082014+90e7a07");
    expect(client.state).toMatchObject({ phase: "retrying", restarting: Date.now(), updatingTo: "0.0.0-edge.202611082014+90e7a07" });
    client.stop();
    client.start();
    hub.close(1012);
    expect(client.state).toMatchObject({ phase: "retrying", retryAt: Date.now() + 500 });
    expect(client.state).not.toHaveProperty("restarting");
  });

  it("keeps backing off from a hub that accepts the key and then drops, and starts over after a stable link", () => {
    const { hub, client } = setup();
    client.start();
    const delays: Array<number> = [];
    for (let i = 0; i < 7; i++) {
      hub.ready();
      hub.close(1006);
      const state = client.state;
      if (state.phase !== "retrying") throw new Error(state.phase);
      delays.push(state.retryAt - Date.now());
      vi.advanceTimersByTime(state.retryAt - Date.now());
    }
    // Capped at 10 s, so a link back after a long outage is found again within that.
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
    hub.ready();
    for (let t = 0; t < STABLE_MS; t += PING_EVERY_MS) {
      vi.advanceTimersByTime(PING_EVERY_MS);
      hub.pong();
    }
    hub.close(1006);
    expect(client.state).toMatchObject({ phase: "retrying", retryAt: Date.now() + 500 });
  });

  it("pings the link and gives it up when nothing at all answers a ping", () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(hub.pings).toBe(1);
    // Anything heard in time keeps it: bytes of a long frame still arriving count as much as the pong.
    vi.advanceTimersByTime(PONG_WAIT_MS - 1);
    hub.pong();
    vi.advanceTimersByTime(PING_EVERY_MS - PONG_WAIT_MS + 1);
    expect(client.state.phase).toBe("live");
    expect(hub.pings).toBe(2);
    vi.advanceTimersByTime(PONG_WAIT_MS - 1);
    expect(client.state.phase).toBe("live");
    // Nothing since the second ping: given up then, not a silence's 30 s later.
    vi.advanceTimersByTime(1);
    expect(client.state).toMatchObject({ phase: "retrying", reason: expect.stringContaining("stopped answering") as string });
    expect(hub.closedByClient).toBe(1);
    vi.advanceTimersByTime(500);
    expect(hub.urls).toHaveLength(2);
  });

  it("gives up a connection that never gets ready", () => {
    const { hub, client } = setup();
    client.start();
    hub.open();
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    expect(client.state).toMatchObject({ phase: "retrying", reason: expect.stringContaining("never finished") as string });
    expect(hub.closedByClient).toBe(1);
    vi.advanceTimersByTime(500);
    expect(hub.urls).toHaveLength(2);
  });

  it("refuses a call frame over the size cap without sending it", async () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    const before = hub.sent.length;
    await expect(client.call({ tool: "x", input: "y".repeat(MAX_FRAME_BYTES) })).resolves.toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(hub.sent).toHaveLength(before);
  });

  it("stops for good when the hub closes with 4401", () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    hub.close(4401, "unauthorized");
    expect(client.state).toEqual({ phase: "refused", hub: "http://devbox:4790", message: "The hub refused the key (unauthorized)." });
    vi.advanceTimersByTime(60_000);
    expect(hub.urls).toHaveLength(1);
  });

  it("treats an error before ready as a refused key", () => {
    const { hub, client } = setup();
    client.start();
    hub.open();
    hub.frame({ t: "error", code: "forbidden", message: "Unknown agent key." });
    expect(client.state).toMatchObject({ phase: "refused", message: "Unknown agent key." });
    expect(hub.closedByClient).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(hub.urls).toHaveLength(1);
  });

  it("subscribes to live on every ready, keeps the focus across reconnects and re-sends it on window focus", () => {
    const { hub, client } = setup();
    client.start();
    client.focus("ws-1");
    hub.ready();
    expect(hub.sent).toContainEqual({ t: "live", board: true, focus: "ws-1" });
    hub.sent = [];
    client.refreshLive();
    expect(hub.sent).toEqual([{ t: "live", board: true, focus: "ws-1" }]);
    client.focus(null);
    expect(hub.sent.at(-1)).toEqual({ t: "live", board: true });
    hub.close(1006);
    vi.advanceTimersByTime(500);
    hub.open();
    hub.frame({ t: "ready", protocol: 1 });
    expect(hub.sent).toEqual([AUTH, { t: "snapshot" }, { t: "live", board: true }]);
  });

  it("stops the live feed while no window shows, and asks for it again, focus kept, once one does", () => {
    const { hub, client } = setup();
    client.start();
    client.focus("ws-1");
    hub.ready();
    hub.sent = [];
    client.shown(false);
    expect(hub.sent).toEqual([{ t: "live", board: false }]);
    // Hidden, nothing asks for it: not a window's own refresh, a new focus, nor a reconnect (its new socket hears no live).
    client.refreshLive();
    client.focus("ws-2");
    client.shown(false);
    hub.close(1006);
    vi.advanceTimersByTime(500);
    hub.open();
    hub.frame({ t: "ready", protocol: 1 });
    expect(hub.sent.filter((m) => m["t"] === "live")).toEqual([]);
    hub.sent = [];
    client.shown(true);
    expect(hub.sent).toEqual([{ t: "live", board: true, focus: "ws-2" }]);
    client.shown(true);
    expect(hub.sent).toHaveLength(1);
  });

  it("keeps the chat subscription across reconnects and forwards its deltas", () => {
    const { hub, frames, client } = setup();
    const project = { machineId: "devbox", projectId: "storefront" };
    client.start();
    client.chat(project);
    hub.ready();
    expect(hub.sent).toContainEqual({ t: "chat", project });
    const delta = { projectRef: project, messageId: "m3", seq: 3, offset: 0, append: "On it" };
    hub.frame({ t: "chat_delta", ...delta });
    expect(frames.at(-1)).toEqual({ t: "chat_delta", delta });
    hub.close(1006);
    vi.advanceTimersByTime(500);
    hub.open();
    hub.frame({ t: "ready", protocol: 1 });
    expect(hub.sent).toEqual([AUTH, { t: "snapshot" }, { t: "live", board: true }, { t: "chat", project }]);
    client.chat(null);
    expect(hub.sent.at(-1)).toEqual({ t: "chat" });
  });

  it("sends presence only on a live link to a hub that reads it, as the three facts and nothing else", () => {
    const { hub, client } = setup();
    const project = { machineId: "devbox", projectId: "storefront" };
    const presences = () => hub.sent.filter((m) => m["t"] === "presence");
    client.start();
    // Not ready yet: dropped, never sent late.
    client.presence({ focused: true, input: true, project });
    hub.open();
    expect(hub.sent.filter((m) => m["t"] === "presence")).toEqual([]);
    // A hub that names no features is never sent presence.
    hub.frame({ t: "ready", protocol: 1 });
    client.presence({ focused: true, input: true, project });
    expect(presences()).toEqual([]);
    hub.close(1006);
    vi.advanceTimersByTime(500);
    hub.open();
    hub.frame({ t: "ready", protocol: 1, features: ["presence"] });
    client.presence({ focused: true, input: true, project });
    expect(hub.sent.at(-1)).toEqual({ t: "presence", id: "p1", focused: true, input: true, project });
    expect(presences()).toHaveLength(1);
    hub.close(1006);
    client.presence({ focused: true, input: false });
    expect(presences()).toHaveLength(1);
  });

  it("watches a browser session and sends input only to a hub that serves sessions, again on each connection", () => {
    const { hub, frames, client } = setup();
    const session = "B68722f97b065412024c7cda6c636fd9a";
    const browser = () => hub.sent.filter((m) => m["t"] === "browser_watch" || m["t"] === "browser_input");
    const input = { kind: "text", text: "482913" } as const;
    client.watch(session);
    client.start();
    hub.open();
    // A hub that doesn't name browser_sessions is sent neither.
    hub.frame({ t: "ready", protocol: 1, features: ["presence"] });
    client.input(session, input);
    expect(browser()).toEqual([]);
    hub.close(1006);
    vi.advanceTimersByTime(500);
    hub.open();
    hub.frame({ t: "ready", protocol: 1, features: ["presence", "browser_sessions"] });
    expect(browser()).toEqual([{ t: "browser_watch", session }]);
    client.input(session, input);
    expect(hub.sent.at(-1)).toEqual({ t: "browser_input", session, input });
    // Its frames come through; another session's, still on its way after a change, don't.
    const frame = { sessionId: session, seq: 1, jpegB64: "AA==", width: 1280, height: 800, control: "human" };
    hub.frame({ t: "browser_frame", ...frame });
    hub.frame({ t: "browser_frame", ...frame, sessionId: "B9a63189230ff64d06936e60523503180" });
    expect(frames.filter((f) => f.t === "browser_frame")).toEqual([{ t: "browser_frame", frame }]);
    // No session: it stops watching.
    client.watch(null);
    expect(hub.sent.at(-1)).toEqual({ t: "browser_watch" });
  });

  it("acks each frame of the watched session to a hub that paces them, and none to one that doesn't", () => {
    const { hub, frames, client } = setup();
    const session = "B68722f97b065412024c7cda6c636fd9a";
    const sent = () => hub.sent.filter((m) => m["t"] === "browser_watch" || m["t"] === "browser_frame_ack");
    const frame = { sessionId: session, seq: 7, jpegB64: "AA==", width: 1280, height: 800, control: "agent" };
    client.watch(session);
    client.start();
    hub.open();
    // An older hub: a plain watch, and its frames aren't acked.
    hub.frame({ t: "ready", protocol: 1, features: ["browser_sessions"] });
    hub.frame({ t: "browser_frame", ...frame });
    expect(sent()).toEqual([{ t: "browser_watch", session }]);
    hub.close(1006);
    vi.advanceTimersByTime(500);
    hub.open();
    hub.frame({ t: "ready", protocol: 1, features: ["browser_sessions", "frame_acks"] });
    hub.frame({ t: "browser_frame", ...frame, seq: 8 });
    // Another session's, on its way after a change: shown nowhere, acked never.
    hub.frame({ t: "browser_frame", ...frame, seq: 9, sessionId: "B9a63189230ff64d06936e60523503180" });
    expect(sent()).toEqual([{ t: "browser_watch", session, acks: true }, { t: "browser_frame_ack", seq: 8 }]);
    expect(frames.filter((f) => f.t === "browser_frame")).toHaveLength(2);
  });

  it("asks for the Screens page's pictures only from a hub that sends them, again on each connection, and drops them once off", () => {
    const { hub, frames, client } = setup();
    const asks = () => hub.sent.filter((m) => m["t"] === "screen_thumbs");
    const thumb = { sessionId: "B68722f97b065412024c7cda6c636fd9a", jpegB64: "AA==", width: 640, height: 400, at: "2026-10-19T10:00:00.000Z" };
    client.thumbs(true);
    client.start();
    hub.open();
    hub.frame({ t: "ready", protocol: 1, features: ["browser_sessions"] });
    expect(asks()).toEqual([]);
    hub.close(1006);
    vi.advanceTimersByTime(500);
    hub.open();
    hub.frame({ t: "ready", protocol: 1, features: ["browser_sessions", "screen_thumbs"] });
    expect(asks()).toEqual([{ t: "screen_thumbs", on: true }]);
    hub.frame({ t: "screen_thumb", ...thumb });
    expect(frames.filter((f) => f.t === "screen_thumb")).toEqual([{ t: "screen_thumb", thumb }]);
    // The page left: off, and a picture still on its way is dropped.
    client.thumbs(false);
    expect(hub.sent.at(-1)).toEqual({ t: "screen_thumbs", on: false });
    hub.frame({ t: "screen_thumb", ...thumb });
    expect(frames.filter((f) => f.t === "screen_thumb")).toHaveLength(1);
    // Not asked again on the next connection.
    hub.close(1006);
    vi.advanceTimersByTime(500);
    hub.open();
    hub.frame({ t: "ready", protocol: 1, features: ["browser_sessions", "screen_thumbs"] });
    expect(asks()).toHaveLength(2);
  });

  it("stops presence when the hub can't read a presence frame, without an error or a restarted stream, until the next connection", () => {
    const { hub, frames, client, states } = setup();
    const presences = () => hub.sent.filter((m) => m["t"] === "presence");
    client.start();
    hub.open();
    hub.frame({ t: "ready", protocol: 1, features: ["presence"] });
    hub.frame({ t: "snapshot", cursor: 10, machines: [] });
    hub.frame({ t: "event", seq: 11, type: "x" });
    client.presence({ focused: true, input: true });
    const sentBefore = hub.sent.length;
    const framesBefore = frames.length;
    // The refusal names the presence frame's id.
    hub.frame({ t: "error", id: "p1", code: "invalid", message: "Unknown or malformed message.", fix: "Send {t:auth|snapshot|events}." });
    // Minutes later: no more presence, no `events` resent, nothing shown, the same connection.
    for (let minute = 0; minute < 5; minute++) {
      for (let ping = 0; ping < 4; ping++) {
        vi.advanceTimersByTime(PING_EVERY_MS);
        hub.pong();
      }
      client.presence({ focused: true, input: true });
    }
    expect(presences()).toHaveLength(1);
    expect(hub.sent.slice(sentBefore).filter((m) => m["t"] !== "presence")).toEqual([]);
    expect(hub.closedByClient).toBe(0);
    expect(frames.slice(framesBefore)).toEqual([]);
    expect(hub.urls).toHaveLength(1);
    expect(states().at(-1)).toBe("live");
    // Any other session error still resumes the stream.
    hub.frame({ t: "error", code: "failed", message: "The hub failed to answer that request." });
    vi.advanceTimersByTime(500);
    expect(hub.sent.at(-1)).toEqual({ t: "events", cursor: 11 });
    // A new connection asks again by what its `ready` says.
    hub.close(1006);
    vi.advanceTimersByTime(500);
    hub.open();
    hub.frame({ t: "ready", protocol: 1, features: ["presence"] });
    client.presence({ focused: true, input: true });
    // (The fake hub's record starts over with each connection.)
    expect(presences()).toEqual([{ t: "presence", id: "p2", focused: true, input: true }]);
  });

  it("handles any other malformed-message error as before: the stream resumes and presence stays on", () => {
    const { hub, frames, client } = setup();
    const presences = () => hub.sent.filter((m) => m["t"] === "presence");
    client.start();
    hub.open();
    hub.frame({ t: "ready", protocol: 1, features: ["presence"] });
    hub.frame({ t: "snapshot", cursor: 10, machines: [] });
    hub.frame({ t: "event", seq: 11, type: "x" });
    client.presence({ focused: true, input: true });
    // An error about something else, with no id, right after a presence frame.
    const error = { code: "invalid", message: "Unknown or malformed message.", fix: "Send {t:auth|snapshot|events}." };
    hub.frame({ t: "error", ...error });
    expect(frames.at(-1)).toEqual({ t: "error", error });
    vi.advanceTimersByTime(500);
    expect(hub.sent.at(-1)).toEqual({ t: "events", cursor: 11 });
    client.presence({ focused: true, input: false });
    expect(presences()).toEqual([
      { t: "presence", id: "p1", focused: true, input: true },
      { t: "presence", id: "p2", focused: true, input: false },
    ]);
    // A call's error, by its own id, settles the call and leaves presence on too.
    void client.call({ tool: "x", input: {} });
    hub.frame({ t: "error", id: "c1", ...error });
    client.presence({ focused: true, input: true });
    expect(presences()).toHaveLength(3);
  });

  it("forwards live frames without their tag", () => {
    const { hub, frames, client } = setup();
    client.start();
    hub.ready();
    hub.frame({ t: "live", full: true, at: "2026-10-19T00:00:00Z", lanes: [] });
    expect(frames.at(-1)).toEqual({ t: "live", frame: { full: true, at: "2026-10-19T00:00:00Z", lanes: [] } });
  });

  it("dials again at once after the machine wakes, failing what was in flight", async () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    const inFlight = client.call({ tool: "x", input: {} });
    client.reconnectNow();
    await expect(inFlight).resolves.toMatchObject({ ok: false, error: { code: "disconnected" } });
    expect(hub.urls).toHaveLength(2);
    expect(client.state.phase).toBe("connecting");
  });
});
