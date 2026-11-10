// How a Navi's risky actions are approved, and what ran without asking. The
// checker's turn itself comes with the approvals hooks.
import type { Database } from "bun:sqlite";
import type { AutoApproved, NaviApprovalMode, NaviApprovals, ProjectRef } from "../../shared/contracts.ts";

export const CHECKER_MODEL = "claude-sonnet-5-5";
export const CHECKER_EFFORT = "medium";
export const AUTO_APPROVED_MAX = 200;
const MODES: NaviApprovalMode[] = ["ask", "checker", "yolo"];
/**
 * What a project starts in (W588): nothing asks. Stored when it is made, by `startNew`; a project with no row, made
 * before that, still asks its checker.
 */
export const NEW_PROJECT_MODE: NaviApprovalMode = "yolo";

export function approvals(c: Database, r: ProjectRef): NaviApprovals {
  const mode = c.query<{ mode: string }, [string, string]>("SELECT mode FROM navi_approvals WHERE machine_id = ? AND project_id = ?").get(r.machineId, r.projectId)?.mode;
  return {
    mode: MODES.find((m) => m === mode) ?? "checker",
    defaults: true,
    model: CHECKER_MODEL,
    effort: CHECKER_EFFORT,
  } as NaviApprovals;
}

export function setApprovals(c: Database, r: ProjectRef, mode: NaviApprovalMode): void {
  c.query(
    `INSERT INTO navi_approvals (machine_id, project_id, mode) VALUES (?, ?, ?)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET mode = excluded.mode`,
  ).run(r.machineId, r.projectId, mode);
}

/** A project just made starts in `NEW_PROJECT_MODE`; one that has a mode already keeps it. */
export function startNew(c: Database, r: ProjectRef): void {
  c.query("INSERT INTO navi_approvals (machine_id, project_id, mode) VALUES (?, ?, ?) ON CONFLICT (machine_id, project_id) DO NOTHING").run(
    r.machineId,
    r.projectId,
    NEW_PROJECT_MODE,
  );
}

/** The actions the Navi ran without asking, newest first. */
export function log(c: Database, r: ProjectRef): AutoApproved[] {
  return c
    .query<{ data: string }, [string, string, number]>(
      "SELECT data FROM navi_auto_approved WHERE machine_id = ? AND project_id = ? ORDER BY n DESC LIMIT ?",
    )
    .all(r.machineId, r.projectId, AUTO_APPROVED_MAX)
    .flatMap((row) => {
      try {
        return [JSON.parse(row.data) as AutoApproved];
      } catch {
        return [];
      }
    });
}
