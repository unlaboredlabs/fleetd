// The ledger's MCP tools (decisions_search, decisions_record, and the app's decisions_list and decisions_overturn)
// and its lead calls (decide, decisions_search).
import type { Database } from "bun:sqlite";
import type { Decision, DecisionOrder, DecisionScope, ProjectRef, WorkstreamId } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { leadWakes } from "../api/leads.ts";
import { allowsEverywhere, requireHuman, unknownProject } from "../api/refusals.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { openIn, projectOf, workstreamGet } from "../orders/workstreams.ts";
import { store } from "../store/hub_store.ts";
import { decisions } from "./decisions.ts";
import { type Actor, decisionN } from "./repo.ts";
import { GLOBAL_REFUSED, NO_MATCH, overturnLine, overturnedNext, recordedNext, SEARCH_LIMIT, unknownWorkstream } from "./rules.ts";


/** Who a decision written with this key comes from: the human for a human key (a person's device), else the agent. */
function actorOf(caller: Caller): Actor {
  return isHuman(caller)
    ? { source: "human", by: `human:${caller.name}`, ...(caller.person ? { person: caller.person } : {}) }
    : { source: "agent", by: caller.name };
}


/** The project a decision scope belongs to: undefined for global, a not_found for an unknown workstream. */
function decisionProject(c: Database, scope: DecisionScope): ProjectRef | undefined {
  switch (scope.kind) {
    case "global":
      return undefined;
    case "project":
      return scope.projectRef;
    case "workstream": {
      const r = projectOf(c, scope.workstreamId);
      if (!r) throw unknownWorkstream(scope.workstreamId);
      return r;
    }
  }
}

function canReadDecision(hub: Hub, caller: Caller, decision: Decision): boolean {
  let r: ProjectRef | undefined;
  try {
    r = decisionProject(hub.db.conn, decision.scope);
  } catch {
    return false;
  }
  return r === undefined || allows(caller, "read", r.machineId);
}


export function register(tools: Registry): void {
  tools.add("decisions_search", (hub, caller, input) => {
    if (input.scope) {
      const r = decisionProject(hub.db.conn, input.scope);
      if (r) requireRole(caller, "read", r.machineId);
    }
    const found = decisions(hub).search(input.query, {
      ...(input.scope ? { scope: input.scope } : {}),
      limit: input.limit ?? 10,
    });
    const visible = found.filter((d) => canReadDecision(hub, caller, d));
    return {
      decisions: visible,
      ...(visible.length === 0 ? { next: NO_MATCH } : {}),
    };
  });

  tools.add("decisions_record", (hub, caller, input) => {
    const project = decisionProject(hub.db.conn, input.scope);
    if (input.scope.kind === "global") {
      if (!allowsEverywhere(caller, "operate")) {
        throw new ToolError(
          "forbidden",
          GLOBAL_REFUSED,
          "Record it at project scope, or use a key with an operate grant on * machines.",
        );
      }
    } else if (project) {
      requireRole(caller, "operate", project.machineId);
      if (input.scope.kind === "project" && !store(hub).projectGet(project)) throw unknownProject(project);
    }
    const decision = decisions(hub).record(
      {
        key: input.key,
        scope: input.scope,
        value: input.value,
        ...(input.why !== undefined ? { why: input.why } : {}),
        ...(project ? { projectRef: project } : {}),
      },
      actorOf(caller),
    );
    return { decision, next: recordedNext(decision) };
  });

  tools.add("decisions_list", (hub, caller, input) => {
    const r = input.projectRef;
    requireRole(caller, "read", r.machineId);
    if (!store(hub).projectGet(r)) throw unknownProject(r);
    const limit = input.limit ?? 50;
    const found = decisions(hub).history(r, limit);
    const orders: DecisionOrder[] = [];
    for (const d of found) {
      if (d.scope.kind !== "workstream") continue;
      const id = d.scope.workstreamId;
      if (orders.some((o) => o.workstreamId === id)) continue;
      const w = workstreamGet(hub.db.conn, id);
      if (w) orders.push({ workstreamId: w.workstreamId, title: w.title });
    }
    return { decisions: found, orders, ...(found.length >= limit ? { truncated: true } : {}) };
  });

  // A person's revoke or new value. Never an agent's key: agents and leads record decisions, only a person overturns
  // one. The project's lead reads the change with its next wake.
  tools.add("decisions_overturn", (hub, caller, input) => {
    requireHuman(caller, "decisions_overturn");
    const id = input.decisionId;
    const old = decisions(hub).get(id);
    if (!old || !canReadDecision(hub, caller, old)) {
      throw new ToolError("not_found", `No decision ${id}.`, "Call decisions_list for the project's decisions.");
    }
    const project = decisionProject(hub.db.conn, old.scope);
    if (project) requireRole(caller, "operate", project.machineId);
    else if (!allowsEverywhere(caller, "operate")) {
      throw new ToolError("forbidden", GLOBAL_REFUSED, "Use a key with an operate grant on * machines.");
    }
    const done = decisions(hub).overturn(id, input.value, input.why, project, actorOf(caller));
    if (project) {
      leadWakes(hub).trigger(project, { kind: "line", line: "quiet", text: overturnLine(id, old, input.why, done.replacement) });
    }
    return {
      overturned: done.overturned,
      ...(done.replacement ? { decision: done.replacement } : {}),
      next: overturnedNext(old, done.replacement),
    };
  });
}

/** `fleetd decide`'s call (lead_calls.rs `DecideCall`). */
export type DecideCall = {
  key: string;
  value: string;
  why?: string;
  /** Default workstream. */
  scope?: "project" | "workstream";
  workstreamId?: WorkstreamId;
};

/** `fleetd decisions search`'s call. */
export type DecisionsSearchCall = { query: string };

/** A workstream named in a call must be one of the caller's own. */
function ownWorkstream(c: Database, r: ProjectRef, id: WorkstreamId): WorkstreamId {
  const owner = projectOf(c, id);
  if (owner && owner.machineId === r.machineId && owner.projectId === r.projectId) return id;
  throw new ToolError(
    "not_found",
    `There is no workstream ${id} in your project.`,
    "Use a workstream id from the digest at the top of your last wake.",
  );
}

/** `fleetd decide` without --workstream: the project's only open workstream, else the caller must say. */
function decideWorkstream(c: Database, r: ProjectRef, id: WorkstreamId | undefined): WorkstreamId {
  if (id !== undefined) return ownWorkstream(c, r, id);
  const open = openIn(c, r, 2);
  if (open.length === 1) return open[0] as WorkstreamId;
  throw new ToolError(
    "invalid",
    open.length === 0
      ? "Your project has no open workstream to scope this decision to."
      : "Your project has several open workstreams.",
    "Pass workstreamId W<n> from your digest, or scope project for a project-wide decision.",
  );
}

/**
 * The lead-side `decide` for a caller already attributed to `r` by its cwd, with `by` = `lead:<machineId>/<projectId>`.
 */
export function decide(hub: Hub, r: ProjectRef, by: string, call: DecideCall): { decision: Decision } {
  const scope: DecisionScope =
    call.scope === "project"
      ? { kind: "project", projectRef: r }
      : { kind: "workstream", workstreamId: decideWorkstream(hub.db.conn, r, call.workstreamId) };
  const decision = decisions(hub).record(
    { key: call.key, scope, value: call.value, ...(call.why !== undefined ? { why: call.why } : {}), projectRef: r },
    { source: "lead", by },
  );
  return { decision };
}

/** The lead-side `decisions_search`: within the project's chain, or one decision by its id. */
export function decisionsSearch(hub: Hub, r: ProjectRef, call: DecisionsSearchCall): { decisions: Decision[] } {
  const query = call.query.trim();
  if (decisionN(query) !== undefined) {
    const decision = decisions(hub).getIn(query, r);
    if (!decision) {
      if (decisions(hub).get(query)) {
        throw new ToolError(
          "forbidden",
          `${query} is another project's decision.`,
          "Search this project's decisions; ask your lead about another project's.",
        );
      }
      throw new ToolError("not_found", `No decision ${query}.`);
    }
    return { decisions: [decision] };
  }
  return { decisions: decisions(hub).search(call.query, { chain: { projectRef: r }, limit: SEARCH_LIMIT }) };
}
