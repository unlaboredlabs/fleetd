// How a project's risky actions are approved, and what ran without asking. The
// checker's turn itself comes with the approvals hooks.
import type { Database } from "bun:sqlite";
import type { AutoApproved, ApprovalMode, ProjectApprovals, ProjectRef } from "../../shared/contracts.ts";
import { AUTO_APPROVED_MAX, CHECKER_EFFORT, CHECKER_MODEL, NEW_PROJECT_MODE } from "./checker_modes.ts";

export { AUTO_APPROVED_MAX, CHECKER_EFFORT, CHECKER_MODEL, NEW_PROJECT_MODE } from "./checker_modes.ts";

const MODES: ApprovalMode[] = ["ask", "checker", "yolo"];

export function approvals(c: Database, r: ProjectRef): ProjectApprovals {
  const mode = c.query<{ mode: string }, [string, string]>("SELECT mode FROM project_approvals WHERE machine_id = ? AND project_id = ?").get(r.machineId, r.projectId)?.mode;
  return {
    mode: MODES.find((m) => m === mode) ?? "checker",
    defaults: true,
    model: CHECKER_MODEL,
    effort: CHECKER_EFFORT,
  } as ProjectApprovals;
}

export function setApprovals(c: Database, r: ProjectRef, mode: ApprovalMode): void {
  c.query(
    `INSERT INTO project_approvals (machine_id, project_id, mode) VALUES (?, ?, ?)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET mode = excluded.mode`,
  ).run(r.machineId, r.projectId, mode);
}

/** A project just made starts in `NEW_PROJECT_MODE`; one that has a mode already keeps it. */
export function startNew(c: Database, r: ProjectRef): void {
  c.query("INSERT INTO project_approvals (machine_id, project_id, mode) VALUES (?, ?, ?) ON CONFLICT (machine_id, project_id) DO NOTHING").run(
    r.machineId,
    r.projectId,
    NEW_PROJECT_MODE,
  );
}

/**
 * The actions the project ran without asking, newest first: `limit` of them (`AUTO_APPROVED_MAX` when absent, as older
 * apps read it), older than the row `before` when given. `older` is the cursor for the next page, absent once this one
 * reaches the oldest; `total` counts the whole log.
 */
export function log(c: Database, r: ProjectRef, page: { limit?: number; before?: number } = {}): { log: AutoApproved[]; older?: number; total: number } {
  const limit = Math.min(Math.max(page.limit ?? AUTO_APPROVED_MAX, 1), AUTO_APPROVED_MAX);
  const rows = c
    .query<{ n: number; data: string }, [string, string, number, number]>(
      "SELECT n, data FROM project_auto_approved WHERE machine_id = ? AND project_id = ? AND n < ? ORDER BY n DESC LIMIT ?",
    )
    .all(r.machineId, r.projectId, page.before ?? Number.MAX_SAFE_INTEGER, limit + 1);
  const total = c
    .query<{ total: number }, [string, string]>("SELECT COUNT(*) AS total FROM project_auto_approved WHERE machine_id = ? AND project_id = ?")
    .get(r.machineId, r.projectId)?.total ?? 0;
  const shown = rows.slice(0, limit);
  const entries = shown.flatMap((row) => {
    try {
      return [JSON.parse(row.data) as AutoApproved];
    } catch {
      return [];
    }
  });
  const last = shown[shown.length - 1];
  return { log: entries, ...(rows.length > limit && last !== undefined ? { older: last.n } : {}), total };
}
