// The ledger (crates/fleetd/src/hub/ledger/tests.rs and overturn_tests.rs).
import { expect, test } from "bun:test";
import { leadWakes, type Trigger } from "../src/hub/api/leads.ts";
import { decisions } from "../src/hub/ledger/decisions.ts";
import { decide, decisionsSearch } from "../src/hub/ledger/tools.ts";
import { events } from "../src/hub/store/events.ts";
import { AT, key, kit, project, workstream } from "./work-kit.ts";

const P1 = { machineId: "lab-a", projectId: "p1" };
const human = { source: "human" as const, by: "human:desk" };
const lead = { source: "lead" as const, by: "lead:lab-a/p1" };

const summaries = (hub: ReturnType<typeof kit>["hub"], type: string) =>
  events(hub)
    .page(0)
    .events.filter((e) => e.type === type)
    .map((e) => e.summary);

test("supersedes the active decision on the same key and scope only", () => {
  const { hub } = kit();
  const d = decisions(hub);
  const d1 = d.record({ key: "db.engine", scope: { kind: "project", projectRef: P1 }, value: "sqlite" }, human);
  const g = d.record({ key: "db.engine", scope: { kind: "global" }, value: "postgres" }, human);
  const d2 = d.record({ key: "db.engine", scope: { kind: "project", projectRef: P1 }, value: "duckdb", why: "analytics" }, lead);
  expect(d2.decisionId).toBe("D3");
  expect(d2.supersedes).toBe("D1");
  expect([d2.source, d2.by, d2.state]).toEqual(["lead", "lead:lab-a/p1", "active"]);
  expect(d.get(d1.decisionId)?.state).toBe("superseded");
  expect(d.get(g.decisionId)?.state).toBe("active");
  expect(summaries(hub, "decision.recorded")).toEqual(["D1 db.engine = sqlite", "D2 db.engine = postgres", "D3 db.engine = duckdb"]);
  // FTS finds it by its words, active only; the chain adds global ones.
  expect(d.search("which engine for analytics?", {}).map((x) => x.decisionId)).toEqual(["D3", "D2"]);
  expect(d.search("engine", { chain: { projectRef: P1 } }).map((x) => x.decisionId).sort()).toEqual(["D2", "D3"]);
  expect(d.search("the and", {})).toEqual([]);
  expect(d.globalValue("db.engine")).toBe("postgres");
  expect(d.cited(P1, "Use D1 and db.engine.")).toEqual([d.get("D1")!, d.get("D2")!, d.get("D3")!]);
});

function setup() {
  const k = kit();
  const r = { machineId: "devbox", projectId: "app" };
  project(k.hub, r);
  const held: [string, Trigger][] = [];
  leadWakes(k.hub).trigger = (p, t) => held.push([p.projectId, t]);
  const person = key("operate", { human: true });
  return { ...k, r, held, person };
}

test("only a person with operate overturns a decision", async () => {
  const { hub, r, held, person, refused, ok } = setup();
  const d = decide(hub, r, "lead:devbox/app", { key: "api.health.path", value: "/healthz", scope: "project" }).decision;
  const revoke = { decisionId: d.decisionId, why: "the probe moved" };
  expect(await refused(key("admin"), "decisions_overturn", revoke)).toBe("forbidden");
  expect(await refused(key("read", { human: true }), "decisions_overturn", revoke)).toBe("forbidden");
  expect(await refused(person, "decisions_overturn", { decisionId: "D99", why: "x" })).toBe("not_found");
  const listed = await ok(person, "decisions_list", { projectRef: r });
  expect(listed.decisions[0].state).toBe("active");
  expect(held).toEqual([]);
});

test("a revoke records who and why, and the lead reads it at its next wake", async () => {
  const { hub, r, held, person, refused, ok } = setup();
  const d = decide(hub, r, "lead:devbox/app", { key: "api.health.path", value: "/healthz", scope: "project" }).decision;
  const out = await ok(person, "decisions_overturn", { decisionId: d.decisionId, why: "the load balancer probes /livez" });
  expect(out.overturned.state).toBe("retired");
  expect(out.overturned.retired).toEqual({ by: "human:desk", at: AT, why: "the load balancer probes /livez" });
  expect(out.decision).toBeUndefined();
  expect(held).toEqual([
    [
      "app",
      {
        kind: "line",
        line: "quiet",
        text: `- the human revoked ${d.decisionId} api.health.path (was "/healthz"): "the load balancer probes /livez"; it is open again, so ask before deciding it`,
      },
    ],
  ]);
  expect((await ok(person, "decisions_list", { projectRef: r })).decisions[0].state).toBe("retired");
  expect(events(hub).page(0).events.some((e) => e.type === "decision.retired" && e.projectId === "app")).toBe(true);
  expect(await refused(person, "decisions_overturn", { decisionId: d.decisionId, why: "again" })).toBe("invalid");
});

test("a new value supersedes it as the person's, and the list keeps both", async () => {
  const { hub, r, held, person, ok } = setup();
  const w = workstream(hub, r, "Checkout v2");
  const d = decide(hub, r, "lead:devbox/app", { key: "payments.provider", value: "stripe", why: "already integrated", workstreamId: w.workstreamId }).decision;
  const out = await ok(person, "decisions_overturn", { decisionId: d.decisionId, value: "adyen", why: "the contract is signed" });
  expect(out.decision).toMatchObject({
    value: "adyen",
    source: "human",
    by: "human:desk",
    why: "the contract is signed",
    supersedes: d.decisionId,
    scope: { kind: "workstream", workstreamId: w.workstreamId },
  });
  expect(out.overturned.state).toBe("superseded");
  const listed = await ok(person, "decisions_list", { projectRef: r });
  expect(listed.decisions.map((x: { state: string }) => x.state)).toEqual(["active", "superseded"]);
  expect(listed.orders).toEqual([{ workstreamId: w.workstreamId, title: "Checkout v2" }]);
  expect(held.length).toBe(1);
  expect(held[0]?.[1].text.startsWith(`- the human replaced ${d.decisionId} payments.provider "stripe" with `)).toBe(true);
});

test("the list is the project's and needs read on its machine", async () => {
  const { hub, r, person, refused, ok } = setup();
  decide(hub, r, "lead:devbox/app", { key: "api.health.path", value: "/healthz", scope: "project" });
  expect(await refused(key("read", { machines: ["laptop"] }), "decisions_list", { projectRef: r })).toBe("forbidden");
  expect(await refused(person, "decisions_list", { projectRef: { machineId: "devbox", projectId: "nope" } })).toBe("not_found");
  expect((await ok(key("read"), "decisions_list", { projectRef: r })).decisions.length).toBe(1);
});

test("decisions_record and decisions_search through the tools", async () => {
  const { r, ok, refused } = setup();
  expect(await refused(key("operate", { machines: ["devbox"] }), "decisions_record", { key: "a.b", scope: { kind: "global" }, value: "x" })).toBe("forbidden");
  const out = await ok(key("operate"), "decisions_record", { key: "api.base", scope: { kind: "project", projectRef: r }, value: "/v2" });
  expect(out.decision).toMatchObject({ decisionId: "D1", source: "agent", by: "agent", state: "active" });
  expect(out.next).toBe("D1 is active. Leads use it instead of asking; a project's lead is woken with it.");
  expect(await refused(key("operate"), "decisions_record", { key: "a.b", scope: { kind: "project", projectRef: { machineId: "devbox", projectId: "nope" } }, value: "x" })).toBe("not_found");
  expect(await refused(key("operate"), "decisions_record", { key: "a.b", scope: { kind: "workstream", workstreamId: "W9" }, value: "x" })).toBe("not_found");
  expect((await ok(key("read"), "decisions_search", { query: "api base" })).decisions.map((d: { decisionId: string }) => d.decisionId)).toEqual(["D1"]);
  expect(await ok(key("read"), "decisions_search", { query: "nothing here" })).toEqual({
    decisions: [],
    next: "No active decision matches; record one with decisions_record.",
  });
});

test("a lead decides at its only open order, and searches its own chain", () => {
  const { hub, r } = setup();
  expect(() => decide(hub, r, "lead:devbox/app", { key: "a.b", value: "x" })).toThrow("no open workstream");
  const w = workstream(hub, r, "One");
  expect(decide(hub, r, "lead:devbox/app", { key: "a.b", value: "x" }).decision.scope).toEqual({ kind: "workstream", workstreamId: w.workstreamId });
  workstream(hub, r, "Two");
  expect(() => decide(hub, r, "lead:devbox/app", { key: "a.b", value: "y" })).toThrow("several open workstreams");
  const other = { machineId: "devbox", projectId: "other" };
  const theirs = workstream(hub, other, "Theirs");
  expect(() => decide(hub, r, "lead:devbox/app", { key: "a.b", value: "y", workstreamId: theirs.workstreamId })).toThrow("no workstream");
  decisions(hub).record({ key: "c.d", scope: { kind: "project", projectRef: other }, value: "z" }, human);
  expect(decisionsSearch(hub, r, { query: "D1" }).decisions[0]?.decisionId).toBe("D1");
  expect(() => decisionsSearch(hub, r, { query: "D2" })).toThrow("another project's decision");
  expect(() => decisionsSearch(hub, r, { query: "D9" })).toThrow("No decision D9.");
  expect(decisionsSearch(hub, r, { query: "c.d" }).decisions).toEqual([]);
});
