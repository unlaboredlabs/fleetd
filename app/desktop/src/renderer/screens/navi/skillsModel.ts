// A Navi's Skills, kept pure: which group a skill is in (what it learned, what was installed for it, every project's,
// its folder's), the line under each, what the person may change, and a SKILL.md's body without its frontmatter.
import type { SkillSummary, SkillVersion } from "../../../shared/contracts";
import { when } from "../status/view";

export type SkillGroup = "learned" | "installed" | "every" | "folder";

export const GROUP_LABEL: Readonly<Record<SkillGroup, string>> = {
  learned: "Learned",
  installed: "Installed",
  every: "From every project",
  folder: "In its folder",
};

const ORDER: readonly SkillGroup[] = ["learned", "installed", "every", "folder"];

/** Its own, written by it or the person; its own, installed from a source; the hub-wide ones; its folder's. */
export const groupOf = (s: SkillSummary): SkillGroup =>
  s.origin === "project" ? (s.install ? "installed" : "learned") : s.origin === "global" ? "every" : "folder";

/** The skills in their groups, in order, each by name; a skill another of its name outranks is left out. */
export function grouped(skills: readonly SkillSummary[]): { group: SkillGroup; rows: SkillSummary[] }[] {
  const shown = skills.filter((s) => s.shadowedBy === undefined);
  return ORDER.map((group) => ({ group, rows: shown.filter((s) => groupOf(s) === group).sort((a, b) => a.name.localeCompare(b.name)) })).filter(
    (g) => g.rows.length > 0,
  );
}

/** Whose a version is, in a line's words: "Home" for the Navi, "you" for the person reading. */
export const byWord = (v: Pick<SkillVersion, "author" | "by">, me: string | undefined): string => (v.author === "person" && v.by === me ? "you" : v.by);

/** A row's line under its name: off, then who changed it last and when, then its last use. */
export function metaLine(s: SkillSummary, now: number, me?: string): string {
  const parts: string[] = [];
  if (s.off === true) parts.push("Off");
  if (s.changed !== undefined) parts.push(`Changed ${when(s.changed.at, now)} by ${byWord(s.changed, me)}`);
  else if (s.updatedAt !== undefined) parts.push(`Changed ${when(s.updatedAt, now)}`);
  parts.push(s.lastUsedAt !== undefined ? `used ${when(s.lastUsedAt, now)}` : "not used yet");
  return parts.join(" · ");
}

/** The person edits, reverts and deletes the Navi's own (learned or installed); an admin keeps every project's. */
export const isOwn = (s: SkillSummary): boolean => s.origin === "project";

/** A SKILL.md without its frontmatter: what the view renders. */
export function body(text: string): string {
  const t = text.replace(/^\u{feff}/u, "");
  if (!/^---\s*\n/u.test(t)) return t;
  const end = t.indexOf("\n---", 3);
  if (end === -1) return t;
  return t.slice(t.indexOf("\n", end + 1) + 1 || t.length).replace(/^\s+/u, "");
}

/** "Version 3" and its line: who and when. */
export const versionLine = (v: SkillVersion, now: number, me?: string): string => `${byWord(v, me)} · ${when(v.at, now)}`;
