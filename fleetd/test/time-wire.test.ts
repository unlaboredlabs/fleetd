import { expect, test } from "bun:test";
import { pkey, projectRef } from "../src/hub/status/row_rules.ts";
import { headUtf16 } from "../src/hub/time/spans.ts";
import { itemId, narrow, period, totalsFold, unionMs } from "../src/hub/time/stats.ts";
import { decodeWire, mergeExtra, queueKind, requestsLane, threadLane, workstreamFromSummary } from "../src/hub/time/wire.ts";

test("a node span is taken only in the shape the contracts decode, its status ok when it names none", () => {
  const span = { key: "k1", kind: "tool.bash", sessionId: "s", startMs: 1, endMs: 2 };
  expect(decodeWire(span)).toEqual({ ...span, status: "ok" } as never);
  expect(decodeWire({ ...span, kind: "no.such" })).toBeUndefined();
  expect(decodeWire({ ...span, startMs: -1 })).toBeUndefined();
  expect(decodeWire("x")).toBeUndefined();
  expect(threadLane("m", "t")).toBe("thread:m/t");
});

test("an event's queue kind, lane, order and closing extra", () => {
  expect([queueKind("lease_wait", undefined), queueKind(undefined, "machine offline"), queueKind("usage", undefined), queueKind(undefined, undefined)]).toEqual([
    "queue.lease",
    "queue.offline",
    "queue.usage",
    "queue.slot",
  ]);
  expect(requestsLane({ workstreamId: "W2" })).toBe("requests:W2");
  expect(requestsLane({ machineId: "m", projectId: "p" })).toBe("requests:m/p");
  expect(requestsLane({})).toBe("requests:fleet");
  expect(workstreamFromSummary({ summary: "Order W12 landed" } as never)).toBe("W12");
  expect(workstreamFromSummary({ summary: "Wrote W" } as never)).toBeUndefined();
  expect(mergeExtra({ tool: "Bash", key: "a" }, { decidedBy: "human" })).toEqual({ tool: "Bash", key: "a", decidedBy: "human" } as never);
  expect(mergeExtra(undefined, { key: "b" })).toEqual({ key: "b" });
  expect(mergeExtra({ key: "a" }, undefined)).toEqual({ key: "a" });
});

test("totals fold by category in order, intervals unite, and a period and scope are read as the tools take them", () => {
  const { add, out } = totalsFold();
  add("model", "model.output", 1000.4, 1);
  add("model", "model.output", 500, 2);
  expect(out().agent).toBe(1500);
  expect(out().cats[0]).toMatchObject({ cat: "model", ms: 1500, n: 3 });
  expect(unionMs([[0, 10], [5, 15], [20, 25]])).toBe(20);
  expect(period("2026-01-01T00:00:00Z", undefined, Date.parse("2026-01-02T00:00:00Z"))).toEqual([Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-01-02T00:00:00Z")]);
  expect(() => period("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z", 0)).toThrow("until must be after since");
  expect(narrow({ kind: "fleet" }, { machineId: "m" })).toEqual({ kind: "machine", machineId: "m" });
  expect(itemId("s/msg/abc/2", "model.output")).toBe("abc");
  expect(itemId("s/toolu_1", "tool.bash")).toBe("toolu_1");
  expect(headUtf16("a😀b", 2)).toBe("a");
  expect(projectRef(pkey({ machineId: "m", projectId: "p/q" }))).toEqual({ machineId: "m", projectId: "p/q" });
});
