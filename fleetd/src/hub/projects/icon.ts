// A project's or Navi's built-in icon: a glass being's face on a field of a
// color, which its chat shows when it has no picture. One a person never picked is derived from its id, so each looks
// the same on every app and every launch.
import type { Database } from "bun:sqlite";
import type { ProjectIcon, ProjectRef, ProjectSummary } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { unknownProject } from "../api/refusals.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";

/** IconFace::ALL and IconColor::ALL, in the Rust contracts' order: the derived icon indexes them. */
const FACES = ["mo", "wee", "peep", "nap", "cy", "wink", "joy", "huh", "wow"] as const;
const COLORS = ["fleet", "sky", "teal", "mint", "lime", "sun", "ember", "rose", "plum", "lilac", "sand", "graphite"] as const;

/** The icon a project wears until a person picks one: from the first eight bytes of its ref's sha256. */
export function derived(r: ProjectRef): ProjectIcon {
  const digest = new Bun.CryptoHasher("sha256").update(`${r.machineId}/${r.projectId}`).digest();
  const n = digest.readBigUInt64BE(0);
  const faces = BigInt(FACES.length);
  return {
    face: FACES[Number(n % faces)] as string,
    color: COLORS[Number((n / faces) % BigInt(COLORS.length))] as string,
  };
}

/** The project's icon, for its summary: the one picked, else its derived one (also for a pick this build doesn't know). */
export function of(db: Database, r: ProjectRef): ProjectIcon {
  const picked = db
    .query<{ face: string; color: string }, [string, string]>(
      "SELECT face, color FROM project_icons WHERE machine_id = ? AND project_id = ?",
    )
    .get(r.machineId, r.projectId);
  const known = picked && (FACES as readonly string[]).includes(picked.face) && (COLORS as readonly string[]).includes(picked.color);
  return known ? { face: picked.face, color: picked.color } : derived(r);
}

/** The icon picked for the project, undefined while it wears its derived one. */
export function picked(db: Database, r: ProjectRef): ProjectIcon | undefined {
  return (
    db
      .query<{ face: string; color: string }, [string, string]>("SELECT face, color FROM project_icons WHERE machine_id = ? AND project_id = ?")
      .get(r.machineId, r.projectId) ?? undefined
  );
}

/** Puts a pick back as it was, or none, leaving the picture alone: a setup line's Undo. The caller says so in an event. */
export function restore(db: Database, r: ProjectRef, icon: ProjectIcon | undefined, at: number): void {
  if (icon === undefined) {
    db.query("DELETE FROM project_icons WHERE machine_id = ?1 AND project_id = ?2").run(r.machineId, r.projectId);
    return;
  }
  db.query(
    `INSERT INTO project_icons (machine_id, project_id, face, color, set_ms) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (machine_id, project_id) DO UPDATE SET face = excluded.face, color = excluded.color,
             set_ms = excluded.set_ms`,
  ).run(r.machineId, r.projectId, icon.face, icon.color, at);
}

/** `project_icon_set`: picks the project's icon, which forgets its picture. */
export function set(hub: Hub, r: ProjectRef, icon: ProjectIcon): ProjectSummary {
  if (!store(hub).projectGet(r)) throw unknownProject(r);
  const at = hub.clock.now();
  hub.db.transaction((c) => {
    c.query(
      `INSERT INTO project_icons (machine_id, project_id, face, color, set_ms) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (machine_id, project_id) DO UPDATE SET face = excluded.face, color = excluded.color,
               set_ms = excluded.set_ms`,
    ).run(r.machineId, r.projectId, icon.face, icon.color, at);
    c.query("DELETE FROM project_avatars WHERE machine_id = ?1 AND project_id = ?2").run(r.machineId, r.projectId);
  });
  const project = store(hub).projectGet(r);
  if (!project) throw unknownProject(r);
  events(hub).append({
    at: isoMs(at),
    type: "project.settings",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: `${project.title} has a new icon`,
    data: { icon, avatar: null },
  });
  return project;
}
