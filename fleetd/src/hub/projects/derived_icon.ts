// A project's derived icon, from its id alone, so each looks the same on every app and every launch (icon.ts keeps
// the one a person picks).
import type { ProjectIcon, ProjectRef } from "../../shared/contracts.ts";

/** IconFace::ALL and IconColor::ALL, in the Rust contracts' order: the derived icon indexes them. */
export const FACES = ["mo", "wee", "peep", "nap", "cy", "wink", "joy", "huh", "wow"] as const;
export const COLORS = ["fleet", "sky", "teal", "mint", "lime", "sun", "ember", "rose", "plum", "lilac", "sand", "graphite"] as const;

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
