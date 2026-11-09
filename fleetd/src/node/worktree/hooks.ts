// A writer's git hooks in its own worktree: commits that name its task (crates/fleetd/src/node/landed.rs
// `trailer_hooks`), and the pre-push gate (pre_push.rs): a writer pushes only a tree its repo's pre-push check passed
// on. The scripts are the Rust node's, so a worktree either node set up behaves the same.
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { GitError, git } from "./index.ts";
import type { Env } from "../util.ts";

export const TASK_TRAILER = "Fleetd-Task";
/** In a commit's tree: the repo's pre-push check, `{"check": "<command>"}` (and `"background"`, `"wait"`). */
export const DECLARED = ".fleetd/pre-push.json";
/** In the worktree's git dir: the trees the check passed on, one per line. */
export const CHECKED = "fleetd-checked";
const DIR = "fleetd-push";

/** The task a fleetd branch names: `fleetd/T12-…` → "T12". */
export function branchTask(branch: string): string | undefined {
  const m = /^fleetd\/T([1-9][0-9]*)/.exec(branch);
  return m ? `T${m[1]}` : undefined;
}

/** `text` as one shell word. */
export const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** Git's client-side hooks, each forwarded to the repo's own. HOT_HOOKS only where the repo has them already. */
export const HOOKS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "post-rewrite", "pre-auto-gc", "sendemail-validate",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit",
];
export const HOT_HOOKS = ["reference-transaction", "post-index-change"];

const tryGit = (cwd: string, args: string[]) => git(cwd, args).catch(() => undefined);

/** The repo's own hooks dir, seen from the worktree `cwd`. */
export async function ownHooksDir(cwd: string): Promise<string> {
  for (const scope of ["--local", "--global", "--system"]) {
    const dir = await tryGit(cwd, ["config", "--includes", "--type=path", scope, "core.hooksPath"]);
    if (dir !== undefined) return join(cwd, dir.trim());
  }
  return join((await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(), "hooks");
}

const OWN_HOOK = `#!/bin/sh
# fleetd: the repo's own hook, from its own hooks path.
name=$1; shift
dir=$(git config --includes --type=path --local core.hooksPath ||
  git config --includes --type=path --global core.hooksPath ||
  git config --includes --type=path --system core.hooksPath) || dir="$(git rev-parse --git-common-dir)/hooks"
if [ -x "$dir/$name" ]; then exec "$dir/$name" "$@"; fi
exit 0
`;

function writeHook(path: string, body: string): void {
  writeFileSync(path, body);
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
  const dir = join(gitDir, "fleetd-hooks");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const own = quoted(join(dir, "own-hook"));
  writeHook(join(dir, "own-hook"), OWN_HOOK);
  writeHook(
    join(dir, "prepare-commit-msg"),
    `#!/bin/sh\n# fleetd: each commit names its task, so its work is found from git alone.\ngit interpret-trailers --in-place --if-exists addIfDifferent --trailer ${quoted(`${TASK_TRAILER}: ${task}`)} "$1" || true\nexec ${own} prepare-commit-msg "$@"\n`,
  );
  const theirs = await ownHooksDir(cwd);
  for (const name of [...HOOKS, ...HOT_HOOKS.filter((n) => isFile(join(theirs, n)))]) writeHook(join(dir, name), `#!/bin/sh\nexec ${own} ${name} "$@"\n`);
  await git(cwd, ["config", "--worktree", "core.hooksPath", dir]);
  return true;
}

const BENEATH = `#!/bin/sh
# fleetd: the hook git runs without fleetd's pre-push gate.
name=$1; shift
dir=$(git config --includes --type=path --worktree core.hooksPath 2>/dev/null ||
  git config --includes --type=path --local core.hooksPath ||
  git config --includes --type=path --global core.hooksPath ||
  git config --includes --type=path --system core.hooksPath) || dir="$(git rev-parse --git-common-dir)/hooks"
if [ -x "$dir/$name" ]; then exec "$dir/$name" "$@"; fi
exit 0
`;

const GATE = `#!/bin/sh
# fleetd: a writer pushes only a tree its repo's pre-push check (.fleetd/pre-push.json) passed on.
input=$(cat)
checked=$(git rev-parse --git-path fleetd-checked) || exit 1
# field <key>: the string <key> holds in the declaration.
field() { printf '%s\\n' "$declared" | sed -n "s/.*\\"$1\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p" | head -n 1; }
refused=$(printf '%s\\n' "$input" | {
  long=
  while read -r _ sha ref _; do
    case $sha in *[!0]*) ;; *) continue ;; esac
    case $ref in refs/heads/*) ;; *) continue ;; esac
    declared=$(git cat-file blob "$sha:.fleetd/pre-push.json" 2>/dev/null) || continue
    tree=$(git rev-parse --verify -q "$sha^{tree}") || continue
    grep -qxF "$tree" "$checked" 2>/dev/null && continue
    check=$(field check) background=$(field background) wait_for=$(field wait)
    echo "fleetd: push refused: \${check:-the check in .fleetd/pre-push.json} hasn't passed on \${ref#refs/heads/}'s tree at $(git rev-parse --short "$sha")."
    [ -z "$background" ] || [ -z "$wait_for" ] ||
      long="Too long for one command? Start \\\`$background\\\`, then wait for it with the Monitor tool running \\\`$wait_for\\\`, never a sleep loop."
  done
  echo "Run it in this worktree after your final rebase, commit exactly what it checked, then push again."
  echo "\${long:-Too long for one command? Run it in the background and wait for it with the Monitor tool, never a sleep loop.}"
})
case $refused in "fleetd: push refused: "*)
  printf '%s\\n' "$refused" >&2
  exit 1
esac
[ -z "$input" ] || input="$input
"
printf '%s' "$input" | exec BENEATH pre-push "$@"
`;

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
  const dir = join(gitDir, DIR);
  const hooks = join(dir, "hooks");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(hooks, { recursive: true });
  const beneath = quoted(join(hooks, "beneath"));
  writeHook(join(hooks, "beneath"), BENEATH);
  writeHook(join(hooks, "pre-push"), GATE.replace("exec BENEATH", `exec ${beneath}`));
  // The hot hooks only where they run already: with fleetd's trailer hooks set, they are what the worktree's own config
  // points at.
  const worktreeDir = await tryGit(cwd, ["config", "--includes", "--type=path", "--worktree", "core.hooksPath"]);
  const theirs = worktreeDir !== undefined ? (isAbsolute(worktreeDir.trim()) ? worktreeDir.trim() : join(cwd, worktreeDir.trim())) : await ownHooksDir(cwd);
  for (const name of [...HOOKS, "prepare-commit-msg", ...HOT_HOOKS.filter((n) => isFile(join(theirs, n)))]) {
    if (name === "pre-push") continue;
    writeHook(join(hooks, name), `#!/bin/sh\nexec ${beneath} ${name} "$@"\n`);
  }
  const config = join(dir, "config");
  writeFileSync(config, `[core]\n\thooksPath = "${hooks.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n`);
  // `gitdir:` is a glob: the dir's own name, its glob characters escaped.
  addConfig(env, `includeIf.gitdir:${gitDir.replace(/[*?[\\]/g, (c) => `\\${c}`)}.path`, config);
}

/** Whether `cwd` holds a file the gate reads (tests). */
export const gated = async (cwd: string) => existsSync(join(realpathSync((await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim()), DIR, "hooks", "pre-push"));
