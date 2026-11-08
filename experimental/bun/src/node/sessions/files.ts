// A project's files for its chat and its sessions (crates/fleetd/src/node/sessions/files.rs): @-mention search over
// git's file list, and the attachments the hub places under `.fleetd/attachments/`, kept out of git.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join, sep } from "node:path";

export const ATTACHMENTS_DIR = ".fleetd/attachments/";
const MAX_FILES = 200_000;

/** `git ls-files -co --exclude-standard`, symlinks left out. */
export function gitFiles(root: string): string[] {
  const out = spawnSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"], { maxBuffer: 512 << 20 });
  if (out.error) throw new Error(`git did not run: ${out.error.message}`);
  if (out.status !== 0) throw new Error(out.stderr.toString().trim());
  return out.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .slice(0, MAX_FILES)
    .filter((p) => {
      try {
        return !lstatSync(join(root, p)).isSymbolicLink();
      } catch {
        return false;
      }
    });
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
export function putFile(root: string, relPath: string, bytes: Uint8Array): void {
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
  excludeAttachments(root);
}

/** `.fleetd/attachments/` in the checkout's `.git/info/exclude`, once. */
function excludeAttachments(root: string): void {
  const out = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { encoding: "utf8" });
  if (out.status !== 0) return;
  const file = out.stdout.trim();
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
