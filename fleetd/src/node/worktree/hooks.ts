// A writer's git hooks in its own worktree: commits that name its task (crates/fleetd/src/node/landed.rs
// `trailer_hooks`), and the pre-push gate (pre_push.rs): a writer pushes only a tree its repo's pre-push check passed
// on. The scripts are the Rust node's, so a worktree either node set up behaves the same.
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { GitError, git } from "./index.ts";
import type { Env } from "../util.ts";
import { GATE_DIR, gateFiles, HOT_HOOKS, trailerFiles, type HookFile } from "./hook_scripts.ts";

export { CHECKED, DECLARED, HOOKS, HOT_HOOKS, quoted, TASK_TRAILER } from "./hook_scripts.ts";

export { branchTask } from "../../shared/text.ts";

const tryGit = (cwd: string, args: string[]) => git(cwd, args).catch(() => undefined);

/** The repo's own hooks dir, seen from the worktree `cwd`. */
export async function ownHooksDir(cwd: string): Promise<string> {
  for (const scope of ["--local", "--global", "--system"]) {
    const dir = await tryGit(cwd, ["config", "--includes", "--type=path", scope, "core.hooksPath"]);
    if (dir !== undefined) return join(cwd, dir.trim());
  }
  return join((await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(), "hooks");
}

function writeHook({ path, text }: HookFile): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** In a linked worktree whose repo has `extensions.worktreeConfig` on, points the worktree's own hooks at a dir whose
 * `prepare-commit-msg` adds `Fleetd-Task: <task>`, every hook then running the repo's own. Whether they are set. */
export async function trailerHooks(cwd: string, task: string): Promise<boolean> {
  const path = async (what: string) => (await git(cwd, ["rev-parse", "--path-format=absolute", what])).trim();
  const gitDir = await path("--git-dir");
  if (gitDir === (await path("--git-common-dir"))) throw new GitError(`${cwd} is not a linked worktree`);
  if ((await tryGit(cwd, ["config", "--local", "--type=bool", "extensions.worktreeConfig"]))?.trim() !== "true") return false;
  const theirs = await ownHooksDir(cwd);
  const { dir, files } = trailerFiles(gitDir, task, HOT_HOOKS.filter((n) => isFile(join(theirs, n))));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeHook(file);
  await git(cwd, ["config", "--worktree", "core.hooksPath", dir]);
  return true;
}

/** Adds `key = value` to the git config `env` gives every git it starts, after the entries it has. */
export function addConfig(env: Env, key: string, value: string): void {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  env.GIT_CONFIG_COUNT = String(n + 1);
  env[`GIT_CONFIG_KEY_${n}`] = key;
  env[`GIT_CONFIG_VALUE_${n}`] = value;
}

/** Sets up the gate for the worktree `cwd` and adds to `env` what points its git there (`includeIf.gitdir`), never a
 * config file: the person's checkout and pushes keep their hooks as they are. */
export async function gate(cwd: string, env: Env): Promise<void> {
  const gitDir = realpathSync((await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim());
  if (gitDir.includes("\n")) throw new GitError(`${gitDir} has a line break`);
  // The hot hooks only where they run already: with fleetd's trailer hooks set, they are what the worktree's own config
  // points at.
  const worktreeDir = await tryGit(cwd, ["config", "--includes", "--type=path", "--worktree", "core.hooksPath"]);
  const theirs = worktreeDir !== undefined ? (isAbsolute(worktreeDir.trim()) ? worktreeDir.trim() : join(cwd, worktreeDir.trim())) : await ownHooksDir(cwd);
  const { files, config, include } = gateFiles(gitDir, HOT_HOOKS.filter((n) => isFile(join(theirs, n))));
  const dir = join(gitDir, GATE_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "hooks"), { recursive: true });
  for (const file of files) writeHook(file);
  writeFileSync(config.path, config.text);
  addConfig(env, ...include);
}

/** Whether `cwd` holds a file the gate reads (tests). */
export const gated = async (cwd: string) => existsSync(join(realpathSync((await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim()), GATE_DIR, "hooks", "pre-push"));
