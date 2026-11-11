// A project's or Navi's picture: what its chat shows in place of its
// letters. The app uploads the picture as it was picked (attachment_put) and names the square to keep; the hub
// decodes it (png, jpeg or webp), turns it as its EXIF says, crops it, shrinks it to at most AVATAR_PX a side and keeps
// that alone, re-encoded as JPEG: none of the original's metadata is kept, and the upload is forgotten at once. The
// summary names it by `avatar`, its sha256's first 16 hex, so an app fetches its bytes once per picture.
import type { Database } from "bun:sqlite";
import type { AvatarCrop, ProjectAvatarSetInput, ProjectRef, ProjectSummary } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { unknownProject } from "../api/refusals.ts";
import type { Caller } from "../api/registry.ts";
import { take } from "../intake/attachments.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import type { RenderReply, RenderRequest } from "./avatar-worker.ts";

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

/** The kept picture's JPEG, as rendered; undefined with none. */
export function jpegOf(db: Database, r: ProjectRef): Uint8Array | undefined {
  return (
    db
      .query<{ jpeg: Uint8Array }, [string, string]>("SELECT jpeg FROM project_avatars WHERE machine_id = ?1 AND project_id = ?2")
      .get(r.machineId, r.projectId)?.jpeg ?? undefined
  );
}

/** Keeps a rendered JPEG as the project's picture, or none; returns its id. The caller says so in an event. */
export function keep(hub: Hub, r: ProjectRef, jpeg: Uint8Array | undefined): string | undefined {
  if (jpeg === undefined) {
    hub.db.conn.query("DELETE FROM project_avatars WHERE machine_id = ?1 AND project_id = ?2").run(r.machineId, r.projectId);
    return undefined;
  }
  const kept = new Bun.CryptoHasher("sha256").update(jpeg).digest("hex").slice(0, 16);
  hub.db.conn
    .query(
      `INSERT INTO project_avatars (machine_id, project_id, avatar, jpeg, set_ms) VALUES (?1, ?2, ?3, ?4, ?5)
                   ON CONFLICT (machine_id, project_id) DO UPDATE SET avatar = excluded.avatar, jpeg = excluded.jpeg,
                     set_ms = excluded.set_ms`,
    )
    .run(r.machineId, r.projectId, kept, jpeg, hub.clock.now());
  return kept;
}

export { AVATAR_MAX_BYTES, AVATAR_PX, square } from "./avatar-render.ts";

/**
 * From source, the worker file beside this one. In a `bun build --compile` binary, which embeds it as an entry point
 * of its own (package.json `compile`, built with `--root .`), its path from the build's root.
 */
const WORKER = Bun.main.startsWith("/$bunfs/")
  ? "./src/hub/projects/avatar-worker.ts"
  : new URL("./avatar-worker.ts", import.meta.url).href;

/** avatar-render.ts `render`, on a worker of its own: a photo's decode never stalls the hub. */
export function render(bytes: Uint8Array, crop: AvatarCrop | undefined): Promise<Uint8Array> {
  const worker = new Worker(WORKER);
  return new Promise<Uint8Array>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<RenderReply>) => {
      const reply = event.data;
      if ("jpeg" in reply) resolve(reply.jpeg);
      else reject(reply.invalid ? new ToolError("invalid", reply.message, reply.fix) : new Error(`avatar render: ${reply.message}`));
    };
    worker.onerror = (event) => reject(new Error(`avatar render worker: ${event.message}`));
    worker.postMessage({ bytes, ...(crop ? { crop } : {}) } satisfies RenderRequest);
  }).finally(() => worker.terminate());
}

/**
 * `project_avatar_set` (avatar.rs `set`): the uploaded picture rendered and kept, its upload forgotten at once; no
 * attachment removes the picture. Either way a `project.settings` event sends every open app back for a snapshot.
 */
export async function set(hub: Hub, caller: Caller, input: ProjectAvatarSetInput): Promise<{ project: ProjectSummary }> {
  const r = { machineId: input.machineId, projectId: input.projectId };
  requireRole(caller, "operate", r.machineId);
  if (!store(hub).projectGet(r)) throw unknownProject(r);
  let kept: string | undefined;
  if (input.attachmentId !== undefined) {
    const { bytes } = await take(hub, caller, input.attachmentId);
    kept = keep(hub, r, await render(bytes, input.crop));
  } else {
    keep(hub, r, undefined);
  }
  const project = store(hub).projectGet(r);
  if (!project) throw unknownProject(r);
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "project.settings",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: kept !== undefined ? `${project.title} has a new picture` : `${project.title}'s picture removed`,
    data: { avatar: kept ?? null },
  });
  return { project };
}
