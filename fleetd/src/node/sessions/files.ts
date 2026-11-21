// A project's files for its chat and its sessions: @-mention search over
// git's file list, and the attachments the hub places under `.fleetd/attachments/`, kept out of git.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, sep } from "node:path";
import { git } from "../worktree/index.ts";
import { ATTACHMENTS_DIR, attachmentPathOk, MAX_FILES } from "./file_rules.ts";

export { ATTACHMENTS_DIR, attachmentPathOk, rank, score } from "./file_rules.ts";

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
  await excludeInCheckout(root, ATTACHMENTS_DIR);
}

/** `/<dir>` (a dir of fleetd's in the checkout, `.fleetd/attachments/`) in the checkout's `.git/info/exclude`, once.
 * False where the checkout isn't git's. */
export async function excludeInCheckout(root: string, dir: string): Promise<boolean> {
  let file: string;
  try {
    file = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])).trim();
  } catch {
    return false;
  }
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split("\n").some((l) => l.trim() === `/${dir}`)) return true;
  mkdirSync(join(file, ".."), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}/${dir}\n`);
  return true;
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
    throw Object.assign(new Error(`${path} is not a path inside the bot`), { code: "invalid" });
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
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw Object.assign(new Error(`${path} leads outside the bot`), { code: "invalid" });
  if (statSync(real).size > 1024 * 1024) throw Object.assign(new Error(`${path} is larger than 1 MiB`), { code: "invalid" });
  return readFileSync(real, "utf8");
}
