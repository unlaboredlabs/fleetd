// A project's or Navi's picture (crates/fleetd/src/hub/projects/avatar.rs). The summary names it by `avatar`, its
// sha256's first 16 hex, so an app fetches its bytes once per picture.
import type { Database } from "bun:sqlite";
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";

/** The project's picture's id, for its summary. */
export function of(db: Database, r: ProjectRef): string | undefined {
  return (
    db
      .query<{ avatar: string }, [string, string]>("SELECT avatar FROM project_avatars WHERE machine_id = ? AND project_id = ?")
      .get(r.machineId, r.projectId)?.avatar ?? undefined
  );
}

/** `project_avatar_get`: the kept picture's JPEG. */
export function get(db: Database, r: ProjectRef): { avatar: string; mime: "image/jpeg"; dataB64: string } {
  const kept = db
    .query<{ avatar: string; jpeg: Uint8Array }, [string, string]>(
      "SELECT avatar, jpeg FROM project_avatars WHERE machine_id = ?1 AND project_id = ?2",
    )
    .get(r.machineId, r.projectId);
  if (!kept) {
    throw new ToolError("not_found", `${r.projectId} on ${r.machineId} has no picture.`, "Its letters show; project_avatar_set gives it one.");
  }
  return { avatar: kept.avatar, mime: "image/jpeg", dataB64: Buffer.from(kept.jpeg).toString("base64") };
}
