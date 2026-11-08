// What the leads area reads from the rest of the hub (crates/fleetd/src/hub/leads/ports.rs, hooks.rs, wiring.rs): the
// executor's launch and send, the node's one-lead mode, open requests and decisions, and the hooks of later areas
// (tasks, usage, train, work). Launch and send stay Rust's `Unwired` until the leads start sets them on
// `leadWiring(hub)` (wiring.ts); the reads are wired to the stores they read.
import type { Decision, HumanRequest, ProjectRef, ThreadRef, UsageParked } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { listDecisions } from "../ledger/repo.ts";
import { ChangeRecords } from "../train/records.ts";
import type { AgentsLine } from "./events.ts";

/** One lead launch (hub/executor `LaunchInput`), the parts the leads area fills in. */
export type LaunchInput = {
  projectId: string;
  prompt: string;
  systemPrompt?: string;
  profile: string;
  runtimeMode: "approval-required" | "full-access";
  title?: string;
  clientRequestId: string;
};

export type SessionRole = "lead" | "assistant";

export type LeadPorts = {
  launch(machineId: string, input: LaunchInput, role: SessionRole): Promise<string>;
  /** Sends `message` to the thread, through the offline write queue: true when it was queued for the machine. */
  send(thread: ThreadRef, message: string, clientRequestId: string): Promise<boolean>;
  oneLeadMode(machineId: string): boolean;
};

/** The hooks of later areas (hooks.rs `LeadHooks`), each absent until its area sets it. */
export type LeadHooks = {
  /** The tasks area: the digest's Agents lines, the agents line, live tasks, cancel, an order's leftovers. */
  tasks?: {
    digestLines(r: ProjectRef, since: string | undefined, limit: number): string[];
    agents(r: ProjectRef): AgentsLine;
    cancel(r: ProjectRef, taskId: string, reason: string): Promise<void>;
    leftovers(r: ProjectRef, workstreamId: string): string[];
    /** Live tasks (of `r`, or every project's). */
    live?(r: ProjectRef | undefined): { taskId: string; projectRef: ProjectRef }[];
    /** Live tasks that work in a repo of their project. */
    liveInRepos?(): { taskId: string; projectRef: ProjectRef; repoId: string }[];
  };
  /** The usage layer: the pause on the project's machine, a thread's park and hold, and when a hold clears. */
  usageGate?(r: ProjectRef): string | undefined;
  parkedOf?(thread: ThreadRef): UsageParked | undefined;
  usageHold?(thread: ThreadRef): string | undefined;
  whenClear?(thread: ThreadRef): Promise<void>;
  /** The train's digest lines, and the work area's Elsewhere lines. */
  trainLines?(r: ProjectRef, since: string | undefined): string[] | undefined;
  elsewhere?(r: ProjectRef): string[] | undefined;
};

const unwired = (what: string) => new ToolError("failed", `${what} is not wired in this hub yet.`);

export type LeadWiring = { ports: LeadPorts; hooks: LeadHooks };

/** The leads area's ports and hooks: other areas set theirs when they start. */
export const leadWiring = (hub: Hub) =>
  hub.area<LeadWiring>("lead_wiring", () => ({
    ports: {
      launch: async () => {
        throw unwired("Launching a lead thread");
      },
      send: async () => {
        throw unwired("Sending to a lead thread");
      },
      oneLeadMode: () => false,
    },
    hooks: {},
  }));

/** The project's open secret and approval requests, newest first (approvals/store.rs `list`). */
export function openRequests(hub: Hub, r: ProjectRef | undefined, limit: number): HumanRequest[] {
  return hub.db
    .all<{ data: string }>(
      `SELECT data FROM requests
       WHERE (?1 IS NULL OR project_key = ?1)
         AND (?2 IS NULL OR state IN (SELECT value FROM json_each(?2)))
         AND (?3 IS NULL OR kind = ?3)
       ORDER BY n DESC LIMIT ?4`,
      [r ? `${r.machineId}/${r.projectId}` : null, JSON.stringify(["open"]), null, Math.max(limit, 1)],
    )
    .map((row) => JSON.parse(row.data) as HumanRequest);
}

/** Global, project and every workstream-scoped decision in the project. */
export const decisionsInProject = (hub: Hub, r: ProjectRef, limit: number): Decision[] =>
  listDecisions(hub.db.conn, { chain: { projectRef: r }, limit });

/** The decisions scoped to one workstream. */
export const decisionsOfWorkstream = (hub: Hub, workstreamId: string, limit: number): Decision[] =>
  listDecisions(hub.db.conn, { scope: { kind: "workstream", workstreamId }, limit });

/** An order's PRs still in the train: `#<n> <state>` (hooks.rs `unlanded`). */
export const unlanded = (hub: Hub, r: ProjectRef, workstreamId: string): string[] =>
  new ChangeRecords(hub.db).unlanded(r, workstreamId).map((c) => `#${c.prNumber} ${c.state}`);

