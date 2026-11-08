// Worktrees and checkouts (crates/fleetd/src/node/worktree.rs): a writer's worktree on a new branch, a reader's
// detached one, the base it starts from, what a session changed, and their removal. Git runs with no prompt for
// credentials or an editor; git that talks to a remote never waits on ssh and is killed at its timeout.
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

export class GitError extends Error {}

const LS_REMOTE_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 20_000;
const HEAD_FRESH_MS = 3600_000;

const gitEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_EDITOR: "true",
  ...extra,
});

const failed = (args: string[], stderr: string) => new GitError(`git ${args.join(" ")} failed: ${stderr.trim()}`);

/** `git -C dir args…`, its stdout; throws GitError with git's stderr. */
export function git(dir: string, args: string[]): string {
  const out = spawnSync("git", ["-C", dir, ...args], { env: gitEnv(), encoding: "utf8", maxBuffer: 256 << 20 });
  if (out.error) throw new GitError(`cannot run git: ${out.error.message}`);
  if (out.status !== 0) throw failed(args, out.stderr ?? "");
  return out.stdout ?? "";
}

const tryGit = (dir: string, args: string[]) => {
  try {
    return git(dir, args);
  } catch {
    return undefined;
  }
};

/** git that talks to a remote, in a process group of its own killed at `timeoutMs`. */
export function gitRemote(dir: string, args: string[], timeoutMs: number): Promise<string> {
  const sshSet = process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || tryGit(dir, ["config", "--get", "core.sshCommand"])?.trim();
  const env = gitEnv(sshSet ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" });
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", dir, ...args], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b));
    child.stderr.on("data", (b: Buffer) => (stderr += b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("error", (e) => (clearTimeout(timer), reject(new GitError(`cannot run git: ${e.message}`))));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new GitError(`git ${args.join(" ")} failed: timed out after ${Math.round(timeoutMs / 1000)} s`));
      else if (code === 0) resolve(stdout);
      else reject(failed(args, stderr));
    });
  });
}

export const refSha = (root: string, name: string) => tryGit(root, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`])?.trim() || undefined;

/** The remote worktrees are based on: `origin`, else the only remote. */
export function remote(root: string): string | undefined {
  const remotes = (tryGit(root, ["remote"]) ?? "").split("\n").filter(Boolean);
  if (remotes.length === 1) return remotes[0];
  return remotes.includes("origin") ? "origin" : undefined;
}

const currentBranch = (root: string) => tryGit(root, ["symbolic-ref", "--short", "HEAD"])?.trim() || undefined;

function cachedHead(root: string, remoteName: string): string | undefined {
  const head = tryGit(root, ["symbolic-ref", "--short", `refs/remotes/${remoteName}/HEAD`])?.trim();
  return head?.startsWith(`${remoteName}/`) ? head.slice(remoteName.length + 1) || undefined : undefined;
}

/** What each repo's remote last said its default branch is: `null` when it answered but named none. */
const heads = new Map<string, { at: number; name: string | null }>();

/** What the remote says its default branch is, asked at most hourly; undefined when it couldn't be asked. */
async function askedHead(root: string, remoteName: string): Promise<string | null | undefined> {
  const key = `${root}\0${remoteName}`;
  const said = heads.get(key);
  if (said && Date.now() - said.at < HEAD_FRESH_MS) return said.name;
  let out: string;
  try {
    out = await gitRemote(root, ["ls-remote", "--symref", remoteName, "HEAD"], LS_REMOTE_TIMEOUT_MS);
  } catch {
    return undefined;
  }
  let name: string | null = null;
  for (const line of out.split("\n")) {
    const m = /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line);
    if (m) name = m[1]!;
  }
  if (name !== null && cachedHead(root, remoteName) !== name) tryGit(root, ["remote", "set-head", remoteName, name]);
  heads.set(key, { at: Date.now(), name });
  return name;
}

/** Whether the repo has any commit, on any branch or remote-tracking ref. */
export const hasCommit = (root: string) => (tryGit(root, ["rev-list", "-n", "1", "--all"]) ?? "").trim() !== "";

/** The repo's default branch: the remote's, else the branch checked out at `root`. */
export async function defaultBranch(root: string): Promise<string | undefined> {
  const r = remote(root);
  if (r) {
    const asked = await askedHead(root, r);
    const name = asked ?? cachedHead(root, r);
    if (name) return name;
  }
  return currentBranch(root);
}

/** The branch checked out at `path` when it is a worktree of `root` (`null`: detached); undefined when it isn't one. */
function worktreeBranch(root: string, path: string): string | null | undefined {
  const list = git(root, ["worktree", "list", "--porcelain"]);
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const want = real(path);
  let current: string | undefined;
  let found: string | null = null;
  for (const line of [...list.split("\n"), ""]) {
    if (line.startsWith("worktree ")) {
      current = real(line.slice(9));
      found = null;
    } else if (line.startsWith("branch refs/heads/")) found = line.slice(18);
    else if (line === "" && current === want) return found;
  }
  return undefined;
}

const branchExists = (root: string, branch: string) => tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== undefined;

/** Makes `path` a worktree of `root` on `branch`: reuses one, checks out an existing branch, else makes it at `start`. */
export function ensure(root: string, path: string, branch: string, start: string): void {
  const on = worktreeBranch(root, path);
  if (on === branch) return;
  if (on !== undefined) throw new GitError(`${path} is already a worktree on ${on ?? "a detached HEAD"}, not ${branch}`);
  if (existsSync(path)) throw new GitError(`${path} exists and is not a worktree of ${root}`);
  mkdirSync(dirname(path), { recursive: true });
  if (branchExists(root, branch)) git(root, ["worktree", "add", path, branch]);
  else git(root, ["worktree", "add", "--no-track", "-b", branch, path, start]);
}

/** A detached worktree at `start`, for a read or review task. */
export function ensureDetached(root: string, path: string, start: string): void {
  const on = worktreeBranch(root, path);
  if (on === null && existsSync(path)) return;
  if (on === null) git(root, ["worktree", "remove", "--force", path]);
  else if (on !== undefined) throw new GitError(`${path} is already a worktree on ${on}, not detached`);
  if (existsSync(path)) throw new GitError(`${path} exists and is not a worktree of ${root}`);
  mkdirSync(dirname(path), { recursive: true });
  git(root, ["worktree", "add", "--detach", path, start]);
}

export function removeDetached(root: string, path: string): void {
  if (worktreeBranch(root, path) !== undefined) git(root, ["worktree", "remove", "--force", path]);
}

export const uncommitted = (path: string) => git(path, ["status", "--porcelain"]).trim() !== "";

export const KEPT = "kept ";
export const UNCOMMITTED = "it has uncommitted changes";
export const UNPUSHED = "not pushed";

/** Removes the worktree, and its branch only when `baseRef` contains it; refuses while it holds work found nowhere
 * else. Whether the branch was deleted. */
export function remove(root: string, path: string, branch: string, baseRef: string): boolean {
  if (worktreeBranch(root, path) !== undefined) {
    if (git(path, ["status", "--porcelain"]).trim()) throw new GitError(`${KEPT}${path}: ${UNCOMMITTED}`);
    const unpushed = git(path, ["rev-list", "--count", "HEAD", "--not", "--remotes", baseRef]).trim();
    if (unpushed !== "0") throw new GitError(`${KEPT}${path}: ${unpushed} commit(s) ${UNPUSHED}`);
    git(root, ["worktree", "remove", "--force", path]);
  }
  const merged = branchExists(root, branch) && tryGit(root, ["merge-base", "--is-ancestor", branch, baseRef]) !== undefined;
  if (merged) git(root, ["branch", "-D", branch]);
  return merged;
}

/** Removes every worktree of `root` that git records under `dir`, then `dir`. How many it removed. */
export function removeAll(root: string, dir: string): number {
  let removed = 0;
  if (existsSync(root) && statSync(root).isDirectory() && tryGit(root, ["rev-parse", "--git-dir"]) !== undefined && existsSync(dir)) {
    const real = realpathSync(dir);
    const list = git(root, ["worktree", "list", "--porcelain"]);
    for (const line of list.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const p = line.slice(9);
      if (p.startsWith(`${real}/`) || p.startsWith(`${dir}/`)) {
        tryGit(root, ["worktree", "remove", "--force", p]);
        removed++;
      }
    }
  }
  return removed;
}

/** Repo-relative paths the work at `cwd` touched: committed since its merge base with `baseRef`, plus `git status`. */
export function changes(cwd: string, baseRef?: string): string[] {
  const paths = new Set<string>();
  if (baseRef) {
    const base = git(cwd, ["merge-base", baseRef, "HEAD"]).trim();
    for (const l of git(cwd, ["diff", "--name-only", base, "HEAD"]).split("\n")) if (l) paths.add(l);
  }
  const status = git(cwd, ["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all"]);
  const entries = status.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    paths.add(entry.slice(3));
    if ((entry.startsWith("R") || entry.startsWith("C")) && i + 1 < entries.length) paths.add(entries[++i]!);
  }
  return [...paths].sort();
}

/** What a worktree's changes are measured from: the remote's copy of the branch its PRs target, as last fetched. */
export function changesBase(root: string, recorded: string): string {
  const r = remote(root);
  if (!r) return recorded;
  const name = recorded.startsWith(`${r}/`) ? recorded.slice(r.length + 1) : recorded;
  const tracking = `${r}/${name}`;
  return refSha(root, `refs/remotes/${tracking}`) ? tracking : recorded;
}

export type BaseErrorKind = "offline" | "auth" | "no_access" | "no_ssh" | "no_default_branch" | "no_remote" | "failed";
export type Base = {
  baseRef: string;
  sha: string;
  fetchedAt?: string;
  error?: { kind: BaseErrorKind; message: string };
  note?: string;
};

/** Why a fetch failed, from git's stderr (worktree.rs `FetchError::of`). */
function fetchError(message: string): { kind: BaseErrorKind; message: string } {
  const m = message.toLowerCase();
  const first = message.split("\n").find((l) => l.trim()) ?? message;
  if (/could not resolve host|connection refused|connection reset|timed out|network is unreachable|no route to host|connection timed out|could not read from remote/.test(m) && !/permission denied|authentication/.test(m))
    return { kind: "offline", message: "offline" };
  if (/authentication failed|permission denied|could not read username|terminal prompts disabled/.test(m)) return { kind: "auth", message: first };
  if (/repository not found|does not appear to be a git repository/.test(m)) return { kind: "no_access", message: first };
  if (/ssh: not found|cannot run ssh/.test(m)) return { kind: "no_ssh", message: first };
  return { kind: "failed", message: first };
}

const rfc3339 = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

/** Where a new writer's branch starts: the remote's `name`, freshly fetched; offline or refused, the last fetched
 * copy, else the local branch, each with an error saying so. With no remote, the local `name` or the current branch. */
export async function freshBase(root: string, name: string): Promise<Base> {
  const r = remote(root);
  if (!r) {
    const local = refSha(root, `refs/heads/${name}`) ? name : currentBranch(root);
    if (!local) throw new GitError(`${root} has no branch to start from`);
    const sha = refSha(root, `refs/heads/${local}`);
    if (!sha) throw new GitError(`${root} has no commit on ${local}`);
    return { baseRef: local, sha, note: `no remote: from local ${local}`, error: { kind: "no_remote", message: "no remote" } };
  }
  const tracking = `${r}/${name}`;
  let why: { kind: BaseErrorKind; message: string } | undefined;
  try {
    await gitRemote(root, ["fetch", "--no-tags", r, `+refs/heads/${name}:refs/remotes/${r}/${name}`], FETCH_TIMEOUT_MS);
  } catch (error) {
    why = fetchError((error as Error).message);
  }
  const sha = refSha(root, `refs/remotes/${tracking}`);
  if (!why && sha) {
    if (!cachedHead(root, r)) tryGit(root, ["remote", "set-head", r, name]);
    return { baseRef: tracking, sha, fetchedAt: rfc3339(Date.now()) };
  }
  const error = why ?? { kind: "failed" as const, message: `${tracking} is missing after the fetch` };
  const said = error.kind === "offline" ? "offline" : error.message;
  if (sha) return { baseRef: tracking, sha, error, note: `based on ${tracking} (fetch failed: ${said})` };
  const local = refSha(root, `refs/heads/${name}`);
  if (local) return { baseRef: name, sha: local, error, note: `based on local ${name} (fetch failed: ${said})` };
  throw new GitError(`can't reach ${r} and have no copy of ${tracking} (fetch failed: ${said})`);
}

/** A commit this checkout already has. */
export const knownCommit = (root: string, sha: string) => refSha(root, sha);

/** What is left of a lost worktree's branch, best first (worktree.rs `Source`). */
export type Source =
  /** The local branch. */
  | { kind: "local" }
  /** The local branch is gone; `<remote>/<branch>`, freshly fetched, holds what was pushed. */
  | { kind: "remote"; remote: string }
  /** Nothing of the branch is left, here or on a remote: a new branch at `sha`, as for a new task. */
  | { kind: "base"; baseRef: string; sha: string };

/** What the session's agent is told, ahead of its next message, once its worktree came back from `from`. */
export function sourceNote(from: Source, branch: string): string {
  switch (from.kind) {
    case "local":
      return `fleetd: your worktree was gone, so it was recreated at the same path from your local branch ${branch}. Your commits are there; uncommitted changes from before are gone.`;
    case "remote":
      return `fleetd: your worktree and its local branch were gone, so the worktree was recreated at the same path from ${from.remote}/${branch}, freshly fetched. What you pushed is there; unpushed commits and uncommitted changes from before are gone.`;
    case "base":
      return `fleetd: your worktree was gone and ${branch} was neither here nor pushed, so the worktree was recreated at the same path on a new ${branch} from ${from.baseRef}. Work that is not in ${from.baseRef} is gone.`;
  }
}

/** The remote that holds `branch` as pushed, `origin` first, after fetching it from each. A remote that can't be
 * reached keeps its last fetched copy, which still holds what was pushed by then. */
async function pushed(root: string, branch: string): Promise<string | undefined> {
  const remotes = (tryGit(root, ["remote"]) ?? "").split("\n").filter(Boolean);
  remotes.sort((a, b) => Number(a !== "origin") - Number(b !== "origin"));
  for (const r of remotes) {
    try {
      await gitRemote(root, ["fetch", "--no-tags", r, `+refs/heads/${branch}:refs/remotes/${r}/${branch}`], FETCH_TIMEOUT_MS);
    } catch {}
    if (refSha(root, `refs/remotes/${r}/${branch}`)) return r;
  }
  return undefined;
}

/** Where a lost worktree of `branch` comes back from: the local branch, else the branch as pushed, else a fresh fetch
 * of the default branch `baseRef` names, as a new task starts. */
export async function source(root: string, branch: string, baseRef: string): Promise<Source> {
  if (branchExists(root, branch)) return { kind: "local" };
  const r = await pushed(root, branch);
  if (r) return { kind: "remote", remote: r };
  const rem = remote(root);
  const name = rem && baseRef.startsWith(`${rem}/`) ? baseRef.slice(rem.length + 1) : baseRef;
  const base = await freshBase(root, name);
  return { kind: "base", baseRef: base.baseRef, sha: base.sha };
}

/** Brings back a session's worktree that is gone, at the same path so `claude --resume` still finds its session. */
export function restore(root: string, path: string, branch: string, from: Source): void {
  // A worktree whose directory was deleted stays registered, holding its path and branch: only this one record goes.
  if (!existsSync(path)) tryGit(root, ["worktree", "remove", "--force", path]);
  const start = from.kind === "local" ? branch : from.kind === "remote" ? `refs/remotes/${from.remote}/${branch}` : from.sha;
  ensure(root, path, branch, start);
}
