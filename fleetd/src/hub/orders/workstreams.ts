// The orders' rows, read only (`workstreams_list` and what
// the ledger reads of them). The leads area writes `workstreams`.
import type { Database } from "bun:sqlite";
import type { ProjectRef, Workstream, WorkstreamId, WorkstreamState } from "../../shared/contracts.ts";

/** `W12` → 12; 0 for anything else, as the Rust hub reads it. */
export function workstreamNumber(id: WorkstreamId): number {
  const digits = id.slice(1);
  return /^\+?\d+$/.test(digits) ? Number(digits) : 0;
}

export function workstreamGet(c: Database, id: WorkstreamId): Workstream | undefined {
  const row = c.query<{ data: string }, [number]>("SELECT data FROM workstreams WHERE n = ?").get(workstreamNumber(id));
  return row ? (JSON.parse(row.data) as Workstream) : undefined;
}

export type WorkstreamFilter = { projectRef?: ProjectRef; state?: WorkstreamState; limit: number };

/** Newest first. */
export function workstreamsList(c: Database, filter: WorkstreamFilter): Workstream[] {
  return c
    .query<{ data: string }, Record<string, string | number | null>>(
      `SELECT data FROM workstreams
                 WHERE ($machine IS NULL OR machine_id = $machine) AND ($project IS NULL OR project_id = $project)
                   AND ($state IS NULL OR state = $state)
                 ORDER BY n DESC LIMIT $limit`,
    )
    .all({
      machine: filter.projectRef?.machineId ?? null,
      project: filter.projectRef?.projectId ?? null,
      state: filter.state ?? null,
      limit: filter.limit,
    })
    .map((r) => JSON.parse(r.data) as Workstream);
}

/** The project a workstream belongs to. */
export const projectOf = (c: Database, id: WorkstreamId) => workstreamGet(c, id)?.projectRef;

/** A project's open workstreams, newest first. */
export const openIn = (c: Database, r: ProjectRef, limit: number) =>
  workstreamsList(c, { projectRef: r, state: "open", limit }).map((w) => w.workstreamId);
