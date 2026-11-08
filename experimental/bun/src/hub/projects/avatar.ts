// A project's or Navi's picture (crates/fleetd/src/hub/projects/avatar.rs). The summary names it by `avatar`, its
// sha256's first 16 hex, so an app fetches its bytes once per picture.
import type { Database } from "bun:sqlite";
import type { ProjectRef } from "../../shared/contracts.ts";

/** The project's picture's id, for its summary. */
export function of(db: Database, r: ProjectRef): string | undefined {
  return (
    db
      .query<{ avatar: string }, [string, string]>("SELECT avatar FROM project_avatars WHERE machine_id = ? AND project_id = ?")
      .get(r.machineId, r.projectId)?.avatar ?? undefined
  );
}
