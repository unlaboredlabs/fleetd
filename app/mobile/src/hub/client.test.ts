import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoff, HubClient, PROBE_EVERY_MS, READY_TIMEOUT_MS, socketUrl, type HubFrame } from "./client";
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
