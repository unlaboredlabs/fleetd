import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubFrame } from "../../shared/hub";
import { HubClient, MAX_FRAME_BYTES, PING_EVERY_MS, READY_TIMEOUT_MS, STABLE_MS } from "./client";
import type { ConnectionEvents, Transport } from "./transport";

/** A hub on the other end of a fake transport: records what the client sends, lets the test answer. */
class FakeHub {
  readonly urls: Array<string> = [];
  sent: Array<Record<string, unknown>> = [];
  events: ConnectionEvents | null = null;
  closedByClient = 0;
  pings = 0;

  readonly transport: Transport = (url, events) => {
    this.urls.push(url);
    this.events = events;
    this.sent = [];
    return {
      send: (text) => this.sent.push(JSON.parse(text) as Record<string, unknown>),
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
    this.events?.onPong();
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
    hub.open();
    expect(hub.sent).toEqual([{ t: "auth", key: "k1" }]);
    hub.frame({ t: "ready", protocol: 1 });
    expect(hub.sent.slice(1)).toEqual([{ t: "snapshot" }, { t: "live", board: true }]);
    hub.frame({ t: "snapshot", cursor: 41, machines: [] });
    expect(hub.sent.at(-1)).toEqual({ t: "events", cursor: 41 });
    hub.frame({ t: "event", seq: 42, type: "task.started" });
    expect(states()).toEqual(["connecting", "live"]);
    expect(frames.filter((f) => f.t !== "state")).toEqual([
      { t: "snapshot", snapshot: { cursor: 41, machines: [] } },
      { t: "event", event: { seq: 42, type: "task.started" } },
    ]);
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
    hub.frame({ t: "error", id: "c2", code: "forbidden", message: "This key lacks the operate role.", fix: "Use an operator key." });
    await expect(ok).resolves.toEqual({ ok: true, output: { cursor: 3 } });
    await expect(refused).resolves.toMatchObject({ ok: false, error: { code: "forbidden", fix: "Use an operator key." } });
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
    expect(hub.sent).toEqual([{ t: "auth", key: "k1" }, { t: "snapshot" }, { t: "live", board: true }]);
    expect(states()).toEqual(["connecting", "retrying", "connecting", "retrying", "connecting", "live"]);
  });

  it("keeps backing off from a hub that accepts the key and then drops, and starts over after a stable link", () => {
    const { hub, client } = setup();
    client.start();
    const delays: Array<number> = [];
    for (let i = 0; i < 4; i++) {
      hub.ready();
      hub.close(1006);
      const state = client.state;
      if (state.phase !== "retrying") throw new Error(state.phase);
      delays.push(state.retryAt - Date.now());
      vi.advanceTimersByTime(state.retryAt - Date.now());
    }
    expect(delays).toEqual([500, 1000, 2000, 4000]);
    hub.ready();
    vi.advanceTimersByTime(STABLE_MS);
    hub.pong();
    hub.close(1006);
    expect(client.state).toMatchObject({ phase: "retrying", retryAt: Date.now() + 500 });
  });

  it("pings a quiet link and gives it up when nothing comes back", () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(hub.pings).toBe(1);
    hub.pong();
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(client.state.phase).toBe("live");
    expect(hub.pings).toBe(2);
    // No pong, no frame since: the next tick is past the deadline.
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(client.state).toMatchObject({ phase: "retrying", reason: expect.stringContaining("stopped answering") as string });
    expect(hub.closedByClient).toBe(1);
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
    expect(hub.sent).toEqual([{ t: "auth", key: "k1" }, { t: "snapshot" }, { t: "live", board: true }]);
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
    expect(hub.sent).toEqual([{ t: "auth", key: "k1" }, { t: "snapshot" }, { t: "live", board: true }, { t: "chat", project }]);
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
    expect(hub.sent).toEqual([{ t: "auth", key: "k1" }]);
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
