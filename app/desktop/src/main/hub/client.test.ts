import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubFrame } from "../../shared/hub";
import { HubClient } from "./client";
import type { ConnectionEvents, Transport } from "./transport";

/** A hub on the other end of a fake transport: records what the client sends, lets the test answer. */
class FakeHub {
  readonly urls: Array<string> = [];
  sent: Array<Record<string, unknown>> = [];
  events: ConnectionEvents | null = null;
  closedByClient = 0;

  readonly transport: Transport = (url, events) => {
    this.urls.push(url);
    this.events = events;
    this.sent = [];
    return {
      send: (text) => this.sent.push(JSON.parse(text) as Record<string, unknown>),
      close: () => {
        this.closedByClient++;
      },
    };
  };

  open(): void {
    this.events?.onOpen();
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
  const client = new HubClient({ hub: "http://devbox:4790", key: "k1", transport: hub.transport, emit: (f) => frames.push(f) });
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
    expect(hub.sent.at(-1)).toEqual({ t: "snapshot" });
    hub.frame({ t: "snapshot", cursor: 41, machines: [] });
    expect(hub.sent.at(-1)).toEqual({ t: "events", cursor: 41 });
    hub.frame({ t: "event", seq: 42, type: "task.started" });
    expect(states()).toEqual(["connecting", "live"]);
    expect(frames.filter((f) => f.t !== "state")).toEqual([
      { t: "snapshot", snapshot: { cursor: 41, machines: [] } },
      { t: "event", event: { seq: 42, type: "task.started" } },
    ]);
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
    const slow = client.call({ tool: "status_wait", input: {}, timeoutMs: 1000 });
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

  it("reconnects with backoff, resetting it once a connection got ready, and resyncs each time", () => {
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
    hub.ready(20);
    hub.close(1001, "hub shutting down");
    expect(client.state).toMatchObject({ phase: "retrying", reason: "The hub closed the connection: hub shutting down.", retryAt: Date.now() + 500 });
    vi.advanceTimersByTime(500);
    hub.open();
    hub.frame({ t: "ready", protocol: 1 });
    expect(hub.sent).toEqual([{ t: "auth", key: "k1" }, { t: "snapshot" }]);
    expect(states()).toEqual(["connecting", "retrying", "connecting", "retrying", "connecting", "live", "retrying", "connecting", "live"]);
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

  it("keeps the live subscription across reconnects and re-sends it on focus", () => {
    const { hub, client } = setup();
    client.start();
    client.live({ board: true, focus: "ws-1" });
    hub.ready();
    expect(hub.sent).toContainEqual({ t: "live", board: true, focus: "ws-1" });
    hub.sent = [];
    client.refreshLive();
    expect(hub.sent).toEqual([{ t: "live", board: true, focus: "ws-1" }]);
    client.live(null);
    expect(hub.sent.at(-1)).toEqual({ t: "live", board: false });
    client.live({ board: true });
    hub.close(1006);
    vi.advanceTimersByTime(500);
    hub.open();
    hub.frame({ t: "ready", protocol: 1 });
    expect(hub.sent).toEqual([{ t: "auth", key: "k1" }, { t: "snapshot" }, { t: "live", board: true }]);
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
