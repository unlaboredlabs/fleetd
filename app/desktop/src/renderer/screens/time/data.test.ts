import { describe, expect, it } from "vitest";
import { errorText, eventConcerns, linkedKeeps, litSpans, mergeSpans, parseBreakdown, resumeAfter } from "./data";
import { fixtureClient } from "./fixture";
import { DEFAULT_FILTERS, decodeFilters, parseWhen, period, queryOf, spansInput } from "./filters";
import type { Span, TimeSpansOutput } from "./types";

const span = (id: number, endMs?: number): Span => ({
  id,
  kind: "tool.bash",
  cat: "tools",
  lane: "thread:m/s",
  startMs: 0,
  status: "ok",
  ...(endMs === undefined ? {} : { endMs }),
});

describe("span pages", () => {
  it("merge by id, and a span sent again replaces its open copy", () => {
    const merged = mergeSpans([span(1, 5), span(3)], [span(2, 9), span(3, 12), span(4)]);
    expect(merged.map((s) => [s.id, s.endMs])).toEqual([
      [1, 5],
      [2, 9],
      [3, 12],
      [4, undefined],
    ]);
  });

  it("resume from just before the oldest open span, else after the newest", () => {
    expect(resumeAfter([span(1, 5), span(3), span(7)])).toBe(2);
    expect(resumeAfter([span(1, 5), span(2, 6)])).toBe(2);
    expect(resumeAfter([])).toBeUndefined();
  });

  it("page through a 15k-span order from the fixture hub", async () => {
    const client = fixtureClient({ dense: true });
    const q = queryOf(DEFAULT_FILTERS, "W8", Date.parse("2026-10-18T10:30:00.000Z"));
    let after: number | undefined;
    let n = 0;
    for (;;) {
      const out = await client.call("time_spans", spansInput(q, after));
      if (!out.ok) throw new Error(out.error.message);
      const page = out.output as TimeSpansOutput;
      n += page.spans.length;
      if (page.nextAfterId === undefined) break;
      after = page.nextAfterId;
    }
    expect(n).toBeGreaterThan(15_000);
  });
});

describe("events", () => {
  it("refetch an order only on the events about it", () => {
    expect(eventConcerns({ seq: 1, type: "task.started", data: { workstreamId: "W8" } }, "W8")).toBe(true);
    expect(eventConcerns({ seq: 1, type: "lead.woken", data: { workstreamIds: ["W3", "W8"] } }, "W8")).toBe(true);
    expect(eventConcerns({ seq: 1, type: "task.started", data: { workstreamId: "W3" } }, "W8")).toBe(false);
    expect(eventConcerns({ seq: 1, type: "machine.up", data: { workstreamId: "W8" } }, "W8")).toBe(false);
  });

  it("narrow linked spans to one label or check", () => {
    const s: Span = { ...span(1, 2), label: "npm test", extra: { check: "lint" } };
    expect(linkedKeeps({ title: "", label: "npm test" }, s)).toBe(true);
    expect(linkedKeeps({ title: "", label: "npm run build" }, s)).toBe(false);
    expect(linkedKeeps({ title: "", check: "lint", kinds: ["tool.bash"] }, s)).toBe(true);
    expect(linkedKeeps({ title: "", kinds: ["ci.check"] }, s)).toBe(false);
  });

  it("refuse an answer that isn't shaped like a breakdown", () => {
    expect(parseBreakdown({ wallMs: 1 }).ok).toBe(false);
    expect(parseBreakdown(null).ok).toBe(false);
  });
});

describe("filters", () => {
  const now = Date.parse("2026-10-18T10:07:12.000Z");

  it("end ranges now, and today starts at UTC midnight", () => {
    expect(period({ range: "hour" }, now)).toEqual([now - 3_600_000, undefined]);
    expect(period({ range: "today" }, now)[0]).toBe(Date.parse("2026-10-18T00:00:00.000Z"));
    expect(period({ range: "week" }, now)[0]).toBe(Date.parse("2026-10-11T10:07:12.000Z"));
    const custom = { since: Date.parse("2026-10-01T00:00:00.000Z"), until: now };
    expect(period({ range: "custom", custom }, now)).toEqual([custom.since, now]);
  });

  it("read custom dates as UTC", () => {
    expect(parseWhen("2026-10-12")).toBe(Date.parse("2026-10-12T00:00:00.000Z"));
    expect(parseWhen(" 2026-10-12 09:30 ")).toBe(Date.parse("2026-10-12T09:30:00.000Z"));
    expect(parseWhen("last tuesday")).toBeUndefined();
  });

  it("compare with the period just before, of the same length, and never on an order", () => {
    const q = queryOf({ ...DEFAULT_FILTERS, compare: true }, undefined, now);
    expect(q.breakdown.compare).toEqual({ since: "2026-10-04T10:07:12.000Z", until: "2026-10-11T10:07:12.000Z" });
    expect(q.spans).toBe(false);
    const o = queryOf({ ...DEFAULT_FILTERS, compare: true }, "W8", now);
    expect(o.breakdown.compare).toBeUndefined();
    expect(o.scope).toEqual({ kind: "order", workstreamId: "W8" });
    expect(o.spans).toBe(true);
  });

  it("narrow a project by machine, and scope a machine on its own", () => {
    const p = queryOf({ ...DEFAULT_FILTERS, project: { machineId: "devbox", projectId: "storefront" }, machine: "devbox", role: "reviewer" }, undefined, now);
    expect(p.scope.kind).toBe("project");
    expect(p.breakdown.filters).toEqual({ machineId: "devbox", role: "reviewer" });
    expect(queryOf({ ...DEFAULT_FILTERS, machine: "buildbox" }, undefined, now).scope).toEqual({ kind: "machine", machineId: "buildbox" });
  });

  it("survive a round trip and tolerate old or foreign files", () => {
    const f = { range: "month" as const, compare: true, project: { machineId: "devbox", projectId: "storefront" }, role: "reviewer" as const };
    expect(decodeFilters(JSON.parse(JSON.stringify(f)))).toEqual(f);
    expect(decodeFilters({})).toEqual(DEFAULT_FILTERS);
    expect(decodeFilters({ range: "decade", role: "boss", machine: 4 })).toEqual(DEFAULT_FILTERS);
  });
});

describe("errors", () => {
  it("say what happened in a sentence, never the raw call", () => {
    const raw = "fixture empty has no answer for time_spans {\"scope\":{}}";
    expect(errorText({ ok: false, error: { code: "not_found", message: raw } })).toBe("The hub has no time data for this yet.");
    expect(errorText({ ok: false, error: { code: "offline", message: raw } })).toMatch(/^Not connected/u);
    expect(errorText({ ok: false, error: { code: "weird", message: raw, fix: "Restart the hub." } })).toBe("The hub couldn't answer. Restart the hub.");
  });
});

describe("list the lit spans", () => {
  it("lists exactly the spans a highlight lit, not what a rule or kind query would return", () => {
    const spans = [span(1, 5), span(2, 6), span(3, 7), span(4, 8)].map((s, i) => ({ ...s, startMs: 40 - i * 10 }));
    expect(litSpans(spans, new Set([2, 4])).map((s) => s.id)).toEqual([4, 2]);
    expect(litSpans(spans, new Set())).toEqual([]);
  });
});
