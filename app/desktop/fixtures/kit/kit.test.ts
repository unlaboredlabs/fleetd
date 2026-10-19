import { describe, expect, it } from "vitest";
import { matches } from "../../src/main/hub/fixture.ts";
import { Fixture } from "./fixture.ts";
import { assertClean, makeSanitizer } from "./sanitize.ts";
import { fitStrings, validateFixture } from "./schema.ts";

describe("Fixture answers", () => {
  // Main answers a call with the first entry whose input is a subset of it.
  const answer = (f: Fixture, tool: string, input: Record<string, unknown>) =>
    f.toFile().calls.find((c) => c.tool === tool && (c.input === undefined || matches(c.input, input)))?.outcome;

  it("matches the most specific input first, whatever order they were added in", () => {
    const f = new Fixture("t", "")
      .answer("order_get", undefined, { which: "any" })
      .answer("order_get", { workstreamId: "W2" }, { which: "W2" });
    expect(answer(f, "order_get", { workstreamId: "W2" })).toEqual({ ok: true, output: { which: "W2" } });
    expect(answer(f, "order_get", { workstreamId: "W3" })).toEqual({ ok: true, output: { which: "any" } });
  });

  it("replaces an earlier answer to the same input, and fail() replaces it too", () => {
    const f = new Fixture("t", "").answer("asks_list", {}, { n: 1 }).answer("asks_list", {}, { n: 2 });
    expect(f.answers("asks_list")).toHaveLength(1);
    f.fail("asks_list", {}, { code: "failed", message: "no" });
    expect(answer(f, "asks_list", {})).toEqual({ ok: false, error: { code: "failed", message: "no" } });
  });

  it("copies share nothing with their base", () => {
    const base = new Fixture("a", "").answer("orders_board", {}, { orders: [] });
    const copy = Fixture.from(base, "b", "");
    copy.update("orders_board", () => ({ orders: [{ title: "x" }] }));
    expect(base.output("orders_board", {})).toEqual({ orders: [] });
  });
});

describe("sanitize", () => {
  const lab = "/home/someone/src/fleetd-lab/slot-4";
  const s = makeSanitizer(lab, 4875);

  it("rewrites lab paths, machines, the testbed and ids, stably", () => {
    const raw = {
      path: `${lab}/e2e-4875/home-lab-a/.fleetd/node/worktrees/x`,
      repo: "unlaboredlabs/fleetd-testbed-4",
      url: "http://127.0.0.1:4875/healthz",
      machineId: "lab-b",
      threadId: "dd77f557-c62c-41b1-68b5-a92b70aa3aca",
      ref: "lead.start@786007aa14",
    };
    const out = s.value(raw);
    expect(out).toMatchObject({ path: "/home/dev/.fleetd/node/worktrees/x", repo: "acme/storefront", url: "http://devbox:4790/healthz", machineId: "buildbox" });
    expect(JSON.stringify(out)).not.toContain("dd77f557");
    expect(s.value(raw)).toEqual(out);
  });

  it("refuses output that still names a person or the lab", () => {
    expect(() => assertClean("x", '{"a":"/srv/fleetd-lab/slot-4"}')).toThrow(/fleetd-lab/u);
    expect(() => assertClean("x", '{"a":"fld_abcdefghijklmnopqrstuvwxyz"}')).toThrow();
    expect(() => assertClean("x", '{"a":"devbox"}')).not.toThrow();
  });
});

describe("schema", () => {
  it("cuts a string the rename made too long back to the schema's limit", () => {
    const f = new Fixture("t", "").answer("asks_list", {}, { asks: [], batches: [], next: "x" });
    const summary = "s".repeat(250);
    f.events.push({ seq: 1, at: "2026-10-19T10:00:00.000Z", type: "machine.online", summary });
    expect(validateFixture(f)).not.toEqual([]);
    fitStrings(f);
    expect(validateFixture(f)).toEqual([]);
    expect(f.events[0]?.["summary"]).toHaveLength(200);
  });

  it("names the call whose output the hub could not have sent", () => {
    const f = new Fixture("t", "").answer("orders_board", {}, { orders: "nope" });
    expect(validateFixture(f).join("\n")).toMatch(/orders_board/u);
  });
});
