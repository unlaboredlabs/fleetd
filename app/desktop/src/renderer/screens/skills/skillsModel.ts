// One of a project's skills, kept pure: the line under its name, what the person may change, and a SKILL.md's body
// without its frontmatter.
import type { SkillSummary, SkillVersion } from "../../../shared/contracts";
import { when } from "../live/when";

/** Whose a version is, in a line's words: its project's name for its lead, "you" for the person reading. */
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

/** The person edits, reverts and deletes the project's own (learned or installed); an admin keeps every project's. */
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
