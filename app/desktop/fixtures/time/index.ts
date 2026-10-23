// The time inspector's answers (time_spans, time_breakdown, time_insights, thread_window) for the shared fixtures:
// W8, a finished order whose lanes tile and whose critical path adds up to its wall, and a week of the fleet with the
// week before for compare. time-heavy gets W8 at ten times the density: about 15k spans, paged 500 at a time.
// W8 is also put on the hub's board with its order_get, so its lanes are named, its lead is known, and "Open in
// the order view" lands on a real order.
import { defineGroup } from "../kit/group.ts";
import type { Fixture } from "../kit/fixture.ts";
import { clone, type JsonObject, type JsonValue } from "../kit/json.ts";
import { FIXTURE_ORDER, fixtureOrderLanes, fixtureProfile, timeCalls, type FixtureOptions } from "../../src/renderer/screens/time/fixture.ts";
import type { AgentRole } from "../../src/renderer/screens/time/types.ts";

const isObject = (v: JsonValue | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: JsonValue | undefined): JsonValue[] => (Array.isArray(v) ? v : []);

/** The hub's projects as its snapshot lists them. */
const projectsOf = (f: Fixture): { machineId: string; projectId: string; title: string }[] =>
  list(f.snapshot?.["projects"]).flatMap((p) =>
    isObject(p) && typeof p["machineId"] === "string" && typeof p["projectId"] === "string" && typeof p["title"] === "string"
      ? [{ machineId: p["machineId"], projectId: p["projectId"], title: p["title"] }]
      : [],
  );

/**
 * W8 on the board and its order_get, shaped from an order the recording has, in its project (so every field the contracts require
 * is there), with W8's title, project, PR, lanes and lead.
 */
const addOrder = (f: Fixture, opts: FixtureOptions) => {
  const template = f.answers("order_get")[0]?.output;
  if (!isObject(template) || !isObject(template["order"])) throw new Error(`fixture ${f.name} has no order_get to shape W8 from`);
  // The template order's project (storefront in the recording; long-text renames it).
  const ref = template["order"]["projectRef"];
  if (!isObject(ref) || typeof ref["machineId"] !== "string" || typeof ref["projectId"] !== "string") throw new Error("order has no projectRef");
  const projectRef = { machineId: ref["machineId"], projectId: ref["projectId"] };
  const laneTemplate = list(template["doneLanes"]).find(isObject) ?? {};
  const lanes = fixtureOrderLanes(opts);
  const lane = (threadId: string, role: string, title: string, taskId?: string): JsonObject => {
    const l = clone(laneTemplate);
    delete l["pr"];
    delete l["live"];
    return {
      ...l,
      laneId: taskId ?? `lead:${projectRef.machineId}/${projectRef.projectId}`,
      role,
      status: "done",
      title,
      model: "claude-opus-5-5",
      profile: fixtureProfile(role as AgentRole, title),
      threadRef: { machineId: "devbox", threadId },
      ...(taskId === undefined ? {} : { taskId }),
    };
  };
  const doneLanes = lanes.filter((t) => t.role !== "lead").map((t) => lane(t.threadId, t.role, t.title, t.taskId));
  const order = clone(template["order"]);
  const pr = list(order["prs"]).find(isObject);
  const card: JsonObject = {
    ...order,
    workstreamId: FIXTURE_ORDER,
    title: "Add three short pages",
    state: "done",
    phase: "done",
    createdAt: "2026-10-18T08:10:00.000Z",
    updatedAt: "2026-10-18T09:52:00.000Z",
    projectRef,
    lanes: [],
    prs: pr === undefined ? [] : [{ ...clone(pr), changeId: "X7", number: 205, url: "https://github.com/acme/storefront/pull/205" }],
  };
  const lead = lanes.find((t) => t.role === "lead");
  f.answer("order_get", { workstreamId: FIXTURE_ORDER }, {
    ...clone(template),
    order: card,
    requests: [],
    claims: [],
    doneLanes,
    ...(lead === undefined ? {} : { lead: lane(lead.threadId, "lead", "lead") }),
  });
  // On every board answer that covers storefront: the fleet's and the project's.
  f.update("orders_board", (output, input) => {
    if (!isObject(output)) return output;
    const ref = isObject(input) ? input["projectRef"] : undefined;
    if (isObject(ref) && ref["projectId"] !== projectRef.projectId) return output;
    return { ...output, orders: [...list(output["orders"]), card] };
  });
};

const add = (opts: FixtureOptions) => (f: Fixture) => {
  // Ours replace any time answers the kit made, so the order, its pages and its breakdown agree.
  for (const tool of ["time_spans", "time_breakdown", "time_insights", "thread_window"]) f.drop(tool);
  for (const call of timeCalls({ ...opts, projects: projectsOf(f) })) {
    f.answer(call.tool, call.input as JsonObject | undefined, call.outcome.output as JsonValue);
  }
  addOrder(f, opts);
};

/** An empty hub answers with nothing rather than an error: no spans, no time, no findings. */
const none = (f: Fixture) => {
  for (const tool of ["time_spans", "time_breakdown", "time_insights"]) f.drop(tool);
  const coverage = { complete: true, gaps: [] };
  f.answer("time_spans", undefined, { spans: [], coverage });
  f.answer("time_insights", undefined, { insights: [] });
  f.answer("time_breakdown", undefined, {
    wallMs: 0,
    agentMs: 0,
    byCategory: [],
    topCommands: [],
    repeated: [],
    ciChecks: [],
    humanWait: { totalMs: 0, n: 0 },
    retentionDays: 30,
    storedBytes: 0,
    coverage,
  });
};

export default defineGroup({
  extend: {
    empty: none,
    typical: add({}),
    "long-text": add({ gaps: true, long: true }),
    "many-agents": add({ agents: 24 }),
    "time-heavy": add({ dense: true }),
  },
});
