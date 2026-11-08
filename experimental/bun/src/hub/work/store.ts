// What the hub binds a project's work to (crates/fleetd/src/hub/work/store.rs): `work_projects`, the repo and base
// its work lands on.
import type { Database } from "bun:sqlite";
import type { ProjectRef, RepoKey } from "../../shared/contracts.ts";

/** The repo and base a project's work lands on. */
export type WorkScope = { repoKey: RepoKey; base: string };

export function scopeOf(db: Database, project: ProjectRef): WorkScope | undefined {
  const row = db
    .query<{ repo_key: string; base: string }, [string, string]>(
      "SELECT repo_key, base FROM work_projects WHERE machine_id = ? AND project_id = ?",
    )
    .get(project.machineId, project.projectId);
  return row ? { repoKey: row.repo_key, base: row.base } : undefined;
}
