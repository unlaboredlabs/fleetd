import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionEvents, Transport } from "../hub/transport";
import { timedTransport } from "./perf";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A transport that hands back the events it was given and records what was sent. */
const fake = () => {
  const sent: string[] = [];
  let events: ConnectionEvents | undefined;
  const transport: Transport = (_url, e) => {
    events = e;
    return { send: (text) => sent.push(text), ping: () => undefined, close: () => undefined };
  };
  return { transport, sent, events: () => events };
};

const handlers = () => ({ onOpen: vi.fn(), onText: vi.fn(), onHeard: vi.fn(), onClose: vi.fn() });

describe("timedTransport", () => {
  it("passes everything through and reports the first link's milestones, then its first calls", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
    const inner = fake();
    const on = handlers();
    const link = timedTransport(inner.transport)("ws://devbox:4790/app", on);
    link.send(JSON.stringify({ t: "call", id: "c1", tool: "chat_history", input: {} }));
    link.send(JSON.stringify({ t: "call", id: "c2", tool: "chat_history", input: {} }));
    inner.events()?.onOpen();
    inner.events()?.onText('{"t":"ready"}');
    inner.events()?.onText('{"t":"snapshot","snapshot":{}}');
    inner.events()?.onText('{"t":"live"}');

    expect(inner.sent).toHaveLength(2);
    expect(on.onOpen).toHaveBeenCalledOnce();
    expect(on.onText.mock.calls.map(([text]) => (JSON.parse(text as string) as { t: string }).t)).toEqual(["ready", "snapshot", "live"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^FLEETD_PERF hub dial_epoch_ms=\d+ open_epoch_ms=\d+ ready_epoch_ms=\d+ snapshot_epoch_ms=\d+ snapshot_bytes=30$/u);
    vi.advanceTimersByTime(5000);
    expect(lines[1]).toMatch(/^FLEETD_PERF calls chat_history=\d+$/u);
  });

  it("leaves a later connection, a reconnect, as it is", () => {
    const inner = fake();
    const timed = timedTransport(inner.transport);
    timed("ws://devbox:4790/app", handlers());
    // The first link's wrapper reads every frame it sends; a later one's frames go straight through, whatever they are.
    timed("ws://devbox:4790/app", handlers()).send("not json");
    expect(inner.sent).toEqual(["not json"]);
  });
});
