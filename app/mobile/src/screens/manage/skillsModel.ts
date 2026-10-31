// What a Navi's Skills screens show, from the hub's answers: pure, so the tests pin them. Its own skills (the ones it
// saved itself) come first, then the installed ones, then any its folder has; each row says who changed it last and
// when, or when it was last used. A skill's view reads its SKILL.md without the frontmatter, its history each version
// with who, when and why, and a version's change from the one before as the desktop's prose diff, folded around it.
import { diffLines, type DiffLine, type SkillOrigin, type SkillSummary } from "../../desktop";

// The hub's skill versions (D261), as fleetd-contracts has them: copied until the generated contracts carry them.
/** One version of a hub-kept skill's SKILL.md: a Navi's save, a person's edit or restore, an install. */
export interface SkillVersion {
  readonly version: number;
  readonly author: "agent" | "person";
  /** The Navi's title, or the person's name. */
  readonly by: string;
  readonly at: string;
  /** The one line its author gave: a Navi always gives one; a person may. */
  readonly why?: string;
}
/** A skill as skills_list lists it for a project: its newest version, whether it is off there, when it was last run. */
export type Skill = SkillSummary & { readonly changed?: SkillVersion; readonly off?: boolean; readonly lastUsedAt?: string };
/** A chat line's skill: a Navi saved or changed one (`skill_save`). */
export interface SkillSaved {
  readonly name: string;
  readonly version: number;
  readonly created: boolean;
  readonly why: string;
}
/** skill_get's answer: the text of the version asked for, and every version kept, newest first. */
export interface SkillRead {
  readonly skill: Skill;
  readonly text: string;
  readonly versions: readonly SkillVersion[];
}

export type Kind = "own" | "installed" | "folder";

/** Its own: saved by the Navi (or written by the person) in its scope; installed: from a source, or hub-wide. */
export const kindOf = (s: Pick<Skill, "origin" | "install">): Kind =>
  s.origin === "project" ? (s.install === undefined ? "own" : "installed") : s.origin === "global" ? "installed" : "folder";

/** Kept by the hub, so it has versions; a repo skill is the repo's. */
export const hubKept = (origin: SkillOrigin): origin is "project" | "global" => origin === "project" || origin === "global";

export interface SkillGroup {
  readonly kind: Kind;
  readonly header: string;
  readonly rows: readonly Skill[];
}

/** The list's sections in order, the empty ones left out; each keeps the hub's order (by name). */
export const skillGroups = (skills: readonly Skill[], navi: string): SkillGroup[] => {
  const headers: Record<Kind, string> = { own: `Made by ${navi}`, installed: "Installed", folder: "In its folder" };
  return (["own", "installed", "folder"] as const).map((kind) => ({ kind, header: headers[kind], rows: skills.filter((s) => kindOf(s) === kind) })).filter((g) => g.rows.length > 0);
};

/** A list row's key: a name can be in more than one origin. */
export const skillKey = (s: Pick<Skill, "origin" | "name">): string => `${s.origin}/${s.name}`;

interface Clock {
  readonly nowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, in a row's few words: "just now", "5 min ago", "2h ago", "yesterday", "3 days ago", "12 Oct". */
export const ago = (at: string, clock: Clock): string => {
  const ms = Date.parse(at);
  const gone = Math.max(0, clock.nowMs - ms);
  if (gone < MINUTE) return "just now";
  if (gone < HOUR) return `${String(Math.floor(gone / MINUTE))} min ago`;
  if (gone < DAY) return `${String(Math.floor(gone / HOUR))}h ago`;
  if (gone < 2 * DAY) return "yesterday";
  if (gone < 7 * DAY) return `${String(Math.floor(gone / DAY))} days ago`;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(clock.nowMs).getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
};

/** Who made a version, as a line says it: "you" for the person on this phone. */
export const whoOf = (v: Pick<SkillVersion, "author" | "by">, meName: string | undefined): string => (v.author === "person" && meName !== undefined && v.by === meName ? "you" : v.by);

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A row's third line: the newer of its last change ("Changed by Nova · 2h ago") and its last use ("Used yesterday");
 * with neither, where an installed one came from.
 */
export const rowLine = (s: Skill, clock: Clock, meName: string | undefined): string | undefined => {
  const changed = s.changed;
  const used = s.lastUsedAt;
  if (used !== undefined && (changed === undefined || Date.parse(used) > Date.parse(changed.at))) return `Used ${ago(used, clock)}`;
  if (changed !== undefined) return `${changed.version === 1 ? "Made" : "Changed"} by ${whoOf(changed, meName)} · ${ago(changed.at, clock)}`;
  if (s.install !== undefined) return `From ${s.install.source}`;
  if (s.origin === "global") return "Hub-wide";
  return undefined;
};

/** A version's row in its history: its why (or what happened), and who and when. */
export const versionLine = (v: SkillVersion, clock: Clock, meName: string | undefined): { readonly title: string; readonly detail: string } => ({
  title: v.why ?? (v.author === "person" ? "Edited" : v.version === 1 ? "Saved" : "Changed"),
  detail: `${capital(whoOf(v, meName))} · ${ago(v.at, clock)}`,
});

/** Its SKILL.md split: the frontmatter's fields (name, description) and the steps under it. */
export const splitSkill = (text: string): { readonly fields: Readonly<Record<string, string>>; readonly body: string } => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  if (m === null) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/u)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
    if (kv !== null) fields[kv[1] ?? ""] = (kv[2] ?? "").replace(/^(["'])(.*)\1$/u, "$2");
  }
  return { fields, body: text.slice(m[0].length).replace(/^\s*\n/u, "") };
};

/** What the person may do to a skill from its view. */
export interface SkillOffers {
  /** Edit and Delete: its own, never a hub-wide one (every project's) or one installed from a source. */
  readonly edit: boolean;
  readonly delete: boolean;
  readonly history: boolean;
  readonly turnOff: boolean;
}

/** `own`: the Navi is the person's (the hub refuses another's). */
export const offers = (s: Pick<Skill, "origin" | "install">, own: boolean): SkillOffers => {
  const mine = own && kindOf(s) === "own";
  return { edit: mine, delete: mine, history: hubKept(s.origin), turnOff: own };
};

/** The view's line under the description: where it is from and its version. */
export const sourceLine = (s: Skill, navi: string, versions: number): string => {
  const kind = kindOf(s);
  const where = kind === "own" ? `Made by ${navi}` : s.install !== undefined ? `Installed from ${s.install.source}` : kind === "installed" ? "Hub-wide" : (s.path ?? "In its folder");
  return versions > 1 ? `${where} · ${String(versions)} versions` : where;
};

export type DiffChunk = { readonly t: "line"; readonly line: DiffLine; readonly ix: number } | { readonly t: "fold"; readonly from: number; readonly count: number };

/** Unchanged lines kept around a change; a longer unchanged run folds to one row that opens it. */
export const DIFF_CONTEXT = 2;

/** A version's change from the one before: the changed lines, a little around them, the rest folded. */
export const diffChunks = (before: string, after: string, open: ReadonlySet<number>): DiffChunk[] => {
  const d = diffLines(before, after);
  const near = d.map((_, ix) => d.slice(Math.max(0, ix - DIFF_CONTEXT), ix + DIFF_CONTEXT + 1).some((l) => l.op !== "same"));
  const out: DiffChunk[] = [];
  let ix = 0;
  while (ix < d.length) {
    const line = d[ix];
    if (line === undefined) break;
    if (near[ix] === true) {
      out.push({ t: "line", line, ix });
      ix++;
      continue;
    }
    let end = ix;
    while (end < d.length && near[end] !== true) end++;
    if (open.has(ix) || end - ix < 3) for (let k = ix; k < end; k++) out.push({ t: "line", line: d[k] as DiffLine, ix: k });
    else out.push({ t: "fold", from: ix, count: end - ix });
    ix = end;
  }
  return out;
};

/** "3 lines added, 1 removed", or that nothing changed (a restore of the same text). */
export const diffSummary = (before: string, after: string): string => {
  const d = diffLines(before, after);
  const added = d.filter((l) => l.op === "add").length;
  const removed = d.filter((l) => l.op === "del").length;
  const lines = (n: number) => `${String(n)} ${n === 1 ? "line" : "lines"}`;
  if (added === 0 && removed === 0) return "No change in its text";
  if (removed === 0) return `${lines(added)} added`;
  if (added === 0) return `${lines(removed)} removed`;
  return `${lines(added)} added, ${String(removed)} removed`;
};

