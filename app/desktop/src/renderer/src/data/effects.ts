// Which call results an event makes stale. Events say what changed, rarely enough to redraw it, so each one names
// the reads to refetch; the query layer batches them. Pure, so the mapping is tested on its own.
import { dataField, type HubEvent, type ToolName } from "../../../shared/contracts";

/** Refetch `tool`'s queries, or only those whose input has these top-level values. */
export interface Invalidation {
  readonly tool: ToolName;
  readonly where?: Readonly<Record<string, string>>;
}

export interface EventEffects {
  readonly invalidate: readonly Invalidation[];
  /** The fleet's shape changed (a project came or went, a machine the snapshot didn't have): take a fresh snapshot. */
  readonly resync: boolean;
}

const ORDER_PREFIXES = ["workstream.", "task.", "change.", "claim.", "ask.", "steer.", "train.", "plan."];
const ORDER_TYPES = new Set(["pr.merged", "review.verdict", "lead.started", "lead.woken", "batch.ready"]);
const ASK_TYPES = new Set(["batch.ready", "decision.recorded", "gated.ran"]);
const STATUS_TYPES = new Set(["ci.main", "github.drift", "source.stale", "source.fresh"]);
/** Status's health strip shows machines (online, slept, last seen) and claude usage too. */
const STATUS_PREFIXES = ["machine.", "usage."];
// What changes an order's time, as the GPUI inspector refetched it. thread.* is left out: it fires constantly, and
// the spans it moves arrive with the task and change events that close them.
const TIME_PREFIXES = ["task.", "change.", "ask.", "workstream."];
const TIME_TYPES = new Set(["lead.woken", "pr.merged"]);

/** The orders an event is about: `data.workstreamId`, plus `data.workstreamIds` (a lead woken for several). */
export const ordersNamed = (event: HubEvent): readonly string[] => {
  const one = dataField(event, "workstreamId");
  const data: unknown = event.data;
  const many: unknown = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["workstreamIds"] : undefined;
  const ids = Array.isArray(many) ? many.filter((w): w is string => typeof w === "string") : [];
  return [...new Set(one === undefined ? ids : [one, ...ids])];
};

const startsWithAny = (type: string, prefixes: readonly string[]): boolean => prefixes.some((p) => type.startsWith(p));

/** `machines`: the ones the store knows; a known machine's status change is patched in place, no resync. */
export const effectsOf = (event: HubEvent, machines: Readonly<Record<string, unknown>> = {}): EventEffects => {
  const type = event.type;
  const out: Invalidation[] = [];
  const workstreamId = dataField(event, "workstreamId");
  const orders = ordersNamed(event);
  const shapesOrders = startsWithAny(type, ORDER_PREFIXES) || ORDER_TYPES.has(type);

  if (type.startsWith("ask.") || ASK_TYPES.has(type)) out.push({ tool: "asks_list" });
  if (shapesOrders) {
    out.push({ tool: "orders_board" });
    for (const id of orders) {
      out.push({ tool: "order_get", where: { workstreamId: id } });
      // The order view's brief and claims (done-when).
      if (type.startsWith("workstream.") || type.startsWith("claim.")) out.push({ tool: "workstream_get", where: { workstreamId: id } });
    }
  }
  if (type.startsWith("steer.")) {
    out.push(workstreamId === undefined ? { tool: "steers_list" } : { tool: "steers_list", where: { workstreamId } });
  }
  // Status's per-project rows read the same facts as the status doc.
  if (shapesOrders || STATUS_TYPES.has(type)) out.push({ tool: "status_get" }, { tool: "status_projects" }, { tool: "plan_get" });
  else if (startsWithAny(type, STATUS_PREFIXES)) out.push({ tool: "status_get" }, { tool: "status_projects" });
  // Only the open order's time reads: they are scoped `{ kind: "order", workstreamId }`, matched inside `scope`.
  // time_spans is paged; its view fetches new pages itself, so it is not refetched whole here.
  if (startsWithAny(type, TIME_PREFIXES) || TIME_TYPES.has(type)) {
    for (const id of orders) {
      out.push({ tool: "time_breakdown", where: { workstreamId: id } }, { tool: "time_insights", where: { workstreamId: id } });
    }
  }
  if (type.startsWith("thread.") && event.threadId !== undefined) {
    out.push({ tool: "thread_tail", where: { threadId: event.threadId } });
  }
  const projectScoped = startsWithAny(type, ["workstream.", "lead.", "thread."]);
  if (projectScoped && event.machineId !== undefined && event.projectId !== undefined) {
    out.push({ tool: "project_get", where: { machineId: event.machineId, projectId: event.projectId } });
  }
  if (type === "prompt.changed" || type === "prompt.default_changed") {
    out.push({ tool: "prompts_list" }, { tool: "prompt_get" }, { tool: "session_prompt_get" });
  }
  if (type === "doctor.changed") out.push({ tool: "doctor_list" });
  if (type === "decision.recorded") out.push({ tool: "attention_policy" }, { tool: "decisions_search" });
  if (type.startsWith("usage.") || type === "thread.usage_limited") out.push({ tool: "usage_status" });

  const newMachine = type.startsWith("machine.") && (event.machineId === undefined || !(event.machineId in machines));
  const resync = newMachine || type === "project.added" || type === "project.removed";
  if (resync) out.push({ tool: "projects_list" });
  // Add project's list marks which repos are already projects.
  if (type === "project.added" || type === "project.removed") out.push({ tool: "project_discover" });
  return { invalidate: out, resync };
};

/** Whether a query's input matches an invalidation's `where`, at its top level or inside its `scope`. */
export const matches = (input: unknown, where: Invalidation["where"]): boolean => {
  if (where === undefined) return true;
  if (typeof input !== "object" || input === null) return false;
  const fields = input as Readonly<Record<string, unknown>>;
  const scope: unknown = fields["scope"];
  const scoped = typeof scope === "object" && scope !== null ? (scope as Readonly<Record<string, unknown>>) : {};
  return Object.entries(where).every(([k, v]) => fields[k] === v || scoped[k] === v);
};
