// Regenerating instead of bouncing. A repo that commits
// `.fleetd/regenerate.json` names its generated files, the commands that make them and its migrations directory. A PR
// that conflicts with its base, or adds a migration that sorts before the base's newest, is then rebased by the train
// onto `origin/<base>` in a scratch worktree of the repo's checkout, on its node, with a timeout: conflicts in generated
// files take the base's side, an early migration gets a fresh UTC stamp, every command runs, and the result is pushed
// to the PR as the train's own commit when it changed nothing else and running the commands twice gives the same files.
// A conflict anywhere else, a command that fails or a tree that comes out different each time goes back to the author.
// It runs in the background: the PR keeps its place in line meanwhile.
import type { Change } from "../../shared/contracts.ts";
import type { Pull } from "./github.ts";
import type { NodeRun } from "./host.ts";
import { errorText, WAIT_REGEN } from "./records.ts";
import { short } from "./rules.ts";
import { TRAIN_BY, type Train } from "./service.ts";

/** Where a repo says how its generated files are made, on its base branch. */
export const CONFIG_PATH = ".fleetd/regenerate.json";
const CONFIG_TTL_MS = 10 * 60_000;
const MAX_MINUTES = 120;
const DEFAULT_MINUTES = 30;
const GIT_TIMEOUT_SEC = 300;
/** The most paths and commands together, so the script's argv stays within a node command's 64 entries. */
const ENTRIES_MAX = 47;
const SAID = "fleetd-regenerate: ";
const REFUSED = 3;

/** `.fleetd/regenerate.json`. */
export type Regenerate = { generated: string[]; run: string[]; migrations?: string; timeoutMinutes?: number };

/** The config in `text`, or why it can't be used (thrown). */
export function parseRegenerate(text: string): Regenerate {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`${CONFIG_PATH}: ${(e as Error).message}`);
  }
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${CONFIG_PATH}: expected an object`);
  for (const k of Object.keys(o)) {
    if (!["generated", "run", "migrations", "timeoutMinutes"].includes(k)) throw new Error(`${CONFIG_PATH}: unknown field \`${k}\``);
  }
  const strings = (k: string) => {
    const x = o[k];
    if (!Array.isArray(x) || !x.every((s) => typeof s === "string")) throw new Error(`${CONFIG_PATH}: \`${k}\` is a list of strings`);
    return x as string[];
  };
  const config: Regenerate = { generated: strings("generated"), run: strings("run") };
  if (o.migrations != null) {
    if (typeof o.migrations !== "string") throw new Error(`${CONFIG_PATH}: \`migrations\` is a path`);
    config.migrations = o.migrations;
  }
  if (o.timeoutMinutes != null) {
    if (typeof o.timeoutMinutes !== "number" || !Number.isInteger(o.timeoutMinutes) || o.timeoutMinutes < 0) {
      throw new Error(`${CONFIG_PATH}: timeoutMinutes is a number of minutes`);
    }
    config.timeoutMinutes = o.timeoutMinutes;
  }
  const pathOk = (p: string) => p !== "" && !p.startsWith("/") && !p.includes("\n") && !p.split("/").some((part) => part === ".." || part === ".");
  const bad = [...config.generated, ...(config.migrations !== undefined ? [config.migrations] : [])].find((p) => !pathOk(p));
  if (bad !== undefined) throw new Error(`${CONFIG_PATH}: \`${bad}\` is not a path inside the repo`);
  if (config.run.some((c) => c.trim() === "" || c.includes("\n"))) throw new Error(`${CONFIG_PATH}: each command is one line`);
  if (config.generated.length + config.run.length > ENTRIES_MAX) throw new Error(`${CONFIG_PATH}: at most ${ENTRIES_MAX} paths and commands together`);
  if (config.timeoutMinutes !== undefined && (config.timeoutMinutes < 1 || config.timeoutMinutes > MAX_MINUTES)) {
    throw new Error(`${CONFIG_PATH}: timeoutMinutes is 1-${MAX_MINUTES}`);
  }
  return config;
}

const timeoutSec = (c: Regenerate) => (c.timeoutMinutes ?? DEFAULT_MINUTES) * 60;

/** The migrations `added` (paths) that sort at or before the newest of `onBase` (file names). */
export function earlyMigrations(c: Regenerate, added: string[], onBase: string[]): string[] {
  if (c.migrations === undefined) return [];
  const dir = `${c.migrations.replace(/\/+$/, "")}/`;
  const stamp = (name: string) => {
    const s = name.split("_")[0] ?? "";
    return /^\d+$/.test(s) ? Number(s) : undefined;
  };
  const stamps = onBase.map(stamp).filter((s): s is number => s !== undefined);
  if (stamps.length === 0) return [];
  const newest = Math.max(...stamps);
  return added
    .filter((p) => p.startsWith(dir))
    .map((p) => p.slice(dir.length))
    .filter((name) => !name.includes("/") && name.endsWith(".sql"))
    .filter((name) => {
      const s = stamp(name);
      return s !== undefined && s <= newest;
    });
}

/** The script a regeneration runs on the node (regen.rs `SCRIPT`, verbatim). */
const SCRIPT = `set -u
repo=$1 base=$2 head=$3 title=$4 migrations=$5 n=$6
shift 6
paths=
i=0
while [ "$i" -lt "$n" ]; do
  paths="$paths$1
"
  shift
  i=$((i + 1))
done
say() { printf 'fleetd-regenerate: %s\\n' "$*"; }
refuse() { say "$*"; exit 3; }
generated() {
  printf '%s' "$paths" | {
    while IFS= read -r p; do
      case "$p" in
        */) case "$1" in "$p"*) exit 0 ;; esac ;;
        *) [ "$1" = "$p" ] && exit 0 ;;
      esac
    done
    exit 1
  }
}
g() {
  git -c user.name="fleetd merge train" -c user.email=train@fleetd.invalid -c commit.gpgsign=false \\
    -c core.hooksPath=/dev/null "$@"
}
run_all() {
  for c in "$@"; do
    sh -c "$c" >"$tmp/run" 2>&1
    case $? in
      0) ;;
      127) refuse "\\\`$c\\\` needs a program that is not on this node's PATH ($PATH), which its agent sessions get too: $(tail -n 1 "$tmp/run")" ;;
      *) refuse "\\\`$c\\\` failed: $(tail -n 3 "$tmp/run" | tr '\\n' ' ')" ;;
    esac
  done
}
onto=refs/remotes/origin/$base
git cat-file -e "$head^{commit}" 2>/dev/null || refuse "the PR's head \${head} is not in the checkout"
git rev-parse -q --verify "$onto" >/dev/null || refuse "origin/$base is not in the checkout"
root=$(pwd)
FLEETD_REGENERATE_CACHE=\${FLEETD_NODE_HOME:-$HOME/.fleetd/node}/cache/regenerate/$(printf '%s' "$repo" | tr '/' '-')
export FLEETD_REGENERATE_CACHE
mkdir -p "$FLEETD_REGENERATE_CACHE" || refuse "no cache directory at $FLEETD_REGENERATE_CACHE"
tmp=$(mktemp -d) || refuse "no scratch directory"
work=$tmp/tree
export CARGO_HOME="\${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="\${RUSTUP_HOME:-$HOME/.rustup}"
export npm_config_cache="$FLEETD_REGENERATE_CACHE/npm"
mkdir -p "$tmp/home" && export HOME="$tmp/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=false SSH_ASKPASS=false
export GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \\
  GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null GIT_CONFIG_KEY_2=rerere.enabled GIT_CONFIG_VALUE_2=false
unset SSH_AUTH_SOCK GIT_SSH_COMMAND GIT_SSH
trap 'cd "$root"; git worktree remove --force "$work" >/dev/null 2>&1; git worktree prune; rm -rf "$tmp"' EXIT
git worktree add -q --detach "$work" "$head" >"$tmp/log" 2>&1 || refuse "no scratch worktree: $(tail -n 1 "$tmp/log")"
cd "$work" || refuse "no scratch worktree"

# Conflicts in generated files take the base's side (stage 2, the side being built on); any other is the author's.
take_base() {
  git diff --name-only --diff-filter=U >"$tmp/conflicted"
  [ -s "$tmp/conflicted" ] || refuse "$1: $(tail -n 1 "$tmp/log")"
  while IFS= read -r f; do
    generated "$f" || refuse "it conflicts with $base in $f, which is not a generated file"
    if git cat-file -e ":2:$f" 2>/dev/null; then
      git checkout -q --ours -- "$f" && git add -- "$f"
    else
      git rm -q -- "$f"
    fi || refuse "the conflict in $f could not be taken from $base"
  done <"$tmp/conflicted"
}
# A branch that merged others goes on as one commit: an old merged-in commit may no longer replay on its own though the
# branch as a whole merges, and its changes are what the train squashes onto the base anyway.
if [ -n "$(git rev-list --merges -n 1 "$onto..HEAD")" ]; then
  git checkout -q --detach "$onto" >"$tmp/log" 2>&1 || refuse "origin/$base could not be checked out: $(tail -n 1 "$tmp/log")"
  g merge -q --squash "$head" >"$tmp/log" 2>&1 || take_base "the merge with origin/$base stopped"
  if ! git diff --cached --quiet; then
    { printf '%s\\n\\n' "$title"; git log --reverse --no-merges --format='* %B' "$onto..$head"; } >"$tmp/message"
    g commit -q -F "$tmp/message" || refuse "the PR's changes could not be committed on $base"
  fi
elif ! g rebase -q "$onto" >"$tmp/log" 2>&1; then
  steps=0
  while :; do
    steps=$((steps + 1))
    [ "$steps" -le 1000 ] || refuse "the rebase onto origin/$base did not finish"
    take_base "the rebase onto origin/$base stopped"
    if git diff --cached --quiet; then
      g rebase --skip >"$tmp/log" 2>&1 && break
    else
      GIT_EDITOR=true g rebase --continue >"$tmp/log" 2>&1 && break
    fi
  done
fi

if [ -n "$migrations" ]; then
  dir=\${migrations%/}
  last=$(git ls-tree --name-only "$onto" -- "$dir/" | sed 's|.*/||' | cut -d_ -f1 | grep -E '^[0-9]+$' | sort -n | tail -n 1)
  added=$(git diff --name-only --no-renames --diff-filter=A "$onto" HEAD -- "$dir/" | grep -E '/[0-9]+_[^/]*\\.sql$' | sort)
  early=
  for f in $added; do
    s=\${f##*/}
    [ -n "$last" ] && [ "\${s%%_*}" -le "$last" ] && early=1
  done
  if [ -n "$early" ]; then
    stamp=$(date -u +%Y%m%d%H%M)
    [ "$stamp" -gt "$last" ] || stamp=$((last + 1))
    for f in $added; do
      name=\${f##*/}
      git mv -- "$f" "$dir/\${stamp}_\${name#*_}" || refuse "$name could not be renamed"
      say "renamed $name to \${stamp}_\${name#*_}"
      stamp=$((stamp + 1))
    done
    g commit -q -m "Rename the migrations to sort after $base's (fleetd merge train)" || refuse "the rename could not be committed"
  fi
fi

run_all "$@"
{ git diff --name-only --no-renames HEAD; git ls-files --others --exclude-standard; } >"$tmp/changed"
while IFS= read -r f; do
  generated "$f" || refuse "regenerating changed $f, which is not a generated file"
done <"$tmp/changed"
git add -A || refuse "the regenerated files could not be staged"
if ! git diff --cached --quiet; then
  g commit -q -m "Regenerate the generated files on $base (fleetd merge train)" || refuse "the regenerated files could not be committed"
fi
run_all "$@"
again=$(git status --porcelain --untracked-files=all | head -n 3 | tr '\\n' ' ')
[ -z "$again" ] || refuse "running the commands again changed \${again}so they are not deterministic"
say "done $(git rev-parse HEAD)"
`;

/** The command the node runs for a regeneration: the script under `sh`, with the head to rebase and the config. */
export function scriptArgv(repo: string, base: string, head: string, title: string, config: Regenerate): string[] {
  return ["sh", "-c", SCRIPT, "fleetd-regenerate", repo, base, head, title, config.migrations ?? "", String(config.generated.length), ...config.generated, ...config.run];
}

/**
 * Where a regeneration of a Change at one head stands, kept in `train_waits` so a restart doesn't try a failed one
 * again. One running when the hub stopped is tried again: the hub runs each of its steps, so none goes on without it.
 */
export type Regen = "running" | "pushed" | "failed";
export const REGEN_RUNNING: Regen = "running";
const REGENS: Regen[] = ["running", "pushed", "failed"];

export const regenKey = (c: Change) => `${c.repo}\u0000${c.changeId}\u0000${c.headSha}`;

/** What the train does with a Change that conflicts with its base. */
export type Conflict = "regenerating" | "bounced";

/** The note a Change carries while the train regenerates it. */
export const REGENERATING = "the train is rebasing it and regenerating its generated files";

/** What a node command's output says: its last `fleetd-regenerate:` line, else its last line. */
function said(run: NodeRun): string {
  const lines = run.outputTail.split("\n").map((l) => l.trim());
  const ours = [...lines].reverse().find((l) => l.startsWith(SAID));
  const text = ours !== undefined ? ours.slice(SAID.length) : ([...lines].reverse().find((l) => l !== "") ?? "no output");
  return [...text].slice(0, 500).join("");
}

/** The base's `.fleetd/regenerate.json`, cached for `CONFIG_TTL_MS`: undefined without one, or unusable. */
export async function regenerateConfig(t: Train, repo: string, base: string): Promise<Regenerate | undefined> {
  const key = `${repo}\u0000${base}`;
  const now = t.nowMs();
  const cached = t.regenConfigs.get(key);
  if (cached && now - cached[0] < CONFIG_TTL_MS) return cached[1];
  let config: Regenerate | undefined;
  try {
    const text = await t.github.file(repo, CONFIG_PATH, base);
    if (text !== undefined) {
      try {
        config = parseRegenerate(text);
      } catch (why) {
        t.warnHourly([`train: the regenerate config of ${repo} ${base} is not used`], (why as Error).message, `train: the regenerate config of ${repo} ${base} is not used: ${(why as Error).message}`);
      }
    }
  } catch (error) {
    t.warnHourly([`train: the regenerate config of ${repo} ${base} not read`], (error as Error).message, `train: the regenerate config of ${repo} ${base} not read: ${(error as Error).message}`);
    return undefined;
  }
  t.regenConfigs.set(key, [now, config]);
  return config;
}

/** Where the regeneration of the Change at its current head stands, if one began. */
export function regen(t: Train, c: Change): Regen | undefined {
  const w = t.records.wait(c.changeId, WAIT_REGEN);
  return w && w.head === c.headSha ? REGENS.find((r) => r === w.state) : undefined;
}

const setRegen = (t: Train, c: Change, r: Regen) => t.records.setWait(c.changeId, WAIT_REGEN, c.headSha, r);

/** Drops what the train remembers of regenerations of `repo`'s Changes no longer in `live`. */
export function forgetRegens(t: Train, repo: string, live: string[]): void {
  const gone = (k: string) => {
    const [r, id] = k.split("\u0000") as [string, string];
    return r === repo && !live.includes(id);
  };
  t.records.keepWaits(repo, [WAIT_REGEN], live);
  for (const k of [...t.migrationsRead]) if (gone(k)) t.migrationsRead.delete(k);
}

/** The Change conflicts with its base (`why` completes "it ..."): regenerated when its repo says how, else bounced. */
export async function conflicted(t: Train, change: Change, pull: Pull, why: string): Promise<Conflict> {
  const r = regen(t, change);
  if (r === "running" || r === "pushed") return "regenerating";
  if (r === undefined && (await startRegen(t, change, pull, why, true))) return "regenerating";
  await t.needsRebase(change, why);
  return "bounced";
}

/** Before a ready Change is taken: one whose PR adds a migration that sorts too early is regenerated first. */
export async function earlyMigration(t: Train, change: Change, pull: Pull): Promise<boolean> {
  const r = regen(t, change);
  if (r === "running" || r === "pushed") return true;
  if (r === "failed") return false;
  const key = regenKey(change);
  if (t.migrationsRead.has(key)) return false;
  const repo = change.repo;
  const base = pull.base.ref;
  const config = await regenerateConfig(t, repo, base);
  if (config?.migrations === undefined) return false;
  const dir = config.migrations;
  let added: string[];
  try {
    added = await t.github.addedFiles(repo, change.prNumber);
  } catch (error) {
    t.warnHourly([`train: the PR's files not read for ${change.changeId}`], (error as Error).message, `train: the PR's files not read for ${change.changeId}: ${(error as Error).message}`);
    return false;
  }
  const prefix = `${dir.replace(/\/+$/, "")}/`;
  let early: string[] = [];
  if (added.some((p) => p.startsWith(prefix))) {
    try {
      early = earlyMigrations(config, added, await t.github.fileNames(repo, dir, base));
    } catch (error) {
      t.warnHourly([`train: the base's migrations not read for ${change.changeId}`], (error as Error).message, `train: the base's migrations not read for ${change.changeId}: ${(error as Error).message}`);
      return false;
    }
  }
  t.migrationsRead.add(key);
  if (early.length === 0) return false;
  return startRegen(t, change, pull, `adds ${early.join(", ")} that sorts before ${base}'s newest migration`, false);
}

/** Starts the regeneration of the Change at its head in the background; false when its repo has no usable config. */
async function startRegen(t: Train, change: Change, pull: Pull, why: string, bounce: boolean): Promise<boolean> {
  const repo = change.repo;
  const sameRepo = pull.head.repo?.full_name.toLowerCase() === repo.toLowerCase();
  if (!sameRepo || pull.head.sha.toLowerCase() !== change.headSha) return false;
  const config = await regenerateConfig(t, repo, pull.base.ref);
  if (!config) return false;
  if (!t.records.startWait(change, WAIT_REGEN, change.headSha, t.nowMs(), REGEN_RUNNING)) return true;
  console.info(`train: regenerating ${change.changeId} instead of sending it back: ${why}`);
  t.update(change.changeId, undefined, (c) => ({ ...c, lastError: errorText(`it ${why}; ${REGENERATING}`) }));
  const checkout = t.trainCheckout(change.repo, change.projectRef);
  const turn = `${checkout.machineId}/${checkout.projectId}`;
  const task = t.regenTurns.of(turn).run(async () => {
    // One at a time in a checkout: two would race for its refs and its worktrees.
    const still = t.records.get(change.changeId)?.headSha === change.headSha;
    let outcome: { ok: true; sha: string } | { ok: false; why: string };
    if (!still) outcome = { ok: false, why: "the PR moved while it waited its turn" };
    else {
      try {
        outcome = { ok: true, sha: await regenerate(t, change, pull, config) };
      } catch (error) {
        outcome = { ok: false, why: (error as Error).message };
      }
    }
    await regenerated(t, change, pull, why, bounce, outcome);
  });
  t.regenTasks.add(task);
  void task.finally(() => t.regenTasks.delete(task));
  return true;
}

/** Fetch, the script, push, each on the checkout's node: the pushed head, or why not (thrown). */
async function regenerate(t: Train, change: Change, pull: Pull, config: Regenerate): Promise<string> {
  const checkout = t.trainCheckout(change.repo, change.projectRef);
  const root = t.host.projectRoot(checkout);
  if (root === undefined) throw new Error("the repo's checkout is gone");
  const base = pull.base.ref;
  const branch = pull.head.ref;
  const head = change.headSha;
  const fetch = ["git", "fetch", "-q", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/heads/${branch}:refs/remotes/origin/${branch}`];
  let run = await t.host.nodeRun(checkout, root, fetch, GIT_TIMEOUT_SEC);
  if (run.exitCode !== 0) throw new Error(`fetching from origin failed: ${said(run)}`);
  run = await t.host.nodeRun(checkout, root, scriptArgv(change.repo, base, head, pull.title, config), timeoutSec(config));
  const outcome = said(run);
  let sha: string;
  if (run.exitCode === 0) {
    const s = outcome.startsWith("done ") ? outcome.slice(5).trim() : "";
    if (!(s.length >= 40 && /^[0-9a-fA-F]+$/.test(s))) throw new Error(`it ended without a commit: ${outcome}`);
    sha = s.toLowerCase();
  } else if (run.exitCode === REFUSED) throw new Error(outcome);
  else if (run.exitCode !== undefined) throw new Error(`it failed (exit ${run.exitCode}): ${outcome}`);
  else throw new Error(`it did not finish within ${timeoutSec(config) / 60} min: ${outcome}`);
  if (sha === head) throw new Error(`it is already on origin/${base} with its generated files current, so there is nothing to regenerate`);
  const push = ["git", "push", "-q", `--force-with-lease=refs/heads/${branch}:${head}`, "origin", `${sha}:refs/heads/${branch}`];
  run = await t.host.nodeRun(checkout, root, push, GIT_TIMEOUT_SEC);
  if (run.exitCode !== 0) throw new Error(`pushing to the PR failed: ${said(run)}`);
  return sha;
}

/** After a regeneration: pushed, the PR's new head goes through as any push does; else the Change may go back. */
async function regenerated(
  t: Train,
  change: Change,
  pull: Pull,
  why: string,
  bounce: boolean,
  outcome: { ok: true; sha: string } | { ok: false; why: string },
): Promise<void> {
  const ours = (c: Change) => c.headSha === change.headSha && ["queued", "reviewing", "ready", "rebasing"].includes(c.state);
  if (outcome.ok) {
    setRegen(t, change, "pushed");
    console.info(`train: ${change.changeId} regenerated and pushed ${outcome.sha}`);
    const note =
      `it ${why}; the train rebased it onto ${pull.base.ref}, regenerated its generated files and pushed ${short(outcome.sha)}, which goes ` +
      "through review and CI as any push does";
    t.update(change.changeId, undefined, (c) => (ours(c) ? { ...c, lastError: errorText(note) } : c));
    await tellPushed(t, change, pull, outcome.sha);
  } else {
    setRegen(t, change, "failed");
    console.info(`train: could not regenerate ${change.changeId}: ${outcome.why}`);
    const current = t.records.get(change.changeId);
    let moved = false;
    try {
      moved = (await t.github.pull(change.repo, change.prNumber)).head.sha.toLowerCase() !== change.headSha;
    } catch {}
    if (current && ours(current)) {
      if (bounce && !moved) await t.needsRebase(current, `${why}, and the train could not regenerate its generated files: ${outcome.why}`);
      else
        t.update(current.changeId, undefined, (c) => {
          const { lastError: _, ...rest } = c;
          return rest;
        });
    }
  }
  t.kick(change.repo);
}

/** The author task hears that the train pushed to its PR's branch, so its next push builds on that commit. */
async function tellPushed(t: Train, change: Change, pull: Pull, sha: string): Promise<void> {
  if (change.taskId === undefined) return;
  const base = pull.base.ref;
  const branch = pull.head.ref;
  const old = change.headSha;
  const text =
    `The merge train pushed ${short(sha)} to your PR ${change.prUrl} (branch ${branch}): it rebased the PR onto origin/${base} and ` +
    "regenerated its generated files, so you don't need to. If you push to this PR again, first run " +
    `\`git fetch origin\` and put only your commits since ${old} on top of origin/${branch} (\`git rebase --onto ` +
    `origin/${branch} ${old}\`): a branch with merge commits now has their changes as one commit. Never ` +
    "force-push over the train's commit.";
  try {
    await t.host.messageTask(change.projectRef, TRAIN_BY, change.taskId, text);
  } catch (error) {
    t.warnHourly([`train: author ${change.taskId} not told of the push to ${change.changeId}`], (error as Error).message, `train: author ${change.taskId} not told of the push to ${change.changeId}: ${(error as Error).message}`);
  }
}
