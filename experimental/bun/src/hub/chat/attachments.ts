// The attachment rows a chat reads (crates/fleetd/src/hub/intake/attachments.rs `show`, `of_chat`): the same SQL
// against the intake area's `attachments` table.
import type { Database } from "bun:sqlite";
import type { AttachmentMime, ChatFile, ChatPart, ProjectRef } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs } from "../store/time.ts";

export const CHAT_FILES_LISTED = 200;

const leadBy = (r: ProjectRef) => `lead:${r.machineId}/${r.projectId}`;
const isImage = (mime: string) => mime.startsWith("image/");

/**
 * A final lead message's parts, each `image`, `clip` or `file` block checked against project `r`: one whose attachment
 * is the project's stays, with the file's name, type and size filled in, and marks the file the project's; any other
 * shows as its text. An `image` block of a file that isn't an image shows as a `file` block.
 */
export function show(c: Database, r: ProjectRef, parts: ChatPart[] | undefined): ChatPart[] | undefined {
  if (!parts) return undefined;
  const key = `${r.machineId}/${r.projectId}`;
  const out: ChatPart[] = [];
  for (const original of parts) {
    const part: ChatPart = { ...original };
    const block = part.block as (Record<string, unknown> & { kind: string }) | undefined;
    if (block && (block.kind === "image" || block.kind === "clip" || block.kind === "file")) {
      const n = Number.parseInt(String(block.attachmentId ?? "").slice(1), 10) || 0;
      const row = c
        .query<{ name: string; mime: string; bytes: number }, [number, string, string, string, string]>(
          `SELECT a.name, a.mime, a.bytes FROM attachments a
           LEFT JOIN workstreams w ON w.n = CAST(substr(a.workstream_id, 2) AS INTEGER)
           WHERE a.n = ?1 AND (a.project = ?2 OR (a.project IS NULL AND a.by = ?3)
             OR (w.machine_id = ?4 AND w.project_id = ?5))`,
        )
        .get(n, key, leadBy(r), r.machineId, r.projectId);
      if (row) {
        c.query("UPDATE attachments SET project = ?1 WHERE n = ?2 AND project IS NULL").run(key, n);
        const next: Record<string, unknown> = { ...block, name: row.name || "file", mime: row.mime as AttachmentMime, bytes: row.bytes };
        if (block.kind === "image" && !isImage(row.mime)) next.kind = "file";
        part.block = next as ChatPart["block"];
      } else {
        delete part.block;
      }
    }
    out.push(part);
  }
  if (out.length === 1 && (out[0] as ChatPart).block === undefined) return undefined;
  return out;
}

/** The files sent in the project's chat or to its orders, newest first. */
export function ofChat(db: HubDb, r: ProjectRef): ChatFile[] {
  const key = `${r.machineId}/${r.projectId}`;
  return db
    .all<{ n: number; name: string; mime: string; bytes: number; created_ms: number }>(
      `SELECT a.n, a.name, a.mime, a.bytes, a.created_ms FROM attachments a
       LEFT JOIN workstreams w ON w.n = CAST(substr(a.workstream_id, 2) AS INTEGER)
       WHERE a.project = ?1 OR (w.machine_id = ?2 AND w.project_id = ?3)
       ORDER BY a.created_ms DESC, a.n DESC LIMIT ?4`,
      [key, r.machineId, r.projectId, CHAT_FILES_LISTED],
    )
    .map((row) => ({
      attachmentId: `F${row.n}`,
      name: row.name || "file",
      mime: row.mime as AttachmentMime,
      bytes: row.bytes,
      at: isoMs(row.created_ms),
    }));
}
