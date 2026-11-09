// Worktrees and checkouts (crates/fleetd/src/node/worktree.rs): a writer's worktree on a new branch, a reader's
// detached one, the base it starts from, what a session changed, and their removal. Git runs with no prompt for
// credentials or an editor; git that talks to a remote never waits on ssh and is killed at its timeout. Every git runs
// off the event loop: a worktree add that takes a minute under load never stalls the node's link or its sessions.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { inTurn } from "../util.ts";

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

/** The git config key a checkout fleetd cloned with a GitHub token carries (a cloud machine's, D306): its remote calls
 * authenticate with the latest token an order's launch brought (useToken). Every other checkout uses the machine's own
 * git login. */
export const TOKEN_MARK = "fleetd.githubToken";

/** Per checkout root, the GitHub token its remote calls use: the newest an order's launch there brought. */
const tokens = new Map<string, string>();

/** Has git authenticate to github.com with `token` through its environment only, as actions/checkout does: never in
 * its arguments, where the process list shows it, nor in the repo's config, where agents and boat's snapshots would
 * keep it. */
export const tokenEnv = (token: string): Record<string, string> => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
});

/** Has the checkout at `root`'s remote calls use `token` from now on, when fleetd cloned it with one (TOKEN_MARK). A
 * placeholder the hub hands agents in place of a token taken back (`fleetd-github-…`) is never used: the last real one
 * goes on until it ends. */
export async function useToken(root: string, token: string): Promise<void> {
  if (!token || token.startsWith("fleetd-")) return;
  if ((await tryGit(root, ["config", "--bool", "--get", TOKEN_MARK]))?.trim() === "true") tokens.set(root, token);
}

/** What a remote call in `dir` adds to git's environment: its checkout's token, when it has one. */
export const remoteEnv = (dir: string): Record<string, string> => {
  const token = tokens.get(dir);
  return token ? tokenEnv(token) : {};
};

const failed = (args: string[], stderr: string) => new GitError(`git ${args.join(" ")} failed: ${stderr.trim()}`);

/** `git -C dir args…`, its stdout; throws GitError with git's stderr. */
export async function git(dir: string, args: string[]): Promise<string> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(["git", "-C", dir, ...args], { env: gitEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new GitError(`cannot run git: ${(error as Error).message}`);
  }
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw failed(args, stderr);
  return stdout;
}

const tryGit = (dir: string, args: string[]) => git(dir, args).catch(() => undefined);

/** Each checkout's worktree changes, one after another: `git worktree add` and `remove` in one repo take turns, as
 * they did when git ran on the event loop, so a check of a path and its add never interleave with another's. */
const turns = new Map<string, Promise<unknown>>();
const serial = <T>(root: string, fn: () => Promise<T>) => inTurn(turns, root, fn);

/** git that talks to a remote, in a process group of its own killed at `timeoutMs`. */
export async function gitRemote(dir: string, args: string[], timeoutMs: number): Promise<string> {
  const sshSet = process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || (await tryGit(dir, ["config", "--get", "core.sshCommand"]))?.trim();
  const env = gitEnv({ ...(sshSet ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" }), ...remoteEnv(dir) });
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

export const refSha = async (root: string, name: string) => (await tryGit(root, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]))?.trim() || undefined;

/** The remote worktrees are based on: `origin`, else the only remote. */
export async function remote(root: string): Promise<string | undefined> {
  const remotes = ((await tryGit(root, ["remote"])) ?? "").split("\n").filter(Boolean);
  if (remotes.length === 1) return remotes[0];
  return remotes.includes("origin") ? "origin" : undefined;
}

const currentBranch = async (root: string) => (await tryGit(root, ["symbolic-ref", "--short", "HEAD"]))?.trim() || undefined;

async function cachedHead(root: string, remoteName: string): Promise<string | undefined> {
  const head = (await tryGit(root, ["symbolic-ref", "--short", `refs/remotes/${remoteName}/HEAD`]))?.trim();
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
  if (name !== null && (await cachedHead(root, remoteName)) !== name) await tryGit(root, ["remote", "set-head", remoteName, name]);
  heads.set(key, { at: Date.now(), name });
  return name;
}

/** Whether the repo has any commit, on any branch or remote-tracking ref. */
export const hasCommit = async (root: string) => ((await tryGit(root, ["rev-list", "-n", "1", "--all"])) ?? "").trim() !== "";

/** The repo's default branch: the remote's, else the branch checked out at `root`. */
export async function defaultBranch(root: string): Promise<string | undefined> {
  const r = await remote(root);
  if (r) {
    const asked = await askedHead(root, r);
    const name = asked ?? (await cachedHead(root, r));
    if (name) return name;
  }
  return currentBranch(root);
}

/** The branch checked out at `path` when it is a worktree of `root` (`null`: detached); undefined when it isn't one. */
async function worktreeBranch(root: string, path: string): Promise<string | null | undefined> {
  const list = await git(root, ["worktree", "list", "--porcelain"]);
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

const branchExists = async (root: string, branch: string) => (await tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !== undefined;

/** Makes `path` a worktree of `root` on `branch`: reuses one, checks out an existing branch, else makes it at `start`. */
export const ensure = (root: string, path: string, branch: string, start: string): Promise<void> =>
  serial(root, async () => {
    const on = await worktreeBranch(root, path);
    if (on === branch) return;
    if (on !== undefined) throw new GitError(`${path} is already a worktree on ${on ?? "a detached HEAD"}, not ${branch}`);
    if (existsSync(path)) throw new GitError(`${path} exists and is not a worktree of ${root}`);
    mkdirSync(dirname(path), { recursive: true });
    if (await branchExists(root, branch)) await git(root, ["worktree", "add", path, branch]);
    else await git(root, ["worktree", "add", "--no-track", "-b", branch, path, start]);
  });

/** A detached worktree at `start`, for a read or review task. */
export const ensureDetached = (root: string, path: string, start: string): Promise<void> =>
  serial(root, async () => {
    const on = await worktreeBranch(root, path);
    if (on === null && existsSync(path)) return;
    if (on === null) await git(root, ["worktree", "remove", "--force", path]);
    else if (on !== undefined) throw new GitError(`${path} is already a worktree on ${on}, not detached`);
    if (existsSync(path)) throw new GitError(`${path} exists and is not a worktree of ${root}`);
    mkdirSync(dirname(path), { recursive: true });
    await git(root, ["worktree", "add", "--detach", path, start]);
  });

export const removeDetached = (root: string, path: string): Promise<void> =>
  serial(root, async () => {
    if ((await worktreeBranch(root, path)) !== undefined) await git(root, ["worktree", "remove", "--force", path]);
  });

export const uncommitted = async (path: string) => (await git(path, ["status", "--porcelain"])).trim() !== "";

/** Worktrees `uncommittedAll` asks git about at once. */
const STATUS_AT_ONCE = 8;

/**
 * Whether each worktree holds uncommitted changes, `git status` on up to STATUS_AT_ONCE of them at a time: one after
 * another, a project's 120 worktrees took 1.2 s (project_settings_get, Settings › Project). A worktree git can't read
 * counts as holding work.
 */
export async function uncommittedAll(paths: string[]): Promise<boolean[]> {
  const out = paths.map(() => true);
  let next = 0;
  const lane = async () => {
    for (let i = next++; i < paths.length; i = next++) out[i] = await uncommitted(paths[i] as string).catch(() => true);
  };
  await Promise.all(Array.from({ length: Math.min(STATUS_AT_ONCE, paths.length) }, lane));
  return out;
}

export const KEPT = "kept ";
export const UNCOMMITTED = "it has uncommitted changes";
export const UNPUSHED = "not pushed";

/** Removes the worktree, and its branch only when `baseRef` contains it; refuses while it holds work found nowhere
 * else. Whether the branch was deleted. */
export const remove = (root: string, path: string, branch: string, baseRef: string): Promise<boolean> =>
  serial(root, async () => {
    if ((await worktreeBranch(root, path)) !== undefined) {
      if ((await git(path, ["status", "--porcelain"])).trim()) throw new GitError(`${KEPT}${path}: ${UNCOMMITTED}`);
      const unpushed = (await git(path, ["rev-list", "--count", "HEAD", "--not", "--remotes", baseRef])).trim();
      if (unpushed !== "0") throw new GitError(`${KEPT}${path}: ${unpushed} commit(s) ${UNPUSHED}`);
      await git(root, ["worktree", "remove", "--force", path]);
    }
    const merged = (await branchExists(root, branch)) && (await tryGit(root, ["merge-base", "--is-ancestor", branch, baseRef])) !== undefined;
    if (merged) await git(root, ["branch", "-D", branch]);
    return merged;
  });

/** Removes every worktree of `root` that git records under `dir`, then `dir`. How many it removed. */
export const removeAll = (root: string, dir: string): Promise<number> =>
  serial(root, async () => {
    let removed = 0;
    if (existsSync(root) && statSync(root).isDirectory() && (await tryGit(root, ["rev-parse", "--git-dir"])) !== undefined && existsSync(dir)) {
      const real = realpathSync(dir);
      const list = await git(root, ["worktree", "list", "--porcelain"]);
      for (const line of list.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const p = line.slice(9);
        if (p.startsWith(`${real}/`) || p.startsWith(`${dir}/`)) {
          await tryGit(root, ["worktree", "remove", "--force", p]);
          removed++;
        }
      }
    }
    return removed;
  });

/** Repo-relative paths the work at `cwd` touched: committed since its merge base with `baseRef`, plus `git status`. */
export async function changes(cwd: string, baseRef?: string): Promise<string[]> {
  const paths = new Set<string>();
  if (baseRef) {
    const base = (await git(cwd, ["merge-base", baseRef, "HEAD"])).trim();
    for (const l of (await git(cwd, ["diff", "--name-only", base, "HEAD"])).split("\n")) if (l) paths.add(l);
  }
  const status = await git(cwd, ["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all"]);
  const entries = status.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    paths.add(entry.slice(3));
    if ((entry.startsWith("R") || entry.startsWith("C")) && i + 1 < entries.length) paths.add(entries[++i]!);
  }
  return [...paths].sort();
}

/** What a worktree's changes are measured from: the remote's copy of the branch its PRs target, as last fetched. */
export async function changesBase(root: string, recorded: string): Promise<string> {
  const r = await remote(root);
  if (!r) return recorded;
  const name = recorded.startsWith(`${r}/`) ? recorded.slice(r.length + 1) : recorded;
  const tracking = `${r}/${name}`;
  return (await refSha(root, `refs/remotes/${tracking}`)) ? tracking : recorded;
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
  const r = await remote(root);
  if (!r) {
    const local = (await refSha(root, `refs/heads/${name}`)) ? name : await currentBranch(root);
    if (!local) throw new GitError(`${root} has no branch to start from`);
    const sha = await refSha(root, `refs/heads/${local}`);
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
  const sha = await refSha(root, `refs/remotes/${tracking}`);
  if (!why && sha) {
    if (!(await cachedHead(root, r))) await tryGit(root, ["remote", "set-head", r, name]);
    return { baseRef: tracking, sha, fetchedAt: rfc3339(Date.now()) };
  }
  const error = why ?? { kind: "failed" as const, message: `${tracking} is missing after the fetch` };
  const said = error.kind === "offline" ? "offline" : error.message;
  if (sha) return { baseRef: tracking, sha, error, note: `based on ${tracking} (fetch failed: ${said})` };
  const local = await refSha(root, `refs/heads/${name}`);
  if (local) return { baseRef: name, sha: local, error, note: `based on local ${name} (fetch failed: ${said})` };
  throw new GitError(`can't reach ${r} and have no copy of ${tracking} (fetch failed: ${said})`);
}

/** `sha` as a full commit id when this repo has that commit; undefined for anything but a hex commit id, or one it
 * lacks. */
export const knownCommit = async (root: string, sha: string) => (/^[0-9a-fA-F]{7,64}$/.test(sha) ? refSha(root, sha) : undefined);

/** The URL path segments a PR's number follows: GitHub's, Gitea's, GitLab's and Bitbucket's. */
const PR_SEGMENTS = ["pull", "pulls", "merge_requests", "pull-requests"];

/** A PR's number from its URL on any host: `…/pull/7`, `…/-/merge_requests/7`, `…/pull-requests/7`. */
export function prNumber(url: string): number | undefined {
  const segments = (url.split(/[?#]/)[0] ?? "").split("/");
  for (let i = 0; i + 1 < segments.length; i++)
    if (PR_SEGMENTS.includes(segments[i]!) && /^\d+$/.test(segments[i + 1]!)) return Number(segments[i + 1]);
  return undefined;
}

/** `[user@]host[:port]/path[.git][/]` as `host/path`, lowercased; undefined without both. */
function repoKey(rest: string): string | undefined {
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  const host = (rest.slice(0, slash).split("@").pop() ?? "").split(":")[0] ?? "";
  let path = rest.slice(slash + 1).replace(/^\/+|\/+$/g, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  return host && path ? `${host}/${path}`.toLowerCase() : undefined;
}

/** The repo a PR belongs to, as `host/owner/name` in lowercase. */
export function prRepo(url: string): string | undefined {
  const at = url.indexOf("://");
  if (at < 0) return undefined;
  const segments = (url.slice(at + 3).split(/[?#]/)[0] ?? "").split("/");
  const pr = segments.findIndex((s) => PR_SEGMENTS.includes(s));
  if (pr < 0) return undefined;
  const repo = segments.slice(0, pr);
  if (repo[repo.length - 1] === "-") repo.pop();
  return repoKey(repo.join("/"));
}

/** A remote's repo as `host/owner/name` in lowercase, from any of git's URL forms; undefined for a local path. */
export function remoteRepo(url: string): string | undefined {
  const at = url.indexOf("://");
  if (at >= 0) return repoKey(url.slice(at + 3));
  // scp-like `[user@]host:path`, which has a colon before any slash.
  const colon = url.indexOf(":");
  if (colon < 0 || url.slice(0, colon).includes("/")) return undefined;
  return repoKey(`${url.slice(0, colon)}/${url.slice(colon + 1)}`);
}

/** The remote whose URL is `repo`'s, `origin` first, then `upstream`. */
async function prRemote(root: string, repo: string): Promise<string | undefined> {
  const rank = (r: string) => (r === "origin" ? 0 : r === "upstream" ? 1 : 2);
  const remotes = ((await tryGit(root, ["remote"])) ?? "").split("\n").filter(Boolean).sort((a, b) => rank(a) - rank(b));
  // As configured: `url.<base>.insteadOf` rewrites only where git connects.
  for (const r of remotes) if (remoteRepo((await tryGit(root, ["config", "--get", `remote.${r}.url`]))?.trim() ?? "") === repo) return r;
  return undefined;
}

/** The head commit of the PR at `url`, fetched from the remote the PR belongs to, from whichever of GitHub's, GitLab's
 * or Bitbucket's PR refs it publishes, into the object store alone: no ref, no FETCH_HEAD, nothing of the human's
 * moves. Throws GitError when no remote is the PR's repo. */
export async function prHead(root: string, url: string): Promise<string> {
  const n = prNumber(url);
  if (n === undefined) throw new GitError(`no PR number in ${url}`);
  const repo = prRepo(url);
  if (!repo) throw new GitError(`no repo in ${url}`);
  const r = await prRemote(root, repo);
  if (!r) throw new GitError(`no remote is ${repo}`);
  const listed = await gitRemote(root, ["ls-remote", r, `refs/pull/${n}/head`, `refs/merge-requests/${n}/head`, `refs/pull-requests/${n}/from`], LS_REMOTE_TIMEOUT_MS);
  const line = listed.split("\n").find((l) => l.includes("\t"));
  if (!line) throw new GitError(`${r} publishes no ref for PR ${n}`);
  const [sha, name] = line.split("\t").map((x) => x.trim()) as [string, string];
  if (!(await refSha(root, sha))) await gitRemote(root, ["fetch", "--no-tags", "--no-write-fetch-head", r, name], FETCH_TIMEOUT_MS);
  const head = await refSha(root, sha);
  if (!head) throw new GitError(`${name} fetched without its commit ${sha}`);
  return head;
}

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
  const remotes = ((await tryGit(root, ["remote"])) ?? "").split("\n").filter(Boolean);
  remotes.sort((a, b) => Number(a !== "origin") - Number(b !== "origin"));
  for (const r of remotes) {
    try {
      await gitRemote(root, ["fetch", "--no-tags", r, `+refs/heads/${branch}:refs/remotes/${r}/${branch}`], FETCH_TIMEOUT_MS);
    } catch {}
    if (await refSha(root, `refs/remotes/${r}/${branch}`)) return r;
  }
  return undefined;
}

/** Where a lost worktree of `branch` comes back from: the local branch, else the branch as pushed, else a fresh fetch
 * of the default branch `baseRef` names, as a new task starts. */
export async function source(root: string, branch: string, baseRef: string): Promise<Source> {
  if (await branchExists(root, branch)) return { kind: "local" };
  const r = await pushed(root, branch);
  if (r) return { kind: "remote", remote: r };
  const rem = await remote(root);
  const name = rem && baseRef.startsWith(`${rem}/`) ? baseRef.slice(rem.length + 1) : baseRef;
  const base = await freshBase(root, name);
  return { kind: "base", baseRef: base.baseRef, sha: base.sha };
}

/** Brings back a session's worktree that is gone, at the same path so `claude --resume` still finds its session. */
export async function restore(root: string, path: string, branch: string, from: Source): Promise<void> {
  // A worktree whose directory was deleted stays registered, holding its path and branch: only this one record goes.
  if (!existsSync(path)) await serial(root, () => tryGit(root, ["worktree", "remove", "--force", path]));
  const start = from.kind === "local" ? branch : from.kind === "remote" ? `refs/remotes/${from.remote}/${branch}` : from.sha;
  await ensure(root, path, branch, start);
}
