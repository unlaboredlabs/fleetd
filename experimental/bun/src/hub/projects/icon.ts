// A project's or Navi's built-in icon (crates/fleetd/src/hub/projects/icon.rs): a glass being's face on a field of a
// color, which its chat shows when it has no picture. One a person never picked is derived from its id, so each looks
// the same on every app and every launch.
import type { Database } from "bun:sqlite";
import type { ProjectIcon, ProjectRef } from "../../shared/contracts.ts";

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
