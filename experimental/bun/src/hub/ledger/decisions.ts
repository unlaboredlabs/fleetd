// The keyed decision log, scoped workstream → project → global (crates/fleetd/src/hub/ledger/decisions.rs). A lead
// asks a person in chat and logs the answer here with `decide`, which is how it never asks twice. Every write runs
// in one BEGIN IMMEDIATE transaction that a refusal rolls back; events are appended after the commit.
import type { Decision, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { events, type NewEvent } from "../store/events.ts";
import { isoMs } from "../store/time.ts";
import * as repo from "./repo.ts";

/** An event's machine and project, for decisions that have one. */
const projectFields = (r: ProjectRef | undefined) => (r ? { machineId: r.machineId, projectId: r.projectId } : {});

/** The `decision.recorded` event; `project` names the project of a workstream-scoped decision. */
export function recordedEvent(decision: Decision, project: ProjectRef | undefined): NewEvent {
  const projectRef = decision.scope.kind === "project" ? decision.scope.projectRef : project;
  const data: Record<string, unknown> = {
    decisionId: decision.decisionId,
    key: decision.key,
    scope: decision.scope,
    source: decision.source,
  };
  if (decision.supersedes !== undefined) data.supersedes = decision.supersedes;
  return {
    at: decision.at,
    type: "decision.recorded",
    ...projectFields(projectRef),
    summary: `${decision.decisionId} ${decision.key} = ${decision.value}`,
    data,
  };
}

/** The `decision.retired` event: a person revoked the decision, and its key goes unanswered again. */
export function retiredEvent(decision: Decision, project: ProjectRef | undefined): NewEvent {
  return {
    at: decision.retired?.at ?? decision.at,
    type: "decision.retired",
    ...projectFields(project),
    summary: `${decision.decisionId} ${decision.key} revoked`,
    data: { decisionId: decision.decisionId, key: decision.key, scope: decision.scope },
  };
}

/** What `overturn` did: the decision taken back, and the one that replaced it, if any. */
export type Overturned = { overturned: Decision; replacement?: Decision };

/** The hub's decisions, `hub.area("decisions")`. */
export const decisions = (hub: Hub) => hub.area("decisions", (h) => new Decisions(h));

export class Decisions {
  constructor(private readonly hub: Hub) {}

  /** Appends after a commit. A failed append is logged: the write it announces already happened. */
  private emit(event: NewEvent): void {
    try {
      events(this.hub).append(event);
    } catch (error) {
      console.error("ledger event append failed:", error);
    }
  }

  /** Writes an active decision; an active one on the same key and scope becomes superseded. */
  record(input: repo.RecordInput, actor: repo.Actor): Decision {
    const now = this.hub.clock.now();
    const decision = this.hub.db.transaction((db) => repo.recordDecision(db, input, actor, now));
    this.emit(recordedEvent(decision, input.projectRef));
    return decision;
  }

  /**
   * A person overturns an active decision in one write: with `value`, a new decision on its key and scope supersedes
   * it; without, it is retired with who and why. `project` is the decision's project.
   */
  overturn(decisionId: string, value: string | undefined, why: string, project: ProjectRef | undefined, actor: repo.Actor): Overturned {
    const now = this.hub.clock.now();
    const done = this.hub.db.transaction((db): Overturned => {
      const old = repo.getDecision(db, decisionId);
      if (!old) throw new ToolError("not_found", `No decision ${decisionId}.`);
      if (old.state !== "active") {
        throw new ToolError("invalid", `${decisionId} is already ${old.state}.`, "Overturn the decision that answers its key now.");
      }
      if (value === undefined) {
        const retired = { by: actor.by, ...(actor.person ? { person: actor.person } : {}), at: isoMs(now), why };
        return { overturned: repo.retireDecision(db, decisionId, retired) };
      }
      const input: repo.RecordInput = { key: old.key, scope: old.scope, value, why, ...(project ? { projectRef: project } : {}) };
      const replacement = repo.recordDecision(db, input, actor, now);
      return { overturned: repo.getDecision(db, decisionId) as Decision, replacement };
    });
    this.emit(done.replacement ? recordedEvent(done.replacement, project) : retiredEvent(done.overturned, project));
    return done;
  }

  /** The project's project- and workstream-scoped decisions in every state, newest first. */
  history(r: ProjectRef, limit: number): Decision[] {
    return repo.historyInProject(this.hub.db.conn, r, limit);
  }

  get(decisionId: string): Decision | undefined {
    return repo.getDecision(this.hub.db.conn, decisionId);
  }

  /** The decision when it is global or `r`'s; another project's reads as undefined. */
  getIn(decisionId: string, r: ProjectRef): Decision | undefined {
    return repo.getDecisionIn(this.hub.db.conn, decisionId, r);
  }

  /**
   * The decisions `text` cites, oldest first: by id (`D12`), when global or the project's, and the active ones in the
   * project's chain by dotted key (`api.health.path`).
   */
  cited(r: ProjectRef, text: string): Decision[] {
    const words = text
      .split(/[^A-Za-z0-9._-]+/)
      .map((w) => w.replace(/\.+$/, ""))
      .filter((w) => w !== "");
    const cited: Decision[] = [];
    for (const id of words.filter((w) => repo.decisionN(w) !== undefined)) {
      const decision = this.getIn(id, r);
      if (decision) cited.push(decision);
    }
    const active = this.list({ chain: { projectRef: r }, limit: 500 });
    cited.push(...active.filter((d) => d.key.includes(".") && words.includes(d.key)));
    cited.sort((a, b) => (repo.decisionN(a.decisionId) ?? 0) - (repo.decisionN(b.decisionId) ?? 0));
    return cited.filter((d, i) => i === 0 || cited[i - 1]?.decisionId !== d.decisionId);
  }

  /** FTS5 over key, value and why; best match first, active only. */
  search(query: string, filter: repo.DecisionFilter): Decision[] {
    return repo.searchDecisions(this.hub.db.conn, query, filter);
  }

  /** Active decisions, newest first. */
  list(filter: repo.DecisionFilter): Decision[] {
    return repo.listDecisions(this.hub.db.conn, filter);
  }

  /** The trimmed value of the active global decision on `key` (`policy.tz`, `policy.quiet_hours`, ...). */
  globalValue(key: string): string | undefined {
    return this.list({ scope: { kind: "global" }, limit: 500 })
      .find((d) => d.key === key)
      ?.value.trim();
  }
}
