import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matches } from "../../src/main/hub/fixture.ts";
import { Fixture } from "./fixture.ts";
import { assertClean, makeSanitizer } from "./sanitize.ts";
import { recorded } from "./shared.ts";
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

  it("turns timed frames into main's afterMs steps, settling at the last one unless told otherwise", () => {
    const event = (seq: number) => ({ seq, at: "2026-10-19T10:00:00.000Z", type: "machine.online", summary: "devbox is online" });
    const f = new Fixture("t", "").later(3000, "event", event(2)).later(1000, "event", event(1));
    f.events.push(event(0));
    const file = f.toFile();
    expect(file.frames.map((fr) => fr.afterMs)).toEqual([undefined, 1000, 2000]);
    expect(file.settleMs).toBe(3000);
    expect(f.settleAt(5000).toFile().settleMs).toBe(5000);
    expect(Fixture.fromFile(file).timeline.map((t) => t.ms)).toEqual([1000, 3000]);
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

// Run with FLEETD_FIXTURE_DENYLIST=<file outside the repo> to check the committed recordings against real names.
describe.skipIf(process.env["FLEETD_FIXTURE_DENYLIST"] === undefined)("recorded fixtures", () => {
  const dir = path.join(import.meta.dirname, "../recorded");
  it.each(fs.readdirSync(dir).filter((f) => f.endsWith(".json")))("%s names nothing on the denylist", (file) => {
    expect(() => assertClean(file, fs.readFileSync(path.join(dir, file), "utf8"))).not.toThrow();
  });
});

describe("recorded moments", () => {
  const dir = path.join(import.meta.dirname, "../recorded");
  it.each(fs.readdirSync(dir).filter((f) => f.endsWith(".json")))("%s is traffic a hub could send", (file) => {
    expect(validateFixture(recorded(file.slice(0, -5)))).toEqual([]);
  });
});
