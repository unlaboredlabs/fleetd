// A project's files for its chat and its sessions (crates/fleetd/src/node/sessions/files.rs): @-mention search over
// git's file list, and the attachments the hub places under `.fleetd/attachments/`, kept out of git.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, sep } from "node:path";
import { git } from "../worktree/index.ts";

export const ATTACHMENTS_DIR = ".fleetd/attachments/";
const MAX_FILES = 200_000;
/** Files looked at at once. */
const LSTAT_BATCH = 256;

/** `git ls-files -co --exclude-standard`, symlinks left out; off the event loop, as a big repo's list takes a while. */
export async function gitFiles(root: string): Promise<string[]> {
  const listed = (await git(root, ["ls-files", "-co", "--exclude-standard", "-z"])).split("\0").filter(Boolean).slice(0, MAX_FILES);
  const kept: string[] = [];
  for (let i = 0; i < listed.length; i += LSTAT_BATCH) {
    const batch = listed.slice(i, i + LSTAT_BATCH);
    const plain = await Promise.all(batch.map((p) => lstat(join(root, p)).then((st) => !st.isSymbolicLink(), () => false)));
    for (const [j, p] of batch.entries()) if (plain[j]) kept.push(p);
  }
  return kept;
}

function walk(lower: string[], from: number, nameStart: number, query: string[]): number | undefined {
  let score = 0;
  let at = from;
  let last: number | undefined;
  for (const q of query) {
    let found = -1;
    for (let i = at; i < lower.length; i++)
      if (lower[i] === q) {
        found = i;
        break;
      }
    if (found < 0) return undefined;
    score += 1;
    if (last !== undefined && last + 1 === found) score += 5;
    if (found >= nameStart) score += 3;
    if (found === 0 || "/_-.".includes(lower[found - 1]!)) score += 4;
    last = found;
    at = found + 1;
  }
  return score;
}

/** How well `query` matches `path` as a subsequence; undefined when it doesn't. Higher is better. */
export function score(path: string, query: string): number | undefined {
  const lower = [...path.toLowerCase()];
  const q = [...query.toLowerCase()].filter((c) => !/\s/.test(c));
  const slash = lower.lastIndexOf("/");
  const nameStart = slash < 0 ? 0 : slash + 1;
  const scores = [nameStart, 0].map((from) => walk(lower, from, nameStart, q)).filter((s): s is number => s !== undefined);
  return scores.length ? Math.max(...scores) * 1000 - lower.length : undefined;
}

/** The best `limit` paths for `query`, and whether more matched. */
export function rank(paths: string[], query: string, limit: number): [string[], boolean] {
  const scored = paths.flatMap((p) => {
    const s = score(p, query);
    return s === undefined ? [] : [[s, p] as const];
  });
  scored.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return [scored.slice(0, limit).map(([, p]) => p), scored.length > limit];
}

/** `relPath` stays inside `.fleetd/attachments/`. */
export function attachmentPathOk(relPath: string): boolean {
  const parts = relPath.split("/");
  return relPath.startsWith(ATTACHMENTS_DIR) && parts.every((p) => p !== "" && p !== "." && p !== "..") && parts.length >= 4;
}

/** Writes the file, creating its directories, never through a symlink, and keeps attachments out of git. */
export async function putFile(root: string, relPath: string, bytes: Uint8Array): Promise<void> {
  if (!attachmentPathOk(relPath)) throw new Error(`${relPath} is not under ${ATTACHMENTS_DIR}`);
  const parts = relPath.split("/");
  const name = parts.pop()!;
  let dir = root;
  let walked = "";
  for (const part of parts) {
    dir = join(dir, part);
    walked = walked ? `${walked}/${part}` : part;
    try {
      mkdirSync(dir, { mode: 0o755 });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw new Error(`${walked}: ${(error as Error).message}`);
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${walked} is a symlink or not a directory; refusing to write through it`);
  }
  const tmp = join(dir, `.${name}.fleetd-part-${process.pid}`);
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, join(dir, name));
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  await excludeAttachments(root);
}

/** `.fleetd/attachments/` in the checkout's `.git/info/exclude`, once. */
async function excludeAttachments(root: string): Promise<void> {
  let file: string;
  try {
    file = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])).trim();
  } catch {
    return;
  }
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split("\n").some((l) => l.trim() === `/${ATTACHMENTS_DIR}`)) return;
  mkdirSync(join(file, ".."), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}/${ATTACHMENTS_DIR}\n`);
}

/** Whether `relPath` is a plain file holding the bytes whose sha256 is `sha256`. */
export function hasFile(root: string, relPath: string, sha256: string): boolean {
  if (!attachmentPathOk(relPath)) return false;
  try {
    const real = realpathSync(join(root, relPath));
    if (real !== join(realpathSync(root), relPath) || !statSync(real).isFile()) return false;
    return createHash("sha256").update(readFileSync(real)).digest("hex") === sha256;
  } catch {
    return false;
  }
}

/** A file under the project's root, at most 1 MiB, never through a symlink out of it. */
export function readProjectFile(root: string, path: string): string | undefined {
  if (path.startsWith("/") || path.split("/").some((p) => p === ".."))
    throw Object.assign(new Error(`${path} is not a path inside the project`), { code: "invalid" });
  let real: string;
  try {
    real = realpathSync(join(root, path));
  } catch {
    return undefined;
  }
  let rootReal = root;
  try {
    rootReal = realpathSync(root);
  } catch {}
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw Object.assign(new Error(`${path} leads outside the project`), { code: "invalid" });
  if (statSync(real).size > 1024 * 1024) throw Object.assign(new Error(`${path} is larger than 1 MiB`), { code: "invalid" });
  return readFileSync(real, "utf8");
}
