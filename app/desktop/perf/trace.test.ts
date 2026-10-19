import { describe, expect, it } from "vitest";
import { keyLatencies, type TraceEvent } from "./trace.ts";

const slice = (id: string, type: string, from: number, to: number, pid = 1): Array<TraceEvent> => [
  { name: "EventLatency", ph: "b", pid, ts: from, id2: { local: id }, args: { event_latency: { event_type: type } } },
  { name: "EventLatency", ph: "e", pid, ts: to, id2: { local: id } },
];

describe("keyLatencies", () => {
  it("pairs each key press's begin and end, interleaved with other events", () => {
    const events = [
      ...slice("0x1", "MOUSE_PRESSED", 0, 14_000),
      { name: "EventLatency", ph: "b", pid: 1, ts: 20_000, id2: { local: "0x2" }, args: { event_latency: { event_type: "KEY_PRESSED" } } },
      ...slice("0x3", "KEY_RELEASED", 21_000, 21_500),
      { name: "EventLatency", ph: "e", pid: 1, ts: 36_300, id2: { local: "0x2" } },
      // The same local id in another process is another slice.
      ...slice("0x2", "KEY_PRESSED", 40_000, 43_100, 2),
    ];
    expect(keyLatencies(events)).toEqual([16.3, 3.1]);
  });

  it("ignores an end without a begin and a begin without an end", () => {
    expect(keyLatencies([...slice("0x9", "KEY_PRESSED", 0, 5_000).slice(1), ...slice("0x8", "KEY_PRESSED", 0, 1).slice(0, 1)])).toEqual([]);
  });
});
