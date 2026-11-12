import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoff, FRONT_BACKOFF_CAP_MS, HubClient, INPUT_REFUSAL_MS, PROBE_EVERY_MS, QUIET_FRONT_MS, RACE_AFTER_BEHIND_MS, READY_TIMEOUT_MS, REPLAY_MAX, RESTART_FAST_MS, RESTART_RETRY_MS, SILENT_DEAD_FRONT_MS, SILENT_DEAD_MS, WAKE_PROBE_MS, socketUrl, type HubFrame } from "./client";
import { fakeHub } from "./fake";
import { Deflate, Z_SYNC_FLUSH } from "pako";
import { MAX_FPS } from "../screen";

const HUB = "http://devbox:4790";

const setup = () => {
  const hub = fakeHub();
  const frames: HubFrame[] = [];
  const client = new HubClient({ hub: HUB, key: "key_abc", transport: hub.transport, emit: (f) => frames.push(f), random: () => 0.5 });
  const states = () => frames.flatMap((f) => (f.t === "state" ? [f.state] : []));
  return { hub, client, frames, states };
};

const snapshot = { t: "snapshot", cursor: 7, attention: [], machines: [], projects: [] };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("socketUrl", () => {
  it("turns a hub's origin into its /app socket", () => {
    expect(socketUrl("http://devbox:4790")).toBe("ws://devbox:4790/app");
    expect(socketUrl("https://devbox.example.ts.net/")).toBe("wss://devbox.example.ts.net/app");
  });
});

describe("HubClient", () => {
  it("authenticates, then asks for a snapshot and streams events from its cursor", () => {
    const { hub, client, frames, states } = setup();
    client.start();
    expect(hub.link.url).toBe("ws://devbox:4790/app");
    // The auth rides the upgrade too, for a hub that answers it a round trip sooner.
    expect(hub.link.headers).toEqual({ authorization: "Bearer key_abc", "x-fleetd-features": "deflate" });
    hub.link.open();
    // The snapshot goes with the auth, not a round trip after it: the hub reads them in order.
    expect(hub.link.sent).toEqual([{ t: "auth", key: "key_abc", features: ["deflate"] }, { t: "snapshot" }]);
    hub.link.frame({ t: "ready", protocol: 1, version: "0.1.0" });
    expect(states().at(-1)).toMatchObject({ phase: "live", protocol: 1, version: "0.1.0" });
    expect(hub.sentOf("snapshot")).toHaveLength(1);
    hub.link.frame(snapshot);
    expect(hub.sentOf("events")).toEqual([{ t: "events", cursor: 7 }]);
    expect(frames.some((f) => f.t === "snapshot")).toBe(true);
  });

  it("skips events at or before the cursor", () => {
    const { hub, client, frames } = setup();
    client.start();
    hub.ready();
    hub.link.frame(snapshot);
    for (const seq of [6, 7, 8, 8]) hub.link.frame({ t: "event", seq, type: "chat.message", at: "2026-10-28T10:00:00Z" });
    expect(frames.filter((f) => f.t === "event").map((f) => (f.t === "event" ? f.event.seq : 0))).toEqual([8]);
  });

  it("settles calls by id, and fails them when the link drops", async () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    const ok = client.call("requests_list", { state: "open" });
    hub.answer("requests_list", { requests: [] });
    await expect(ok).resolves.toEqual({ ok: true, output: { requests: [] } });
    const refused = client.call("approval_answer", { requestId: "r1", decision: "approve" });
    hub.fail("approval_answer", "forbidden", "Not yours");
    await expect(refused).resolves.toMatchObject({ ok: false, error: { code: "forbidden", message: "Not yours" } });
    // The hub's reason, where it gives one, comes with its fix.
    const why = client.call("memory_import", { text: "Ada" });
    hub.fail("memory_import", "invalid", "No project yet.", { fix: "Make one.", reason: "no_project" });
    await expect(why).resolves.toEqual({ ok: false, error: { code: "invalid", message: "No project yet.", fix: "Make one.", reason: "no_project" } });
    const cut = client.call("chat_send", { projectRef: { machineId: "m", projectId: "p" }, text: "hi", clientRequestId: "x" });
    hub.link.close(1006);
    await expect(cut).resolves.toMatchObject({ ok: false, error: { code: "disconnected" } });
  });

  it("answers offline without a link", async () => {
    const { client } = setup();
    await expect(client.call("hub_info", {})).resolves.toMatchObject({ ok: false, error: { code: "offline" } });
  });

  it("retries with backoff after a drop, and stops for good on a refused key", () => {
    const { hub, client, states } = setup();
    client.start();
    hub.link.close(1006);
    expect(states().at(-1)).toMatchObject({ phase: "retrying", reason: `Can't reach ${HUB}` });
    vi.advanceTimersByTime(backoff(0));
    expect(hub.links).toHaveLength(2);
    hub.link.open();
    hub.link.close(4401, "revoked");
    expect(states().at(-1)).toEqual({ phase: "refused", hub: HUB, message: "The hub refused the key (revoked)." });
    vi.advanceTimersByTime(60_000);
    expect(hub.links).toHaveLength(2);
  });

  it("treats an error before ready as a refused key", () => {
    const { hub, client, states } = setup();
    client.start();
    hub.link.open();
    hub.link.frame({ t: "error", code: "unauthorized", message: "Unknown key" });
    expect(states().at(-1)).toMatchObject({ phase: "refused", message: "Unknown key" });
  });

  it("gives up on a hub that never says ready", () => {
    const { hub, client, states } = setup();
    client.start();
    hub.link.open();
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    expect(hub.link.closed).toBe(true);
    expect(states().at(-1)).toMatchObject({ phase: "retrying" });
  });

  it("probes a quiet link and drops it when nothing comes back", () => {
    const { hub, client, states } = setup();
    client.start();
    const first = hub.ready();
    const probes = () => first.sent.filter((m) => m.t === "call" && m.tool === "hub_info");
    // In front, nothing goes before 10 s of quiet, so a cellular radio can idle between.
    vi.advanceTimersByTime(QUIET_FRONT_MS - 1);
    expect(probes()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(probes()).toHaveLength(1);
    // Probed at 10 s; unanswered for a whole tick, at 15 s, the link is dead, rather than shown live 10 s longer.
    expect(SILENT_DEAD_FRONT_MS).toBe(15_000);
    vi.advanceTimersByTime(SILENT_DEAD_FRONT_MS - QUIET_FRONT_MS - 1);
    expect(probes()).toHaveLength(1);
    expect(first.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(first.closed).toBe(true);
    expect(states().at(-1)).toMatchObject({ phase: "retrying", reason: "The hub stopped answering" });
  });

  it("gives a quiet link longer while the app is behind", () => {
    const { hub, client } = setup();
    client.start();
    const first = hub.ready();
    client.sleep();
    vi.advanceTimersByTime(10_000);
    expect(first.sent.filter((m) => m.t === "call" && m.tool === "hub_info")).toHaveLength(0);
    vi.advanceTimersByTime(SILENT_DEAD_MS - 10_000 - 1);
    expect(first.closed).toBe(false);
    vi.advanceTimersByTime(PROBE_EVERY_MS);
    expect(first.closed).toBe(true);
  });

  it("keeps a live link that answers when the app comes back to the front, and its calls with it", async () => {
    const { hub, client, frames } = setup();
    client.start();
    const first = hub.ready();
    const pending = client.call("requests_list", { state: "open" });
    client.sleep();
    client.wake();
    const probe = first.sent.filter((m) => m.t === "call" && m.tool === "hub_info").at(-1);
    first.frame({ t: "result", id: probe?.id, output: {} });
    vi.advanceTimersByTime(WAKE_PROBE_MS);
    expect(hub.links).toHaveLength(1);
    expect(first.closed).toBe(false);
    expect(frames.filter((f) => f.t === "state")).toHaveLength(2);
    hub.answer("requests_list", { requests: [] });
    await expect(pending).resolves.toEqual({ ok: true, output: { requests: [] } });
  });

  it("dials again when a link silent since the app slept doesn't answer on waking", () => {
    const { hub, client, states } = setup();
    client.start();
    const first = hub.ready();
    client.sleep();
    vi.advanceTimersByTime(1000);
    client.wake();
    vi.advanceTimersByTime(WAKE_PROBE_MS - 1);
    expect(hub.links).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(first.closed).toBe(true);
    expect(hub.links).toHaveLength(2);
    expect(states().at(-1)).toMatchObject({ phase: "connecting" });
  });

  describe("back from a long time behind", () => {
    // iOS stops the timers behind: the clock jumps, and nothing ticked meanwhile.
    const behind = (client: HubClient, ms: number) => {
      client.sleep();
      vi.setSystemTime(Date.now() + ms);
      client.wake();
    };

    it("takes a fresh link that is ready before the old one says a word, and replays what was missed", () => {
      const { hub, client, frames, states } = setup();
      client.start();
      const first = hub.ready();
      first.frame(snapshot);
      first.frame({ t: "event", seq: 8, type: "task.started" });
      behind(client, RACE_AFTER_BEHIND_MS + 1);
      // The probe on the old link and a fresh link, at once.
      expect(first.sent.filter((m) => m.t === "call" && m.tool === "hub_info")).toHaveLength(1);
      expect(hub.links).toHaveLength(2);
      const fresh = hub.link;
      fresh.open();
      expect(fresh.sent.map((m) => m.t)).toEqual(["auth", "snapshot"]);
      // Its frames wait until it is the link: the app still reads the old one meanwhile.
      fresh.frame({ t: "ready", protocol: 1, version: "0.1.0" });
      expect(first.closed).toBe(true);
      expect(states().at(-1)).toMatchObject({ phase: "live" });
      fresh.frame({ ...snapshot, cursor: 9 });
      // Back from the last event applied, so the one missed replays.
      expect(fresh.sent.at(-1)).toEqual({ t: "events", cursor: 8 });
      expect(frames.at(-1)).toMatchObject({ t: "snapshot", replay: true });
      // No third link when the probe's wait runs out.
      vi.advanceTimersByTime(WAKE_PROBE_MS);
      expect(hub.links).toHaveLength(2);
      expect(fresh.closed).toBe(false);
    });

    it("keeps the old link, and its calls, when it answers first, and closes the fresh one", async () => {
      const { hub, client, frames } = setup();
      client.start();
      const first = hub.ready();
      const pending = client.call("requests_list", { state: "open" });
      behind(client, RACE_AFTER_BEHIND_MS + 1);
      const fresh = hub.link;
      fresh.open();
      const probe = first.sent.filter((m) => m.t === "call" && m.tool === "hub_info").at(-1);
      first.frame({ t: "result", id: probe?.id, output: {} });
      expect(fresh.closed).toBe(true);
      fresh.frame({ t: "ready", protocol: 1 });
      vi.advanceTimersByTime(WAKE_PROBE_MS);
      expect(first.closed).toBe(false);
      expect(frames.filter((f) => f.t === "state")).toHaveLength(2);
      const call = first.sent.find((m) => m.t === "call" && m.tool === "requests_list");
      first.frame({ t: "result", id: call?.id, output: { requests: [] } });
      await expect(pending).resolves.toEqual({ ok: true, output: { requests: [] } });
    });

    it("goes on with the fresh link still dialling when the probe's wait runs out, or the old link ends", () => {
      for (const end of ["wait", "close"] as const) {
        const { hub, client, states } = setup();
        client.start();
        const first = hub.ready();
        behind(client, RACE_AFTER_BEHIND_MS + 1);
        const fresh = hub.link;
        if (end === "wait") vi.advanceTimersByTime(WAKE_PROBE_MS);
        else first.close(1006);
        expect(first.closed).toBe(true);
        expect(hub.links).toHaveLength(2);
        expect(states().at(-1)).toMatchObject({ phase: "connecting" });
        fresh.open();
        fresh.frame({ t: "ready", protocol: 1 });
        expect(states().at(-1)).toMatchObject({ phase: "live" });
        client.stop();
      }
    });

    it("only asks the old link after a short time behind", () => {
      const { hub, client } = setup();
      client.start();
      hub.ready();
      behind(client, RACE_AFTER_BEHIND_MS);
      expect(hub.links).toHaveLength(1);
    });
  });

  it("asks rather than counts the sleep as silence when its timer wakes late", () => {
    const { hub, client } = setup();
    client.start();
    const first = hub.ready();
    // iOS stops the timers behind: the clock jumps, and the late tick sees minutes of quiet.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    vi.advanceTimersByTime(PROBE_EVERY_MS);
    expect(first.closed).toBe(false);
    const probe = first.sent.filter((m) => m.t === "call" && m.tool === "hub_info").at(-1);
    first.frame({ t: "result", id: probe?.id, output: {} });
    vi.advanceTimersByTime(WAKE_PROBE_MS);
    expect(first.closed).toBe(false);
    expect(hub.links).toHaveLength(1);
  });

  it.each([1012, 1001])("says a hub that closes with %i is restarting, redials it every 250 ms for 60 s, then backs off as usual", (code) => {
    const { hub, client, frames, states } = setup();
    client.start();
    hub.ready();
    hub.link.close(code, "service restart");
    expect(frames.at(-2)).toEqual({ t: "restart", code, reason: "service restart" });
    expect(states().at(-1)).toMatchObject({ phase: "retrying", reason: `${HUB} is restarting` });
    for (let i = 0; i < 20; i++) {
      const retrying = states().at(-1);
      expect(retrying?.phase === "retrying" ? retrying.retryAt - Date.now() : 0).toBe(RESTART_RETRY_MS);
      vi.advanceTimersByTime(RESTART_RETRY_MS);
      expect(hub.links).toHaveLength(i + 2);
      hub.link.close(1006);
    }
    vi.advanceTimersByTime(RESTART_FAST_MS);
    const links = hub.links.length;
    hub.link.close(1006);
    // Past the fast minute: the backoff starts where it would have, not where 20 fast tries would put it.
    const retrying = states().at(-1);
    expect(retrying?.phase === "retrying" ? retrying.retryAt - Date.now() : 0).toBe(backoff(0));
    expect(hub.links).toHaveLength(links);
  });

  it("backs off as before after any other close, and after a 1012 before ready", () => {
    const { hub, client, frames, states } = setup();
    client.start();
    hub.ready();
    hub.link.close(1006);
    expect(states().at(-1)).toMatchObject({ phase: "retrying", reason: "The connection to the hub dropped" });
    vi.advanceTimersByTime(backoff(0) * 1.25);
    hub.link.open();
    hub.link.close(1012, "service restart");
    expect(frames.some((f) => f.t === "restart")).toBe(false);
    const retrying = states().at(-1);
    expect(retrying?.phase === "retrying" ? retrying.retryAt - Date.now() : 0).toBe(backoff(1));
  });

  it("dials at once on waking while it waits out a backoff, and waits less in front", () => {
    const { hub, client, states } = setup();
    client.start();
    for (let i = 0; i < 8; i++) {
      hub.link.close(1006);
      vi.advanceTimersByTime(FRONT_BACKOFF_CAP_MS * 1.25);
    }
    expect(hub.links).toHaveLength(9);
    client.sleep();
    hub.link.close(1006);
    const retrying = states().at(-1);
    expect(retrying?.phase === "retrying" ? retrying.retryAt - Date.now() : 0).toBe(backoff(8));
    client.wake();
    expect(hub.links).toHaveLength(10);
  });

  it("sends the chat subscription again on each connection", () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    client.chat({ machineId: "m1", projectId: "p1" });
    expect(hub.sentOf("chat")).toEqual([{ t: "chat", project: { machineId: "m1", projectId: "p1" } }]);
    client.reconnectNow();
    hub.ready();
    expect(hub.sentOf("chat")).toEqual([{ t: "chat", project: { machineId: "m1", projectId: "p1" } }]);
  });

  it("follows the open chat's lead lane, and stops when the chat closes", () => {
    const { hub, client, frames } = setup();
    client.start();
    hub.ready();
    client.chat({ machineId: "m1", projectId: "p1" });
    expect(hub.sentOf("live")).toEqual([{ t: "live", board: false, agent: "lead:m1/p1" }]);
    const lane = { laneId: "lead:m1/p1", status: "working", activity: { activity: { kind: "thinking" }, since: "2026-10-28T10:00:00Z" } };
    hub.link.frame({ t: "live", at: "2026-10-28T10:00:01Z", full: true, lanes: [lane] });
    expect(frames.at(-1)).toEqual({ t: "live", frame: { at: "2026-10-28T10:00:01Z", full: true, lanes: [lane] } });
    client.chat(null);
    expect(hub.sentOf("live").at(-1)).toEqual({ t: "live", board: false });
  });

  it("back from a drop, replays the events since the last one applied when only a few were missed", () => {
    const { hub, client, frames } = setup();
    client.start();
    // A first connection reads everything.
    hub.ready();
    hub.link.frame(snapshot);
    expect(hub.sentOf("events")).toEqual([{ t: "events", cursor: 7 }]);
    hub.link.frame({ t: "event", seq: 9, type: "x", at: "2026-10-28T10:00:00Z" });
    hub.link.close(1006);
    vi.advanceTimersByTime(FRONT_BACKOFF_CAP_MS);
    // One that drops before its snapshot leaves where to resume as it was.
    hub.link.open();
    hub.link.close(1006);
    vi.advanceTimersByTime(FRONT_BACKOFF_CAP_MS);
    hub.ready();
    hub.link.frame({ ...snapshot, cursor: 12 });
    expect(hub.sentOf("events")).toEqual([{ t: "events", cursor: 9 }]);
    for (const seq of [10, 12, 13]) hub.link.frame({ t: "event", seq, type: "x", at: "2026-10-28T10:00:00Z" });
    const replayed = frames.filter((f) => f.t === "event").map((f) => (f.t === "event" ? [f.event.seq, f.replayed === true] : []));
    expect(replayed.slice(-3)).toEqual([[10, true], [12, true], [13, false]]);
    expect(frames.filter((f) => f.t === "snapshot").map((f) => f.t === "snapshot" && f.replay === true)).toEqual([false, true]);
    // A resync while live reads everything again.
    client.resync();
    hub.link.frame({ ...snapshot, cursor: 14 });
    expect(hub.sentOf("events").at(-1)).toEqual({ t: "events", cursor: 14 });
  });

  it("reads everything again after a drop that missed too many events, and after a stop", () => {
    const { hub, client } = setup();
    client.start();
    hub.ready();
    hub.link.frame(snapshot);
    hub.link.close(1006);
    vi.advanceTimersByTime(FRONT_BACKOFF_CAP_MS);
    hub.ready();
    hub.link.frame({ ...snapshot, cursor: 7 + REPLAY_MAX + 1 });
    expect(hub.sentOf("events")).toEqual([{ t: "events", cursor: 7 + REPLAY_MAX + 1 }]);
    client.stop();
    client.start();
    hub.ready();
    hub.link.frame({ ...snapshot, cursor: 7 + REPLAY_MAX + 2 });
    expect(hub.sentOf("events")).toEqual([{ t: "events", cursor: 7 + REPLAY_MAX + 2 }]);
  });

  it("resumes the event stream after a session error", () => {
    const { hub, client, frames } = setup();
    client.start();
    hub.ready();
    hub.link.frame(snapshot);
    hub.link.frame({ t: "event", seq: 9, type: "x", at: "2026-10-28T10:00:00Z" });
    hub.link.frame({ t: "error", code: "internal", message: "stream ended" });
    expect(frames.at(-1)).toMatchObject({ t: "error" });
    vi.advanceTimersByTime(backoff(0));
    expect(hub.sentOf("events").at(-1)).toEqual({ t: "events", cursor: 9 });
  });
});

/** A hub's compressing side of one connection (RFC 7692): each message sync-flushed, its 00 00 ff ff tail cut. */
const deflater = () => {
  const z = new Deflate({ raw: true, windowBits: 15 });
  let got: Uint8Array[] = [];
  z.onData = (chunk) => got.push(chunk);
  return (frame: Record<string, unknown>): Uint8Array => {
    got = [];
    z.push(JSON.stringify(frame), Z_SYNC_FLUSH);
    const all = new Uint8Array(got.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of got) {
      all.set(c, at);
      at += c.length;
    }
    return all.subarray(0, all.length - 4);
  };
};

describe("compressed frames", () => {
  it("reads a hub's Binary frames, in order, with Text ones between", () => {
    const { hub, client, frames } = setup();
    client.start();
    hub.ready(["deflate"]);
    const deflate = deflater();
    hub.link.binary(deflate(snapshot));
    hub.link.frame({ t: "event", seq: 8, type: "x", at: "2026-10-28T10:00:00Z" });
    hub.link.binary(deflate({ t: "event", seq: 9, type: "x", at: "2026-10-28T10:00:01Z" }));
    expect(frames.filter((f) => f.t !== "state").map((f) => (f.t === "event" ? f.event.seq : f.t))).toEqual(["snapshot", 8, 9]);
    expect(hub.sentOf("events")).toEqual([{ t: "events", cursor: 7 }]);
  });

  it("each connection's frames are a stream of their own", () => {
    const { hub, client, frames } = setup();
    client.start();
    hub.ready(["deflate"]);
    hub.link.binary(deflater()(snapshot));
    hub.link.close(1006);
    vi.advanceTimersByTime(FRONT_BACKOFF_CAP_MS);
    hub.ready(["deflate"]);
    hub.link.binary(deflater()({ ...snapshot, cursor: 9 }));
    expect(frames.flatMap((f) => (f.t === "snapshot" ? [f.snapshot.cursor] : []))).toEqual([7, 9]);
  });

  it("drops a link whose frame won't inflate, and asks the next for plain text", () => {
    const { hub, client, states } = setup();
    client.start();
    const first = hub.ready(["deflate"]);
    hub.link.binary(new Uint8Array([0xff, 0xff, 0xff, 0x00]));
    expect(first.closed).toBe(true);
    expect(states().at(-1)).toMatchObject({ phase: "retrying", reason: "A frame from the hub didn't inflate" });
    vi.advanceTimersByTime(backoff(0));
    hub.link.open();
    expect(hub.sentOf("auth")).toEqual([{ t: "auth", key: "key_abc" }]);
    expect(hub.link.headers).toEqual({ authorization: "Bearer key_abc", "x-fleetd-features": "" });
  });
});

describe("watching a screen", () => {
  const frame = (sessionId: string, seq: number) => ({ t: "browser_frame", sessionId, seq, jpegB64: "AA==", width: 4, height: 3, control: "agent" });

  it("watches only on a hub that reads it, again after each reconnect, and hands on that screen's frames alone", () => {
    const { hub, client, frames } = setup();
    client.watch("Bsee");
    client.start();
    // An older hub, without the feature: it never sees a watch or an input.
    hub.ready();
    client.input("Bsee", { kind: "text", text: "hi" });
    expect(hub.sentOf("browser_watch")).toEqual([]);
    expect(hub.sentOf("browser_input")).toEqual([]);
    client.reconnectNow();
    hub.ready(["browser_sessions"]);
    expect(hub.sentOf("browser_watch")).toEqual([{ t: "browser_watch", session: "Bsee" }]);
    hub.link.frame(frame("Bsee", 1));
    hub.link.frame(frame("Bother", 2));
    const shown = frames.flatMap((f) => (f.t === "browser_frame" ? [f.frame] : []));
    expect(shown).toEqual([{ sessionId: "Bsee", seq: 1, jpegB64: "AA==", width: 4, height: 3, control: "agent" }]);
    client.input("Bsee", { kind: "mouse", action: "pressed", x: 1, y: 2, button: "left", clickCount: 1 });
    expect(hub.sentOf("browser_input")).toEqual([{ t: "browser_input", session: "Bsee", input: { kind: "mouse", action: "pressed", x: 1, y: 2, button: "left", clickCount: 1 } }]);
    // A browser you drive goes elsewhere, as #923's navigate input.
    client.input("Bsee", { kind: "navigate", url: "https://booking.com" });
    expect(hub.sentOf("browser_input").at(-1)).toEqual({ t: "browser_input", session: "Bsee", input: { kind: "navigate", url: "https://booking.com" } });
    // Stopped: the hub hears it, and a frame still on its way is dropped.
    client.watch(null);
    expect(hub.sentOf("browser_watch").at(-1)).toEqual({ t: "browser_watch" });
    hub.link.frame(frame("Bsee", 3));
    expect(frames.filter((f) => f.t === "browser_frame")).toHaveLength(1);
  });

  it("acks each frame of the watched screen to a hub that paces them, and none to one that doesn't", () => {
    const { hub, client } = setup();
    client.watch("Bsee");
    client.start();
    hub.ready(["browser_sessions"]);
    hub.link.frame(frame("Bsee", 1));
    expect(hub.sentOf("browser_frame_ack")).toEqual([]);
    client.reconnectNow();
    hub.ready(["browser_sessions", "frame_acks"]);
    expect(hub.sentOf("browser_watch").at(-1)).toEqual({ t: "browser_watch", session: "Bsee", acks: true, fps: MAX_FPS });
    hub.link.frame(frame("Bsee", 2));
    // Another screen's, on its way after a change: acked never.
    hub.link.frame(frame("Bother", 3));
    expect(hub.sentOf("browser_frame_ack")).toEqual([{ t: "browser_frame_ack", seq: 2 }]);
  });

  it("hands a refusal of what was just sent to the live view, and asks for the events again all the same", () => {
    const { hub, client, frames } = setup();
    client.start();
    hub.ready(["browser_sessions"]);
    hub.link.frame(snapshot);
    const events = hub.sentOf("events").length;
    client.input("Bsee", { kind: "navigate", url: "https://booking.com" });
    hub.link.frame({ t: "error", code: "invalid", message: "Unknown or malformed message." });
    expect(frames.at(-1)).toEqual({ t: "browser_error", error: { code: "invalid", message: "Unknown or malformed message.", fix: undefined } });
    // In case it was the event stream's: asked again, from where it was.
    vi.advanceTimersByTime(INPUT_REFUSAL_MS + 10);
    expect(hub.sentOf("events")).toHaveLength(events + 1);
    // Long after any input, an id-less error is the event stream's again.
    hub.link.frame({ t: "error", code: "failed", message: "stream ended" });
    expect(frames.at(-1)).toMatchObject({ t: "error" });
  });

  it("drops a touch while the link is down, rather than land it later", () => {
    const { hub, client } = setup();
    client.start();
    hub.ready(["browser_sessions"]);
    hub.link.close(1006);
    client.input("Bsee", { kind: "text", text: "late" });
    expect(hub.links.flatMap((l) => l.sent).filter((m) => m.t === "browser_input")).toEqual([]);
  });
});
