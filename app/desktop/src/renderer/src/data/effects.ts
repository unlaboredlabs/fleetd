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

const ORDER_PREFIXES = ["workstream.", "task.", "change.", "request.", "steer.", "plan."];
const ORDER_TYPES = new Set(["pr.merged", "review.verdict", "lead.started", "lead.woken"]);
// A merge made outside the train moves a row's 7-day count.
const STATUS_TYPES = new Set(["ci.main", "source.stale", "source.fresh", "pr.merged_outside"]);
/** Status's health strip shows machines (online, slept, last seen) and claude usage too. */
const STATUS_PREFIXES = ["machine.", "usage."];
// What changes an order's time, as the GPUI inspector refetched it. thread.* is left out: it fires constantly, and
// the spans it moves arrive with the task and change events that close them.
const TIME_PREFIXES = ["task.", "change.", "request.", "workstream."];
const TIME_TYPES = new Set(["lead.woken", "pr.merged"]);
// What moves a PR as the PR screens show it (the hub's list in crates/fleetd-contracts/src/prs.rs): its merge-queue
// state, a review, a merge, its writer's task. Only a new head changes its files and diff, and only the queue sees one.
const PR_PREFIXES = ["change.", "pr.", "review.", "task."];
const PR_DIFF_PREFIXES = ["change.", "pr."];
// The panel's Train reads the project's changes: every move on the train is a change.* or pr.* event.
const TRAIN_PREFIXES = ["change.", "pr."];

/** The orders an event is about: `data.workstreamId`, plus `data.workstreamIds` (a lead woken for several). */
export const ordersNamed = (event: HubEvent): readonly string[] => {
  const one = dataField(event, "workstreamId");
  const data: unknown = event.data;
  const many: unknown = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["workstreamIds"] : undefined;
  const ids = Array.isArray(many) ? many.filter((w): w is string => typeof w === "string") : [];
  return [...new Set(one === undefined ? ids : [one, ...ids])];
};

// What moves the Factory's figures: a merge (the train's, one outside it, a default branch that moved on its host), a
// change's stage stamps, and the person's own acts. The hub folds them into its metrics as they land.
const METRICS_TYPES = new Set(["pr.merged", "pr.merged_outside", "repo.advanced", "change.state", "chat.message", "decision.recorded", "app.presence"]);

const AGENT_PREFIXES = ["task.", "lead.", "change."];
const AGENT_TYPES = new Set(["pr.merged", "project.added", "project.removed"]);

// The Elsewhere group's read (work_list): claims and landings, and the writers and PRs of every project on the repo.
const WORK_PREFIXES = ["work.", "task.", "change."];

const startsWithAny = (type: string, prefixes: readonly string[]): boolean => prefixes.some((p) => type.startsWith(p));

/** `machines`: the ones the store knows; a known machine's status change is patched in place, no resync. */
export const effectsOf = (event: HubEvent, machines: Readonly<Record<string, unknown>> = {}): EventEffects => {
  const type = event.type;
  const out: Invalidation[] = [];
  const orders = ordersNamed(event);
  const shapesOrders = startsWithAny(type, ORDER_PREFIXES) || ORDER_TYPES.has(type);

  // The inline secret and approval items read their state from requests_list: H2 announces every change only as
  // request.opened / request.updated, never as a chat.message for the item.
  if (type.startsWith("request.")) out.push({ tool: "requests_list" });
  if (shapesOrders) {
    out.push({ tool: "orders_board" });
    for (const id of orders) out.push({ tool: "order_get", where: { workstreamId: id } });
  }
  // Only the PR screen on view has these reads mounted, so this refetches one list, one PR and its visible pages.
  if (startsWithAny(type, PR_PREFIXES)) out.push({ tool: "pr_list" }, { tool: "pr_get" });
  if (startsWithAny(type, PR_DIFF_PREFIXES)) out.push({ tool: "pr_files" }, { tool: "pr_diff" });
  if (startsWithAny(type, TRAIN_PREFIXES)) out.push({ tool: "changes_list" });
  // Status's per-project rows read the same facts as the status doc.
  if (shapesOrders || STATUS_TYPES.has(type) || startsWithAny(type, STATUS_PREFIXES)) out.push({ tool: "status_get" });
  // Only the open order's time reads: they are scoped `{ kind: "order", workstreamId }`, matched inside `scope`.
  // time_spans is paged; its view fetches new pages itself, so it is not refetched whole here.
  if (startsWithAny(type, TIME_PREFIXES) || TIME_TYPES.has(type)) {
    for (const id of orders) {
      out.push({ tool: "time_breakdown", where: { workstreamId: id } }, { tool: "time_insights", where: { workstreamId: id } });
    }
  }
  if (METRICS_TYPES.has(type)) out.push({ tool: "metrics_get" });
  if (type.startsWith("thread.") && event.threadId !== undefined) out.push({ tool: "agent_work", where: { threadId: event.threadId } });
  // The agents view's list: who runs, and what for. Their live status and activity come with the live feed instead.
  if (startsWithAny(type, AGENT_PREFIXES) || AGENT_TYPES.has(type)) out.push({ tool: "agents_list" });
  if (startsWithAny(type, WORK_PREFIXES) || AGENT_TYPES.has(type)) out.push({ tool: "work_list" });
  // A chat's agent card that isn't in the live list reads its task by id: read again on that task's own events.
  const taskId = type.startsWith("task.") ? dataField(event, "taskId") : undefined;
  if (taskId !== undefined) out.push({ tool: "task_get", where: { taskId } });
  const projectScoped = startsWithAny(type, ["workstream.", "lead.", "thread."]) || type === "project.settings";
  if (projectScoped && event.machineId !== undefined && event.projectId !== undefined) {
    out.push({ tool: "project_get", where: { machineId: event.machineId, projectId: event.projectId } });
    // Its picture, read again only when it has one (project_avatar_set).
    if (type === "project.settings") out.push({ tool: "project_avatar_get", where: { machineId: event.machineId, projectId: event.projectId } });
  }
  // A linked hub removed from a project: its settings pages read again.
  if (type === "project.settings") out.push({ tool: "hub_links_get" });
  if (type === "prompt.changed" || type === "prompt.default_changed") {
    out.push({ tool: "prompt_get" }, { tool: "session_prompt_get" });
  }
  if (type === "memory.changed") out.push({ tool: "memory_get" });
  // An agent's DM to others, and its receipts as each recipient reads it or is woken: the DM log, its count, the cards.
  if (type === "agent.messaged" || type === "agent.message_updated" || type.startsWith("steer.")) out.push({ tool: "agent_messages" });
  if (type.startsWith("automation.")) out.push({ tool: "automation_list" }, { tool: "automation_runs" });
  // The nightly memory refresh's row: a refresh starting, ending or skipped, its project's switch, the hub's hour, and
  // what a running refresh changed.
  if (type === "memory.refresh" || type === "project.settings" || type === "memory.changed" || type === "decision.recorded") {
    out.push({ tool: "automation_list" });
  }
  // Only the open panel's project has its checklist mounted.
  if (type === "checklist.changed") out.push({ tool: "checklist_get" });
  if (type === "skills.changed") out.push({ tool: "skills_list" });
  // A vault item made, changed, moved or deleted, or used (an audit row): the Vault's lists, the open item and its
  // activity; a card's label shows in Payments too.
  if (type === "vault.changed" || type === "vault.used") out.push({ tool: "vault_list" }, { tool: "vault_get" }, { tool: "vault_audit" });
  if (type === "vault.changed") out.push({ tool: "project_purchases" }, { tool: "vault_status" });
  // An MCP server's sign-in started, finished, failed or ended, or the server was removed: Integrations reads again.
  if (type === "mcp.oauth") out.push({ tool: "mcp_servers_get" });
  // A name published again is a new version: the list, and the open artifact's list of versions.
  if (type === "artifacts.changed") out.push({ tool: "artifacts_list" }, { tool: "artifact_get" });
  // A message may carry a file, which the open Artifacts tab lists.
  if (type === "chat.message") out.push({ tool: "artifacts_list" });
  // Someone invited, joined, renamed, given a role or removed: the Hub group's lists, and whether this person still
  // administers (the sidebar's entry).
  // Setup's People step reads it too.
  if (type === "people.changed") out.push({ tool: "people_list" }, { tool: "hub_info" }, { tool: "setup_list" });
  // Someone's Claude subscription, 1Password token or GitHub connection removed, or a hub link of theirs revoked: their
  // own pages, and People's line of each person's accounts.
  if (type === "people.changed") {
    out.push({ tool: "claude_accounts_get" }, { tool: "onepassword_get" }, { tool: "github_app_get" }, { tool: "hub_links_get" });
  }
  // You pinned or unpinned a chat on another device: this sidebar follows (the hub sends it to your devices only).
  if (type === "chat.pins") out.push({ tool: "chat_pins_get" });
  // You changed your sections of chats on another device: the same.
  if (type === "chat.sections") out.push({ tool: "chat_sections_get" });
  // A device paired: Your devices shows it, and Pair a phone notices it.
  if (type === "key.paired") out.push({ tool: "people_list" });
  // A session started, changed hands, ended or its recording landed: the Sessions view's list reads it again. A
  // recording, once read, never changes.
  if (type === "browser.session" || type === "screen.wait") out.push({ tool: "browser_sessions" });
  // The sidebar's Screens row: one hub-wide count.
  if (type === "browser.session") out.push({ tool: "screens_count" });
  // The hub's setup steps read their status from the doctor's checks.
  if (type === "doctor.changed") out.push({ tool: "doctor_list" }, { tool: "setup_list" });
  // Add machine: a run started, moved a step or ended.
  if (type === "machine_add.step") out.push({ tool: "machine_add_status" });
  // Hub › Machines' roles: a machine coming and going, and a session starting or ending, move its rows.
  if (type.startsWith("machine.") || type === "browser.session") out.push({ tool: "machine_roles" });
  // The hub's attention policy is a global decision. Only the open Decisions tab has its list mounted, so this
  // refetches one read.
  if (type === "decision.recorded" || type === "decision.retired") out.push({ tool: "fleetd_status" }, { tool: "decisions_list" });

  const newMachine = type.startsWith("machine.") && (event.machineId === undefined || !(event.machineId in machines));
  // A repo removed from a project (project.settings) can bring its checkout back as a project of its own.
  // A removed machine goes with its projects (the hub erased them): the snapshot no longer has any of them.
  const resync = newMachine || type === "machine.removed" || type === "project.added" || type === "project.removed" || type === "project.settings";
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
