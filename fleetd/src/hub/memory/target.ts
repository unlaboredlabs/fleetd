// Which memory file a call means and its limits, without the disk (index.ts reads and writes the files): the scopes'
// files and caps, a target and its file's name, a project's directory name, the lines of a file, and whose "You"
// memory a session reads.
import type { MemoryCaps, MemoryScope, PersonId, ProjectRef } from "../../shared/contracts.ts";

export const USER_FILE = "user.md";
export const INDEX_FILE = "MEMORY.md";
export const PEOPLE_DIR = "people";
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
/** A project's directory name: its id when that is a plain file name, else a hash of it. */
export function projectDirName(r: ProjectRef): string {
  const id = r.projectId;
  if (Buffer.byteLength(id) <= 128 && !id.startsWith(".") && /^[A-Za-z0-9._-]*$/.test(id)) return id;
  return `p-${new Bun.CryptoHasher("sha256").update(id).digest("hex").slice(0, 16)}`;
}

/** Rust's `str::lines`: split on \n, a trailing \r dropped, no last empty line. */
export function linesOf(text: string): string[] {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Whose "You" memory a session reads: a person's own, the shared `user.md`, or no one's. */
export type You = { kind: "person"; person: PersonId } | { kind: "shared" } | { kind: "nobody" };

export function youTarget(you: You): Target | undefined {
  if (you.kind === "person") return userTarget(you.person);
  return you.kind === "shared" ? userTarget() : undefined;
}
