// The scripts of a writer's git hooks (hooks.ts) and where each goes, as text: no file, git or process. The node writes
// them in its worktrees and a hosted box writes the same bytes in its own checkout, so the two can't drift.
import { join } from "node:path";

export const TASK_TRAILER = "Fleetd-Task";
/** In a commit's tree: the repo's pre-push check, `{"check": "<command>"}` (and `"background"`, `"wait"`). */
export const DECLARED = ".fleetd/pre-push.json";
/** In the worktree's git dir: the trees the check passed on, one per line. */
export const CHECKED = "fleetd-checked";
/** In the worktree's git dir: the gate's hooks and config. */
export const GATE_DIR = "fleetd-push";
/** In the worktree's git dir: the trailer hooks. */
export const TRAILER_DIR = "fleetd-hooks";

/** `text` as one shell word. */
export const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** Git's client-side hooks, each forwarded to the repo's own. HOT_HOOKS only where the repo has them already. */
export const HOOKS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "post-rewrite", "pre-auto-gc", "sendemail-validate",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit",
];
export const HOT_HOOKS = ["reference-transaction", "post-index-change"];

/** A file to write: a hook is mode 0755, the gate's config is written as it is. */
export type HookFile = { path: string; text: string };

export const OWN_HOOK = `#!/bin/sh
# fleetd: the repo's own hook, from its own hooks path.
name=$1; shift
dir=$(git config --includes --type=path --local core.hooksPath ||
  git config --includes --type=path --global core.hooksPath ||
  git config --includes --type=path --system core.hooksPath) || dir="$(git rev-parse --git-common-dir)/hooks"
if [ -x "$dir/$name" ]; then exec "$dir/$name" "$@"; fi
exit 0
`;

export const BENEATH = `#!/bin/sh
# fleetd: the hook git runs without fleetd's pre-push gate.
name=$1; shift
dir=$(git config --includes --type=path --worktree core.hooksPath 2>/dev/null ||
  git config --includes --type=path --local core.hooksPath ||
  git config --includes --type=path --global core.hooksPath ||
  git config --includes --type=path --system core.hooksPath) || dir="$(git rev-parse --git-common-dir)/hooks"
if [ -x "$dir/$name" ]; then exec "$dir/$name" "$@"; fi
exit 0
`;

/** The pre-push gate; `exec BENEATH` becomes the path of the gate's `beneath` (gateFiles). */
export const GATE = `#!/bin/sh
# fleetd: a writer pushes only a tree its repo's pre-push check (.fleetd/pre-push.json) passed on.
input=$(cat)
checked=$(git rev-parse --git-path fleetd-checked) || exit 1
# field <key>: the string <key> holds in the declaration.
field() { printf '%s\\n' "$declared" | sed -n "s/.*\\"$1\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p" | head -n 1; }
# On a fleetd machine the check runs as \`fleetd-heavy <check>\`, taking a heavy-run slot (node/heavy_slots.ts), as
# workers' standing rules say too.
heavy=
command -v fleetd-heavy >/dev/null 2>&1 && heavy="fleetd-heavy "
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
      long="Too long for one command? Start \\\`$heavy$background\\\`, then wait for it with the Monitor tool running \\\`$wait_for\\\`, never a sleep loop."
  done
  run=it
  [ -z "$check" ] || run="\\\`$heavy$check\\\`"
  echo "Run $run in this worktree on what you push, commit exactly what it checked, then push again."
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

/** The trailer hooks of the linked worktree whose git dir is `gitDir`: a `prepare-commit-msg` that adds
 * `Fleetd-Task: <task>`, every hook then running the repo's own. `hot`: the HOT_HOOKS the repo's own hooks dir has. The
 * caller points the worktree's own `core.hooksPath` (`git config --worktree`) at `dir`. */
export function trailerFiles(gitDir: string, task: string, hot: string[]): { dir: string; files: HookFile[] } {
  const dir = join(gitDir, TRAILER_DIR);
  const own = quoted(join(dir, "own-hook"));
  const files: HookFile[] = [
    { path: join(dir, "own-hook"), text: OWN_HOOK },
    {
      path: join(dir, "prepare-commit-msg"),
      text: `#!/bin/sh\n# fleetd: each commit names its task, so its work is found from git alone.\ngit interpret-trailers --in-place --if-exists addIfDifferent --trailer ${quoted(`${TASK_TRAILER}: ${task}`)} "$1" || true\nexec ${own} prepare-commit-msg "$@"\n`,
    },
  ];
  for (const name of [...HOOKS, ...HOT_HOOKS.filter((n) => hot.includes(n))]) files.push({ path: join(dir, name), text: `#!/bin/sh\nexec ${own} ${name} "$@"\n` });
  return { dir, files };
}

/** The pre-push gate of the worktree whose (real, absolute) git dir is `gitDir`: its hooks, its config pointing git
 * there, and the `includeIf.gitdir` entry that includes that config, which the caller adds to the session's git config
 * from the environment (`GIT_CONFIG_*`), never to a config file. `hot`: the HOT_HOOKS the worktree's hooks dir has. */
export function gateFiles(gitDir: string, hot: string[]): { files: HookFile[]; config: HookFile; include: [key: string, value: string] } {
  if (gitDir.includes("\n")) throw new Error(`${gitDir} has a line break`);
  const dir = join(gitDir, GATE_DIR);
  const hooks = join(dir, "hooks");
  const beneath = quoted(join(hooks, "beneath"));
  const files: HookFile[] = [
    { path: join(hooks, "beneath"), text: BENEATH },
    { path: join(hooks, "pre-push"), text: GATE.replace("exec BENEATH", `exec ${beneath}`) },
  ];
  for (const name of [...HOOKS, "prepare-commit-msg", ...HOT_HOOKS.filter((n) => hot.includes(n))]) {
    if (name === "pre-push") continue;
    files.push({ path: join(hooks, name), text: `#!/bin/sh\nexec ${beneath} ${name} "$@"\n` });
  }
  const config = { path: join(dir, "config"), text: `[core]\n\thooksPath = "${hooks.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n` };
  // `gitdir:` is a glob: the dir's own name, its glob characters escaped.
  return { files, config, include: [`includeIf.gitdir:${gitDir.replace(/[*?[\\]/g, (c) => `\\${c}`)}.path`, config.path] };
}
