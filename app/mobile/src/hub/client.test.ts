import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoff, HubClient, INPUT_REFUSAL_MS, PROBE_EVERY_MS, READY_TIMEOUT_MS, socketUrl, type HubFrame } from "./client";
import { fakeHub } from "./fake";

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
    hub.link.open();
    expect(hub.sentOf("auth")).toEqual([{ t: "auth", key: "key_abc" }]);
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
    vi.advanceTimersByTime(PROBE_EVERY_MS);
    expect(first.sent.filter((m) => m.t === "call" && m.tool === "hub_info")).toHaveLength(1);
    // Probed again at 30 s; at 45 s nothing was heard for SILENT_DEAD_MS.
    vi.advanceTimersByTime(2 * PROBE_EVERY_MS);
    expect(first.closed).toBe(true);
    expect(states().at(-1)).toMatchObject({ phase: "retrying", reason: "The hub stopped answering" });
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
