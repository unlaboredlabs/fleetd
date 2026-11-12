// Where prompt texts live and which one a message gets. Overrides are files
// under `<hub home>/prompts` (`<id>.md`, `projects/<key>/<id>.md`, `<key>` a hash of the project ref), each with a
// `base:` frontmatter naming the default it was edited from. Files are read on every resolve, so an edit reaches the
// next session at once. Every text a session was given is kept in `prompt_versions`, and `session_prompts` pins each
// session to its refs: every later message to that thread renders from the text it started with.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  PromptDetail,
  PromptOverride,
  PromptScope,
  PromptSummary,
  PromptVersion,
  PromptWarning,
  ProjectRef,
  RetiredPromptOverride,
  SessionPrompt,
  SessionPromptRef,
  StalePrompt,
} from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { type Audience, ENTRIES, getEntry, INSTRUCTIONS, perProject, placeholdersOf, type RegistryEntry, safetyRules } from "./entry.ts";
import { gitBlobSha, merge, refOf, rulePresent, sameWords, warnings } from "./render.ts";
import { RETIRED, type Retired } from "./retired.ts";
import { defaultOf, PromptSet, type Resolved } from "./set.ts";

export { PromptSet, type Resolved } from "./set.ts";

/** Tools no fleetd session gets (node/runner/claude/mod.rs `ALWAYS_DISALLOWED`). */
export const ALWAYS_DISALLOWED = [
  "Task",
  "Agent",
  "Workflow",
  "ListAgents",
  "SendMessage",
  "TaskStop",
  "TaskOutput",
  "TeamCreate",
  "TeamDelete",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "EnterWorktree",
  "ExitWorktree",
  "Bash(claude *)",
  "Bash(/*/claude *)",
  "Bash(~/*/claude *)",
  "Bash($HOME/*/claude *)",
  "Bash(./*/claude *)",
  "Bash(/*/claude/versions/*)",
  "Bash(~/*/claude/versions/*)",
  "Bash($HOME/*/claude/versions/*)",
  "Bash(npx claude *)",
  "Bash(bunx claude *)",
  "Bash(npx *@anthropic-ai/claude-code*)",
  "Bash(bunx *@anthropic-ai/claude-code*)",
  "Bash(npm exec *@anthropic-ai/claude-code*)",
  "Bash(pnpm dlx *@anthropic-ai/claude-code*)",
  "Bash(sh -*c *claude -*)",
  "Bash(bash -*c *claude -*)",
  "Bash(zsh -*c *claude -*)",
  "Bash(/*sh -*c *claude -*)",
  "Bash(env *claude -*)",
  "Bash(exec *claude -*)",
  "Bash(xargs *claude -*)",
];

/** An override file's text, without its frontmatter, and the default it was edited from. */
export type Override = { text: string; base?: string };

const versionOf = (id: string, o: Override): PromptOverride => ({
  ref: refOf(id, o.text),
  text: o.text,
  ...(o.base === undefined ? {} : { base: o.base }),
});

export function parseFile(raw: string): Override {
  if (raw.startsWith("---\n")) {
    const rest = raw.slice(4);
    const end = rest.indexOf("\n---\n");
    if (end >= 0) {
      const front = rest.slice(0, end);
      if (front.split("\n").every((l) => l.includes(":"))) {
        const base = front
          .split("\n")
          .find((l) => l.startsWith("base:"))
          ?.slice(5)
          .trim();
        return { text: rest.slice(end + 5), ...(base ? { base } : {}) };
      }
    }
  }
  return { text: raw };
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path.replace(/\.md$/, ".md.tmp");
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Removes the file; one already gone is fine. */
function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new PromptError("io", `cannot remove the override: ${(error as Error).message}`);
  }
}

export class PromptError extends Error {
  constructor(
    readonly kind: "invalid" | "not_found" | "io",
    message: string,
  ) {
    super(message);
  }
}

export type StaleOverride = { entry: RegistryEntry; project?: ProjectRef; base?: string };

/** A project's override directory: a hash of its ref, never the ids themselves. */
export function projectKey(p: ProjectRef): string {
  return new Bun.CryptoHasher("sha256").update(`${p.machineId}\0${p.projectId}`).digest("hex").slice(0, 16);
}

export function entryOr(id: string): RegistryEntry {
  const e = getEntry(id);
  if (!e) throw new PromptError("not_found", `There is no prompt ${id}.`);
  return e;
}

function readText(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** `<home>/prompts` beside the database; undefined for an in-memory one, which has the shipped prompts only. */
export const promptsDir = (db: HubDb) => (db.path ? join(dirname(db.path), "prompts") : undefined);

/** The prompts of one hub, over its database and `<home>/prompts`. */
export class Prompts {
  constructor(private readonly db: HubDb) {}

  private fileOf(id: string, project?: ProjectRef): string | undefined {
    const dir = promptsDir(this.db);
    if (dir === undefined) return undefined;
    const file = project === undefined ? join(dir, `${id}.md`) : join(dir, "projects", projectKey(project), `${id}.md`);
    return resolve(file).startsWith(resolve(dir)) ? file : undefined;
  }

  /** The override at exactly this level. */
  overrideOf(e: RegistryEntry, project?: ProjectRef): Override | undefined {
    if (project !== undefined && !perProject(e)) return undefined;
    const raw = readText(this.fileOf(e.id, project));
    return raw === undefined ? undefined : parseFile(raw);
  }

  private effectiveOverride(e: RegistryEntry, project?: ProjectRef): [PromptScope, Override] | undefined {
    const local = project === undefined ? undefined : this.overrideOf(e, project);
    if (local) return ["project", local];
    const global = this.overrideOf(e);
    return global ? ["global", global] : undefined;
  }

  private resolveEntry(e: RegistryEntry, project?: ProjectRef): Resolved {
    const found = this.effectiveOverride(e, project);
    return found ? { ref: refOf(e.id, found[1].text), scope: found[0], text: found[1].text } : defaultOf(e);
  }

  private instructions(project?: ProjectRef): Resolved[] {
    const e = entryOr(INSTRUCTIONS);
    const levels: [PromptScope, ProjectRef | undefined][] = [["global", undefined]];
    if (project !== undefined) levels.push(["project", project]);
    return levels.flatMap(([scope, p]) => {
      const o = this.overrideOf(e, p);
      return o && o.text.trim() ? [{ ref: refOf(e.id, o.text), scope, text: o.text }] : [];
    });
  }

  /** The texts in effect now: the project's override, else the hub-wide one, else the shipped default. */
  current(project?: ProjectRef): PromptSet {
    return new PromptSet(new Map(ENTRIES.map((e) => [e.id, this.resolveEntry(e, project)])), this.instructions(project));
  }

  /** The texts for a message to this thread: what its session pinned at its start, the current ones for the rest. */
  forThread(machineId: string, threadId: string): PromptSet {
    try {
      return this.pinned(machineId, threadId);
    } catch (error) {
      console.warn("prompts: pinned texts unreadable, using the current ones:", error);
      return this.current();
    }
  }

  private pinned(machineId: string, threadId: string): PromptSet {
    const row = this.db.all<{ project_id: string | null; refs: string }>(
      "SELECT project_id, refs FROM session_prompts WHERE machine_id = ? AND thread_id = ?",
      [machineId, threadId],
    )[0];
    const projectOf = (id: string | null | undefined) => (id ? { machineId, projectId: id } : undefined);
    if (!row) {
      const t = this.db.all<{ project_id: string }>("SELECT project_id FROM threads WHERE machine_id = ? AND thread_id = ?", [
        machineId,
        threadId,
      ])[0];
      return this.current(projectOf(t?.project_id));
    }
    const set = this.current(projectOf(row.project_id));
    set.instructions.length = 0;
    for (const r of JSON.parse(row.refs) as SessionPromptRef[]) {
      const text = this.version(r.ref);
      if (text === undefined) continue;
      const resolved: Resolved = { ref: r.ref, scope: r.scope, text };
      if (r.id === INSTRUCTIONS) set.instructions.push(resolved);
      else {
        const e = getEntry(r.id);
        if (e) set.entries.set(e.id, resolved);
      }
    }
    return set;
  }

  /** The texts for a wake to the project's lead: its session's, or the current ones when it has none. */
  forLead(project: ProjectRef): PromptSet {
    const row = this.db.all<{ thread_id: string }>("SELECT thread_id FROM leads WHERE machine_id = ? AND project_id = ?", [
      project.machineId,
      project.projectId,
    ])[0];
    return row ? this.forThread(project.machineId, row.thread_id) : this.current(project);
  }

  /** The texts for a message to a task's thread (`T<n>`). */
  forTask(project: ProjectRef, taskId: string): PromptSet {
    const n = Number.parseInt(taskId.slice(1), 10) || 0;
    const row = this.db.all<{ thread_id: string | null }>("SELECT thread_id FROM tasks WHERE n = ?", [n])[0];
    return row?.thread_id ? this.forThread(project.machineId, row.thread_id) : this.current(project);
  }

  private version(ref: string): string | undefined {
    return this.db.all<{ text: string }>("SELECT text FROM prompt_versions WHERE ref = ?", [ref])[0]?.text;
  }

  private keep(versions: [string, string][]): void {
    this.db.transaction((c) => {
      const insert = c.query("INSERT OR IGNORE INTO prompt_versions (ref, text) VALUES (?, ?)");
      for (const [r, text] of versions) insert.run(r, text);
    });
  }

  /**
   * Moves the overrides of each prompt a release renamed (`prompt_renames`, which its migration fills) to the new id,
   * hub-wide and per project, their `base:` with them: first the base, in place, then the file, each step atomic, so a
   * stop between the two is finished at the next start. An override already under the new id is the one in effect: the
   * old file stays beside it, untouched, and is named in the log. Returns the files moved.
   */
  moveRenamed(): string[] {
    const dir = promptsDir(this.db);
    if (dir === undefined) return [];
    const renames = this.db.all<{ old_id: string; new_id: string }>("SELECT old_id, new_id FROM prompt_renames ORDER BY old_id");
    let projects: string[] = [];
    try {
      projects = readdirSync(join(dir, "projects")).map((key) => join(dir, "projects", key));
    } catch {}
    const moved: string[] = [];
    for (const level of [dir, ...projects]) {
      for (const { old_id: old, new_id: now } of renames) {
        const from = join(level, `${old}.md`);
        const raw = readText(from);
        if (raw === undefined) continue;
        const to = join(level, `${now}.md`);
        if (existsSync(to)) {
          console.warn(`prompts: ${from} stays as it is: ${to}, the override of its new name, is the one in effect`);
          continue;
        }
        try {
          const o = parseFile(raw);
          const base = o.base?.startsWith(`${old}@`) ? `${now}${o.base.slice(old.length)}` : o.base;
          if (base !== o.base) writeAtomic(from, `---\nbase: ${base}\n---\n${o.text}`);
          renameSync(from, to);
          moved.push(to);
        } catch (error) {
          console.warn(`prompts: ${from} was not moved to ${to}: ${(error as Error).message}`);
        }
      }
    }
    return moved;
  }

  /** Keeps every shipped text, so an override edited from an older release can still be compared with its base. */
  keepDefaults(): void {
    this.keep(ENTRIES.map((e) => [refOf(e.id, e.default), e.default]));
  }

  /** Records what a session started with: `text`, its exact first message, and the ref of every prompt it may receive. */
  pin(set: PromptSet, audience: Audience, project: ProjectRef, threadId: string, at: string, text: string): string {
    const refs = set.refs(audience);
    this.keep(refs.map(([r, t]) => [r.ref, t]));
    const sha = gitBlobSha(text);
    this.db.conn
      .query(
        "INSERT OR REPLACE INTO session_prompts (machine_id, thread_id, project_id, started_at, refs, text_sha, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(project.machineId, threadId, project.projectId, at, JSON.stringify(refs.map(([r]) => r)), sha, text);
    return sha;
  }

  session(machineId: string, threadId: string): SessionPrompt | undefined {
    const row = this.db.all<{ project_id: string | null; started_at: string; refs: string; text_sha: string; text: string }>(
      "SELECT project_id, started_at, refs, text_sha, text FROM session_prompts WHERE machine_id = ? AND thread_id = ?",
      [machineId, threadId],
    )[0];
    if (!row) return undefined;
    return {
      machineId,
      threadId,
      ...(row.project_id ? { projectRef: { machineId, projectId: row.project_id } } : {}),
      startedAt: row.started_at,
      text: row.text,
      textSha: row.text_sha,
      refs: JSON.parse(row.refs),
      disallowedTools: ALWAYS_DISALLOWED,
    } as SessionPrompt;
  }

  /** Saves an override (`scope` global or project) and keeps its text. Returns its ref. */
  save(e: RegistryEntry, scope: PromptScope, project: ProjectRef | undefined, text: string, base?: string): string {
    const level = this.level(e, scope, project);
    if (!text.trim() && e.id !== INSTRUCTIONS) {
      throw new PromptError("invalid", "The text is empty; reset the prompt to go back to the shipped one.");
    }
    const file = this.fileOf(e.id, level);
    if (file === undefined) throw new PromptError("invalid", "This hub keeps no prompt files (an in-memory database).");
    try {
      writeAtomic(file, `---\nbase: ${base ?? refOf(e.id, e.default)}\n---\n${text}`);
    } catch (error) {
      throw new PromptError("io", `cannot write the override: ${(error as Error).message}`);
    }
    const r = refOf(e.id, text);
    this.keep([[r, text]]);
    return r;
  }

  /** `prompt_set`: what the edit may break, then the edit saved anyway (warnings never block). */
  set(
    e: RegistryEntry,
    scope: PromptScope,
    project: ProjectRef | undefined,
    text: string,
    base?: string,
  ): { ref: string; warnings: PromptWarning[] } {
    const found = warnings(e, text);
    return { ref: this.save(e, scope, project, text, base), warnings: found };
  }

  /** Removes the override at this level; the next level down is in effect again. */
  reset(e: RegistryEntry, scope: PromptScope, project?: ProjectRef): void {
    const file = this.fileOf(e.id, this.level(e, scope, project));
    if (file !== undefined) removeFile(file);
  }

  private level(e: RegistryEntry, scope: PromptScope, project?: ProjectRef): ProjectRef | undefined {
    if (scope === "default") throw new PromptError("invalid", "The shipped text cannot change; save a global or project override.");
    if (scope === "global") return undefined;
    if (!perProject(e)) throw new PromptError("invalid", `${e.id} has one hub-wide text; save it with scope global.`);
    if (project === undefined) throw new PromptError("invalid", "A project override needs projectRef.");
    return project;
  }

  /** Whether an override edited from `base` is still up to date with the default shipped now. */
  private baseCurrent(e: RegistryEntry, base: string | undefined): boolean {
    if (base === undefined) return false;
    if (base === refOf(e.id, e.default)) return true;
    const text = this.version(base);
    return text !== undefined && sameWords(text, e.default);
  }

  private staleOf(e: RegistryEntry, scope: PromptScope, o: Override): StalePrompt | undefined {
    if (this.baseCurrent(e, o.base)) return undefined;
    const baseText = o.base === undefined ? undefined : this.version(o.base);
    const base: PromptVersion | undefined = o.base !== undefined && baseText !== undefined ? { ref: o.base, text: baseText } : undefined;
    const { text: merged, conflicts } = merge(base?.text ?? "", e.default, o.text);
    return {
      scope,
      ...(base ? { base } : {}),
      current: { ref: refOf(e.id, e.default), text: e.default },
      yours: { ref: refOf(e.id, o.text), text: o.text },
      merged,
      conflicts,
    };
  }

  list(project?: ProjectRef): PromptSummary[] {
    return ENTRIES.map((e) => {
      const found = this.effectiveOverride(e, project);
      return {
        id: e.id,
        title: e.title,
        kind: e.kind,
        group: e.group,
        sentWhen: e.sentWhen,
        scope: found?.[0] ?? "default",
        defaultRef: refOf(e.id, e.default),
        ...(found ? { overrideRef: refOf(e.id, found[1].text) } : {}),
        stale: found !== undefined && this.staleOf(e, found[0], found[1]) !== undefined,
      };
    });
  }

  detail(e: RegistryEntry, project?: ProjectRef): PromptDetail {
    const global = this.overrideOf(e);
    const local = project === undefined ? undefined : this.overrideOf(e, project);
    const [scope, mine]: [PromptScope, Override | undefined] = local
      ? ["project", local]
      : global
        ? ["global", global]
        : ["default", undefined];
    const effective = mine?.text ?? e.default;
    const stale = mine ? this.staleOf(e, scope, mine) : undefined;
    return {
      id: e.id,
      title: e.title,
      kind: e.kind,
      group: e.group,
      sentWhen: e.sentWhen,
      perProject: perProject(e),
      default: { ref: refOf(e.id, e.default), text: e.default },
      ...(global ? { global: versionOf(e.id, global) } : {}),
      ...(local ? { project: versionOf(e.id, local) } : {}),
      scope,
      placeholders: placeholdersOf(e),
      safetyRules: safetyRules(e).map((r) => ({ ...r, present: rulePresent(r.needle, effective) })),
      warnings: mine ? warnings(e, effective) : [],
      effective: { ref: refOf(e.id, effective), text: effective },
      ...(stale ? { stale } : {}),
    } as PromptDetail;
  }

  /** Every override edited from an older default than the one shipped now. */
  stale(): StaleOverride[] {
    const out: StaleOverride[] = [];
    for (const project of this.levels()) {
      for (const e of ENTRIES) {
        const o = this.overrideOf(e, project);
        if (o && !this.baseCurrent(e, o.base)) {
          out.push({ entry: e, ...(project ? { project } : {}), ...(o.base === undefined ? {} : { base: o.base }) });
        }
      }
    }
    return out;
  }

  /** Hub-wide, then every project the hub knows. */
  private levels(): (ProjectRef | undefined)[] {
    const known = this.db.all<{ machine_id: string; project_id: string }>("SELECT machine_id, project_id FROM projects");
    return [undefined, ...known.filter((k) => k.machine_id).map((k) => ({ machineId: k.machine_id, projectId: k.project_id }))];
  }

  /** Edits to retired prompts: hub-wide ones, and `project`'s when given. */
  orphans(project?: ProjectRef): RetiredPromptOverride[] {
    const out: RetiredPromptOverride[] = [];
    for (const level of project === undefined ? [undefined] : [undefined, project]) {
      for (const r of RETIRED) {
        const raw = readText(this.fileOf(r.id, level));
        if (raw === undefined) continue;
        out.push({
          id: r.id,
          title: r.title,
          scope: level ? "project" : "global",
          ...(level ? { projectRef: level } : {}),
          text: parseFile(raw).text,
          ...(r.target === undefined ? {} : { suggestedTarget: r.target }),
          why: r.why,
        });
      }
    }
    return out;
  }

  /** Every edit to a retired prompt the hub keeps, at any level. */
  allOrphans(): RetiredPromptOverride[] {
    const out = this.orphans();
    for (const p of this.levels()) if (p) out.push(...this.orphans(p).filter((o) => o.scope === "project"));
    return out;
  }

  /** Deletes an edit to a retired prompt. */
  resetRetired(r: Retired, scope: PromptScope, project?: ProjectRef): void {
    if (scope === "default") {
      throw new PromptError("invalid", "A retired prompt has no shipped text to reset; give scope global or project.");
    }
    if (scope === "project" && project === undefined) throw new PromptError("invalid", "A project override needs projectRef.");
    const file = this.fileOf(r.id, scope === "project" ? project : undefined);
    if (file !== undefined) removeFile(file);
  }
}

export const prompts = (db: HubDb) => new Prompts(db);
