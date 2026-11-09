// What the leads remember: plain markdown under `<hub home>/memory`, in no repo.
// `people/<person>.md` is one person's own memory ("You", user scope, D212); a hub from before people keeps one shared
// `user.md`. `<machine>/<project>/MEMORY.md` (the always-on part, then one `- [topic](topic.md)` line per topic) and its
// topic files belong to one project and are never read for another. The hub is the only writer: a lead's `remember`
// or `forget` (`calls`; the nightly `refresh` makes them too) or a person's edit in the app (`tools`). A write past a
// cap is refused, never truncated. Every write here is synchronous, so writes never interleave.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ChatMessage,
  MemoryCaps,
  MemoryFile,
  MemoryNote,
  MemoryScope,
  PersonId,
  ProjectRef,
  RememberedItem,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { kept } from "../navi/store.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs } from "../store/time.ts";
import { redact } from "./redact.ts";

export const USER_FILE = "user.md";
export const INDEX_FILE = "MEMORY.md";
export const PEOPLE_DIR = "people";
const MIGRATED_KEY = "user_migrated";
export const CAP_MIN = 1_000;
export const FILE_CAP_MAX = 100_000;
export const PROJECT_CAP_MAX = 400_000;
export const DEFAULT_CAPS: MemoryCaps = { user: 16_000, index: 16_000, topic: 32_000, project: 128_000 };

export const isTopic = (s: string) => s !== "memory" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(s);

export type RememberCall = { scope: MemoryScope; topic?: string; text: string; replaces?: string };
export type ForgetCall = { scope: MemoryScope; topic?: string; entry: string; reason?: string };

/** One memory file: a person's own, the shared `user.md`, a project's `MEMORY.md` or one of its topics. */
export type Target = { project?: ProjectRef; topic?: string; person?: PersonId };

export const userTarget = (person?: PersonId): Target => (person === undefined ? {} : { person });
export const projectTarget = (r: ProjectRef, topic?: string): Target => (topic === undefined ? { project: r } : { project: r, topic });
export const scopeOf = (t: Target): MemoryScope => (t.project ? "project" : "user");
export const nameOf = (t: Target) => (!t.project ? USER_FILE : t.topic === undefined ? INDEX_FILE : `${t.topic}.md`);

/** `<home>/memory`; a hub without a home keeps none. */
export const memoryDir = (hub: Hub) => (hub.config.home ? join(hub.config.home, "memory") : undefined);

/** The caps the hub keeps; each one not set has its default. */
export function memoryCaps(db: HubDb): MemoryCaps {
  const caps = { ...DEFAULT_CAPS };
  for (const { key, value } of db.all<{ key: string; value: number }>("SELECT key, value FROM memory_settings")) {
    const fileOk = value >= CAP_MIN && value <= FILE_CAP_MAX;
    if ((key === "user" || key === "index" || key === "topic") && fileOk) caps[key] = value;
    if (key === "project" && value >= CAP_MIN && value <= PROJECT_CAP_MAX) caps.project = value;
  }
  return caps;
}

/** A project's directory name: its id when that is a plain file name, else a hash of it. */
export function projectDirName(r: ProjectRef): string {
  const id = r.projectId;
  if (Buffer.byteLength(id) <= 128 && !id.startsWith(".") && /^[A-Za-z0-9._-]*$/.test(id)) return id;
  return `p-${new Bun.CryptoHasher("sha256").update(id).digest("hex").slice(0, 16)}`;
}

const entryLine = (text: string) => `- ${text}`;
const indexLine = (topic: string) => `- [${topic}](${topic}.md)`;
const isIndexLine = (line: string) => line.startsWith("- [") && line.trimEnd().endsWith(".md)");
const chars = (text: string) => [...text].length;

/** Rust's `str::lines`: split on \n, a trailing \r dropped, no last empty line. */
export function linesOf(text: string): string[] {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const joinLines = (lines: string[]) => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);

function writeAtomic(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = path.replace(/\.md$/, ".md.tmp");
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

const invalid = (message: string, fix?: string) => new ToolError("invalid", message, fix);

function secretRefusal(text: string): void {
  if (redact(text) !== text) {
    throw invalid("That looks like a secret, and memory never holds one.", "Leave the value out; a secret goes through request_secret.");
  }
}

/** The one entry of `lines` (file `t`) that contains `words`: quoted words are an optimistic lock. */
function oneEntry(t: Target, lines: string[], words: string): number {
  const hits = lines.flatMap((l, i) => (!isIndexLine(l) && l.includes(words) ? [i] : []));
  if (hits.length === 1) return hits[0] as number;
  throw invalid(
    hits.length === 0 ? `No entry of ${nameOf(t)} contains "${words}".` : `${hits.length} entries of ${nameOf(t)} contain "${words}".`,
    "Quote words of exactly one entry as it reads now (memory_read for a topic).",
  );
}

const targetFor = (scope: MemoryScope, r: ProjectRef, person: PersonId | undefined, topic: string | undefined): Target =>
  scope === "project" ? projectTarget(r, topic) : userTarget(person);

/** The memory of one hub, over `<home>/memory`. */
export class Memory {
  readonly caps: MemoryCaps;

  constructor(
    private readonly db: HubDb,
    private readonly dir: string | undefined,
  ) {
    this.caps = memoryCaps(db);
  }

  static of(hub: Hub): Memory {
    return new Memory(hub.db, memoryDir(hub));
  }

  /** The cap of file `t`. */
  cap(t: Target): number {
    return !t.project ? this.caps.user : t.topic === undefined ? this.caps.index : this.caps.topic;
  }

  private root(): string {
    if (this.dir === undefined) throw new ToolError("failed", "This hub has no home to keep memory in.");
    return this.dir;
  }

  projectDir(r: ProjectRef): string | undefined {
    return this.dir === undefined ? undefined : join(this.dir, r.machineId, projectDirName(r));
  }

  path(t: Target): string | undefined {
    if (this.dir === undefined) return undefined;
    if (!t.project) return t.person === undefined ? join(this.dir, USER_FILE) : join(this.dir, PEOPLE_DIR, `${t.person}.md`);
    return join(this.projectDir(t.project) as string, nameOf(t));
  }

  /** The file's text; empty when there is none. */
  read(t: Target): string {
    const p = this.path(t);
    if (p === undefined) return "";
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  }

  private updatedAt(t: Target): string | undefined {
    const p = this.path(t);
    if (p === undefined) return undefined;
    try {
      return isoMs(Math.floor(statSync(p).mtimeMs));
    } catch {
      return undefined;
    }
  }

  /** A project's topics, by name. */
  topics(r: ProjectRef): string[] {
    const dir = this.projectDir(r);
    if (dir === undefined) return [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .flatMap((n) => (n.endsWith(".md") && isTopic(n.slice(0, -3)) ? [n.slice(0, -3)] : []))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** Every file of the project, MEMORY.md included, together. */
  projectChars(r: ProjectRef): number {
    return chars(this.read(projectTarget(r))) + this.topics(r).reduce((n, t) => n + chars(this.read(projectTarget(r, t))), 0);
  }

  /** Writes `text` to `t`, or deletes the file when it is empty, after the secret and cap checks. */
  private put(t: Target, text: string): void {
    this.root();
    secretRefusal(text);
    const [len, cap] = [chars(text), this.cap(t)];
    if (len > cap) {
      throw invalid(
        `${nameOf(t)} would be ${len} characters, past its cap of ${cap}. Nothing was written.`,
        "Merge or replace: fold this into an entry it overlaps (remember with replaces), or drop one that no longer holds.",
      );
    }
    if (t.project) {
      const total = this.projectChars(t.project) - chars(this.read(t)) + len;
      if (total > this.caps.project) {
        throw invalid(
          `This project's memory would be ${total} characters, past its cap of ${this.caps.project}. Nothing was written.`,
          "Merge or replace: fold topics together, or drop entries that no longer hold.",
        );
      }
    }
    const path = this.path(t) as string;
    if (!text.trim()) {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ToolError("failed", `cannot write the memory file: ${(error as Error).message}`);
      }
    } else {
      try {
        writeAtomic(path, text);
      } catch (error) {
        throw new ToolError("failed", `cannot write the memory file: ${(error as Error).message}`);
      }
    }
  }

  /** A project's index with the line for `topic` added (`present`) or dropped; undefined when it is already so. */
  private indexWith(r: ProjectRef, topic: string, present: boolean): string | undefined {
    const lines = linesOf(this.read(projectTarget(r)));
    const link = `(${topic}.md)`;
    const has = lines.some((l) => isIndexLine(l) && l.includes(link));
    if (present && !has) lines.push(indexLine(topic));
    else if (!present && has) return joinLines(lines.filter((l) => !(isIndexLine(l) && l.includes(link))));
    else return undefined;
    return joinLines(lines);
  }

  /**
   * A lead's `remember` in project `r`, user scope in `person`'s memory: the entry appended, or put in place of the
   * one that contains `replaces`. `item` undefined when the file already says exactly that.
   */
  remember(r: ProjectRef, person: PersonId | undefined, call: RememberCall): { target: Target; item?: RememberedItem; chars: number } {
    this.root();
    const t = targetFor(call.scope, r, person, call.topic);
    const lines = linesOf(this.read(t));
    const line = entryLine(call.text);
    if (lines.some((l) => l.trimEnd() === line)) return { target: t, chars: chars(joinLines(lines)) };
    let replaced: string | undefined;
    if (call.replaces !== undefined) {
      const i = oneEntry(t, lines, call.replaces);
      const old = (lines[i] as string).replace(/^(- )+/, "");
      if (old.length >= 1 && old.length <= 1000 && !/[\r\n]/.test(old)) replaced = old;
      lines[i] = line;
    } else {
      // Entries go above the topic index, so MEMORY.md keeps its always-on part first.
      const i = lines.findIndex(isIndexLine);
      if (i >= 0 && t.topic === undefined) lines.splice(i, 0, line);
      else lines.push(line);
    }
    const text = joinLines(lines);
    // The index line is in the cap check of the topic write: both go, or neither.
    const index = t.project && t.topic !== undefined ? this.indexWith(t.project, t.topic, true) : undefined;
    if (index !== undefined && t.project) {
      const it = projectTarget(t.project);
      const room = Math.max(this.caps.project - (this.projectChars(t.project) - chars(this.read(t)) - chars(this.read(it))), 0);
      if (chars(index) > this.cap(it) || chars(index) + chars(text) > room) {
        throw invalid(
          "This project's memory is at its cap. Nothing was written.",
          "Merge or replace: fold topics together, or drop entries that no longer hold.",
        );
      }
    }
    this.put(t, text);
    if (index !== undefined && t.project) this.put(projectTarget(t.project), index);
    const item: RememberedItem = {
      scope: call.scope,
      ...(t.person === undefined ? {} : { person: t.person }),
      ...(call.topic === undefined ? {} : { topic: call.topic }),
      text: call.text,
      ...(replaced === undefined ? {} : { replaced }),
    };
    return { target: t, item, chars: chars(text) };
  }

  /** A lead's `forget`: the one entry that contains `call.entry` goes. A topic left empty goes with its index line. */
  forget(r: ProjectRef, person: PersonId | undefined, call: ForgetCall): { target: Target; item: RememberedItem; chars: number } {
    this.root();
    const t = targetFor(call.scope, r, person, call.topic);
    const lines = linesOf(this.read(t));
    const i = oneEntry(t, lines, call.entry);
    const whole = (lines[i] as string).replace(/^(- )+/, "").trimEnd();
    if (whole.length < 1 || whole.length > 1000) {
      throw invalid(
        `That line of ${nameOf(t)} is not one entry of at most 1,000 characters.`,
        "Leave it, or merge it into a shorter entry with remember and replaces.",
      );
    }
    lines.splice(i, 1);
    const now = joinLines(lines);
    this.putDroppingEmptyTopic(t, now);
    const item: RememberedItem = {
      scope: call.scope,
      ...(t.person === undefined ? {} : { person: t.person }),
      ...(call.topic === undefined ? {} : { topic: call.topic }),
      text: whole,
      forgotten: true,
      ...(call.reason === undefined ? {} : { reason: call.reason }),
    };
    return { target: t, item, chars: chars(now) };
  }

  private putDroppingEmptyTopic(t: Target, text: string): void {
    this.put(t, text);
    if (t.project && t.topic !== undefined && !text.trim()) {
      const index = this.indexWith(t.project, t.topic, false);
      if (index !== undefined) this.put(projectTarget(t.project), index);
    }
  }

  /** Takes back what `item` wrote in project `r`: its entry goes, and the one it replaced comes back. */
  undo(r: ProjectRef, item: RememberedItem): void {
    if (item.forgotten === true) {
      this.remember(r, item.person, { scope: item.scope, ...(item.topic === undefined ? {} : { topic: item.topic }), text: item.text });
      return;
    }
    const t = targetFor(item.scope, r, item.person, item.topic);
    const lines = linesOf(this.read(t));
    const i = lines.findIndex((l) => l.trimEnd() === entryLine(item.text));
    if (i < 0) throw invalid(`${nameOf(t)} no longer has that entry; it was changed since.`, "Edit it in Settings > Memory.");
    if (item.replaced !== undefined) lines[i] = entryLine(item.replaced);
    else lines.splice(i, 1);
    this.putDroppingEmptyTopic(t, joinLines(lines));
  }

  /** A person's edit in the app: the whole file. Empty deletes it, and a topic's index line with it. */
  set(t: Target, text: string): void {
    this.put(t, text);
    if (t.project && t.topic !== undefined) {
      const index = this.indexWith(t.project, t.topic, text.trim() !== "");
      if (index !== undefined) this.put(projectTarget(t.project), index);
    }
  }

  /** The file as the app shows it, with the notes of the entries `remember` wrote that are still in it. */
  file(t: Target): MemoryFile {
    const text = this.read(t);
    const lines = linesOf(text).map((l) => l.trimEnd());
    const updatedAt = this.updatedAt(t);
    return {
      scope: scopeOf(t),
      ...(t.topic === undefined ? {} : { topic: t.topic }),
      chars: chars(text),
      cap: this.cap(t),
      text,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      notes: notes(this.db, t).filter((n) => lines.includes(entryLine(n.text))),
    };
  }

  /** What a session of project `r` starts with: the memory of `you`, then the project's `MEMORY.md`. */
  injected(r: ProjectRef, lead: boolean, you: You): string {
    const target = youTarget(you);
    const user = target ? this.read(target) : "";
    const project = this.read(projectTarget(r));
    if (!user.trim() && !project.trim()) return "";
    let out = "## Memory\n";
    out += lead
      ? "What you remembered in earlier sessions, with `remember`. Open a topic with `memory_read`."
      : "What fleetd remembers about the human and this project. Follow it.";
    for (const [title, text] of [
      ["How the human works (user.md)", user],
      ["This project (MEMORY.md)", project],
    ] as const) {
      if (text.trim()) out += `\n\n### ${title}\n${text.trimEnd()}`;
    }
    return out;
  }

  /** Copies the shared `user.md` to `owner`'s own memory, once per hub. */
  migrateShared(owner: PersonId): boolean {
    this.root();
    if (this.db.all<{ done: number }>("SELECT EXISTS (SELECT 1 FROM memory_settings WHERE key = ?1) AS done", [MIGRATED_KEY])[0]?.done) {
      return false;
    }
    const shared = this.read(userTarget());
    const mine = userTarget(owner);
    const copied = shared.trim() !== "" && this.read(mine).trim() === "";
    if (copied) writeAtomic(this.path(mine) as string, shared);
    this.db.conn.query("INSERT INTO memory_settings (key, value) VALUES (?1, 1) ON CONFLICT (key) DO NOTHING").run(MIGRATED_KEY);
    return copied;
  }
}

/** Whose "You" memory a session reads: a person's own, the shared `user.md`, or no one's. */
export type You = { kind: "person"; person: PersonId } | { kind: "shared" } | { kind: "nobody" };

export function youTarget(you: You): Target | undefined {
  if (you.kind === "person") return userTarget(you.person);
  return you.kind === "shared" ? userTarget() : undefined;
}

/** The hub's people still on it, oldest first (people/mod.rs `active`). */
export function activePeople(db: HubDb): { personId: PersonId; role: string }[] {
  return db
    .all<{ person_id: string; role: string }>("SELECT person_id, role FROM people WHERE removed_ms IS NULL ORDER BY created_ms, rowid")
    .map((p) => ({ personId: p.person_id, role: p.role }));
}

/** `person` (one still on the hub) when there is one; else the shared file, the only person, or nobody. */
export function youOf(db: HubDb, person: PersonId | undefined): You {
  const people = activePeople(db);
  if (person !== undefined && people.some((p) => p.personId === person)) return { kind: "person", person };
  if (people.length === 0) return { kind: "shared" };
  if (people.length === 1) return { kind: "person", person: (people[0] as { personId: string }).personId };
  return { kind: "nobody" };
}

/** A Navi's owner, else the hub owner for one with none (claude_accounts `navi_owner`). */
export function naviOwner(db: HubDb, r: ProjectRef): PersonId | undefined {
  const navi = kept(db.conn, r);
  if (!navi?.onlyMe) return undefined;
  return navi.owner ?? activePeople(db).find((p) => p.role === "owner")?.personId;
}

/** A lead's, for its whole session: a Navi's owner's; else only on a one-person hub. */
export const youForLead = (db: HubDb, r: ProjectRef) => youOf(db, naviOwner(db, r));

/** A task's, in project `r` for `order`: its Navi's owner's, else that of whoever started the order. */
export function youForTask(db: HubDb, r: ProjectRef, order: string): You {
  const owner = naviOwner(db, r);
  if (owner !== undefined) return youOf(db, owner);
  const n = Number.parseInt(order.slice(1), 10) || 0;
  const started = db.all<{ p: string | null }>("SELECT json_extract(data, '$.startedBy.personId') AS p FROM workstreams WHERE n = ?", [n])[0]?.p;
  const known = started && activePeople(db).some((p) => p.personId === started) ? started : undefined;
  return youOf(db, known);
}

/** The remembered lines of the chats a file belongs to, and the nightly refresh's lines, newest first. */
function notes(db: HubDb, t: Target): MemoryNote[] {
  const rows = db.all<{ data: string }>(
    `SELECT data FROM chat_messages
     WHERE (json_type(data, '$.remembered') IS NOT NULL OR json_type(data, '$.memoryRefreshed') IS NOT NULL)
     AND (?1 IS NULL OR (machine_id = ?1 AND project_id = ?2)) ORDER BY n DESC LIMIT 400`,
    [t.project?.machineId ?? null, t.project?.projectId ?? null],
  );
  const out: MemoryNote[] = [];
  for (const row of rows) {
    let m: ChatMessage;
    try {
      m = JSON.parse(row.data) as ChatMessage;
    } catch {
      continue;
    }
    const items = [...(m.remembered ? [m.remembered] : []), ...(m.memoryRefreshed?.items ?? [])];
    for (const item of items) {
      if (item.undone === true || item.forgotten === true || item.scope !== scopeOf(t) || item.topic !== t.topic || item.person !== t.person) continue;
      if (out.length < 200) out.push({ text: item.text, at: m.createdAt, projectRef: m.projectRef, messageId: m.messageId });
    }
  }
  return out;
}
