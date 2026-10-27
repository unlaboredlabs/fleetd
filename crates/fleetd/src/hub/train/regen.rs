//! Regenerating instead of bouncing. A repo that commits `.fleetd/regenerate.json` names its generated files, the
//! commands that make them (the ones its CI checks them with) and its migrations directory. A PR that conflicts with
//! its base, or adds a migration that sorts before the base's newest, is then rebased by the train onto `origin/<base>`
//! in a scratch worktree of the repo's checkout, on its node (one whose role takes agents, never the hub's own machine
//! for that), with a timeout: conflicts in generated files take the base's side, an early migration gets a fresh UTC
//! stamp, every command runs, and the result is pushed to the PR as the train's own commit when it changed nothing
//! else and running the commands twice gives the same files. The new head goes through review and CI like any push.
//! A conflict anywhere else, a command that fails or a tree that comes out different each time goes back to the author
//! with why. The file is read from the base branch, never from the PR. It runs in the background: the PR keeps its
//! place in line meanwhile, and the train goes on with the others.
use serde::Deserialize;

use super::contract::{Change, ChangeId, ChangeState};
use super::github::Pull;
use super::host::NodeRun;
use super::service::{Train, error_text, lock, repo_lock, short};

/// Where a repo says how its generated files are made, on its base branch.
pub const CONFIG_PATH: &str = ".fleetd/regenerate.json";
/// How long the config read from a base is trusted before it is read again.
const CONFIG_TTL_MS: i64 = 10 * 60_000;
/// The longest a regeneration may run, and how long one runs when the config says nothing.
const MAX_MINUTES: u32 = 120;
const DEFAULT_MINUTES: u32 = 30;
/// A fetch or a push of the PR's branch.
const GIT_TIMEOUT_SEC: u32 = 300;
/// The most paths and commands together, so the script's argv stays within a node command's 64 entries.
const ENTRIES_MAX: usize = 47;
/// How the script's lines start; its last one is its outcome.
const SAID: &str = "fleetd-regenerate: ";
/// The script's exit code when it refuses with a reason.
const REFUSED: i64 = 3;

/// A base's config as read at a time: None when it has none.
pub(super) type Cached = (i64, Option<Regenerate>);

/// `.fleetd/regenerate.json`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Regenerate {
    /// The generated files: a directory ends in `/`, anything else is one file. Paths from the repo root.
    pub generated: Vec<String>,
    /// Shell lines run in order from the repo root, the same ones CI checks the generated files with.
    pub run: Vec<String>,
    /// The hub's migrations directory, whose files are named `<UTC stamp>_<name>.sql` and must sort after the base's.
    #[serde(default)]
    pub migrations: Option<String>,
    #[serde(default)]
    pub timeout_minutes: Option<u32>,
}

impl Regenerate {
    /// The config in `text`, or why it can't be used.
    pub fn parse(text: &str) -> Result<Regenerate, String> {
        let config: Regenerate =
            serde_json::from_str(text).map_err(|e| format!("{CONFIG_PATH}: {e}"))?;
        let path_ok = |p: &str| {
            !p.is_empty()
                && !p.starts_with('/')
                && !p.contains('\n')
                && !p.split('/').any(|part| part == ".." || part == ".")
        };
        if let Some(bad) = config
            .generated
            .iter()
            .chain(config.migrations.iter())
            .find(|p| !path_ok(p))
        {
            return Err(format!(
                "{CONFIG_PATH}: `{bad}` is not a path inside the repo"
            ));
        }
        if config
            .run
            .iter()
            .any(|c| c.trim().is_empty() || c.contains('\n'))
        {
            return Err(format!("{CONFIG_PATH}: each command is one line"));
        }
        if config.generated.len() + config.run.len() > ENTRIES_MAX {
            return Err(format!(
                "{CONFIG_PATH}: at most {ENTRIES_MAX} paths and commands together"
            ));
        }
        if config
            .timeout_minutes
            .is_some_and(|m| !(1..=MAX_MINUTES).contains(&m))
        {
            return Err(format!("{CONFIG_PATH}: timeoutMinutes is 1-{MAX_MINUTES}"));
        }
        Ok(config)
    }

    fn timeout_sec(&self) -> u32 {
        self.timeout_minutes.unwrap_or(DEFAULT_MINUTES) * 60
    }

    /// Whether `path` is one of the generated files.
    pub fn generated(&self, path: &str) -> bool {
        self.generated.iter().any(|g| match g.strip_suffix('/') {
            Some(dir) => path.starts_with(&format!("{dir}/")),
            None => path == g,
        })
    }

    /// The migrations `added` (paths) that sort at or before the newest of `on_base` (file names): their stamps.
    pub fn early_migrations<'a>(&self, added: &'a [String], on_base: &[String]) -> Vec<&'a str> {
        let Some(dir) = self.migrations.as_deref() else {
            return Vec::new();
        };
        let dir = format!("{}/", dir.trim_end_matches('/'));
        let stamp = |name: &str| name.split('_').next()?.parse::<u64>().ok();
        let Some(newest) = on_base.iter().filter_map(|n| stamp(n)).max() else {
            return Vec::new();
        };
        added
            .iter()
            .filter_map(|p| p.strip_prefix(&dir))
            .filter(|name| !name.contains('/') && name.ends_with(".sql"))
            .filter(|name| stamp(name).is_some_and(|s| s <= newest))
            .collect()
    }
}

/// Rebases the PR's head onto `origin/<base>` in a scratch worktree of the checkout it runs in, resolves conflicts in
/// generated files to the base's side, renames migrations that sort too early, runs every command, and commits what
/// changed: its last line is `done <sha>`, or exit 3 with why. `$@`: base, head, migrations dir (or empty), the number
/// of generated paths, those paths, then the commands; the repo (`owner/name`) before them all. PR code runs here, so
/// the script reaches for no credential on purpose: it runs as a node command, which gets no SSH agent; its HOME is a
/// scratch directory with no git config (cargo and rustup keep theirs), and every git under it has no credential
/// helper, no terminal prompt and no hooks. The fetch before it and the push after it are git commands of their own.
/// The PR's build still runs as the node's user, as an agent's does there, so this keeps credentials from being used
/// by accident, not from code that reads the user's files. Its build caches live under the node's home, never in the
/// checkout. Programs are found on the node's PATH, the one its agent sessions get too.
const SCRIPT: &str = r#"set -u
repo=$1 base=$2 head=$3 migrations=$4 n=$5
shift 5
paths=
i=0
while [ "$i" -lt "$n" ]; do
  paths="$paths$1
"
  shift
  i=$((i + 1))
done
say() { printf 'fleetd-regenerate: %s\n' "$*"; }
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
  git -c user.name="fleetd merge train" -c user.email=train@fleetd.invalid -c commit.gpgsign=false \
    -c core.hooksPath=/dev/null "$@"
}
run_all() {
  for c in "$@"; do
    sh -c "$c" >"$tmp/run" 2>&1
    case $? in
      0) ;;
      127) refuse "\`$c\` needs a program that is not on this node's PATH ($PATH), which its agent sessions get too: $(tail -n 1 "$tmp/run")" ;;
      *) refuse "\`$c\` failed: $(tail -n 3 "$tmp/run" | tr '\n' ' ')" ;;
    esac
  done
}
onto=refs/remotes/origin/$base
git cat-file -e "$head^{commit}" 2>/dev/null || refuse "the PR's head ${head} is not in the checkout"
git rev-parse -q --verify "$onto" >/dev/null || refuse "origin/$base is not in the checkout"
root=$(pwd)
FLEETD_REGENERATE_CACHE=${FLEETD_NODE_HOME:-$HOME/.fleetd/node}/cache/regenerate/$(printf '%s' "$repo" | tr '/' '-')
export FLEETD_REGENERATE_CACHE
mkdir -p "$FLEETD_REGENERATE_CACHE" || refuse "no cache directory at $FLEETD_REGENERATE_CACHE"
tmp=$(mktemp -d) || refuse "no scratch directory"
work=$tmp/tree
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export npm_config_cache="$FLEETD_REGENERATE_CACHE/npm"
mkdir -p "$tmp/home" && export HOME="$tmp/home"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=false SSH_ASKPASS=false
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
  GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null
unset SSH_AUTH_SOCK GIT_SSH_COMMAND GIT_SSH
trap 'cd "$root"; git worktree remove --force "$work" >/dev/null 2>&1; git worktree prune; rm -rf "$tmp"' EXIT
git worktree add -q --detach "$work" "$head" >"$tmp/log" 2>&1 || refuse "no scratch worktree: $(tail -n 1 "$tmp/log")"
cd "$work" || refuse "no scratch worktree"

if ! g rebase -q "$onto" >"$tmp/log" 2>&1; then
  steps=0
  while :; do
    steps=$((steps + 1))
    [ "$steps" -le 1000 ] || refuse "the rebase onto origin/$base did not finish"
    git diff --name-only --diff-filter=U >"$tmp/conflicted"
    [ -s "$tmp/conflicted" ] || refuse "the rebase onto origin/$base stopped: $(tail -n 1 "$tmp/log")"
    while IFS= read -r f; do
      generated "$f" || refuse "it conflicts with $base in $f, which is not a generated file"
      if git cat-file -e ":2:$f" 2>/dev/null; then
        git checkout -q --ours -- "$f" && git add -- "$f"
      else
        git rm -q -- "$f"
      fi || refuse "the conflict in $f could not be taken from $base"
    done <"$tmp/conflicted"
    if git diff --cached --quiet; then
      g rebase --skip >"$tmp/log" 2>&1 && break
    else
      GIT_EDITOR=true g rebase --continue >"$tmp/log" 2>&1 && break
    fi
  done
fi

if [ -n "$migrations" ]; then
  dir=${migrations%/}
  last=$(git ls-tree --name-only "$onto" -- "$dir/" | sed 's|.*/||' | cut -d_ -f1 | grep -E '^[0-9]+$' | sort -n | tail -n 1)
  added=$(git diff --name-only --no-renames --diff-filter=A "$onto" HEAD -- "$dir/" | grep -E '/[0-9]+_[^/]*\.sql$' | sort)
  early=
  for f in $added; do
    s=${f##*/}
    [ -n "$last" ] && [ "${s%%_*}" -le "$last" ] && early=1
  done
  if [ -n "$early" ]; then
    stamp=$(date -u +%Y%m%d%H%M)
    [ "$stamp" -gt "$last" ] || stamp=$((last + 1))
    for f in $added; do
      name=${f##*/}
      git mv -- "$f" "$dir/${stamp}_${name#*_}" || refuse "$name could not be renamed"
      say "renamed $name to ${stamp}_${name#*_}"
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
again=$(git status --porcelain --untracked-files=all | head -n 3 | tr '\n' ' ')
[ -z "$again" ] || refuse "running the commands again changed ${again}so they are not deterministic"
say "done $(git rev-parse HEAD)"
"#;

/// Where a regeneration of a Change at one head stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Regen {
    Running,
    /// Pushed: the PR's new head comes through as any push does.
    Pushed,
    /// It couldn't: the Change went back to its author, or (for a migration alone) went on as it was.
    Failed,
}

/// A Change at one head, in its repo: one train serves every repo.
pub(super) type RegenKey = (String, ChangeId, String);

fn regen_key(change: &Change) -> RegenKey {
    (
        change.repo.to_string(),
        change.change_id.clone(),
        change.head_sha.to_string(),
    )
}

/// What the train does with a Change that conflicts with its base.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Conflict {
    /// The train regenerates it: it keeps its place in line meanwhile.
    Regenerating,
    /// Sent back to its author.
    Bounced,
}

/// The note a Change carries while the train regenerates it.
pub(super) const REGENERATING: &str =
    "the train is rebasing it and regenerating its generated files";

/// What a node command's output says: its last `fleetd-regenerate:` line, else its last line.
fn said(run: &NodeRun) -> String {
    let lines: Vec<&str> = run.output_tail.lines().map(str::trim).collect();
    lines
        .iter()
        .rev()
        .find_map(|l| l.strip_prefix(SAID))
        .or_else(|| lines.iter().rev().find(|l| !l.is_empty()).copied())
        .unwrap_or("no output")
        .chars()
        .take(500)
        .collect()
}

impl Train {
    /// The base's `.fleetd/regenerate.json`, cached for `CONFIG_TTL_MS`: None without one, or when it can't be read or
    /// used (logged).
    pub(super) async fn regenerate_config(&self, repo: &str, base: &str) -> Option<Regenerate> {
        let key = (repo.to_string(), base.to_string());
        let now = self.now_ms();
        if let Some((at, config)) = lock(&self.regen_configs).get(&key)
            && now - at < CONFIG_TTL_MS
        {
            return config.clone();
        }
        let config = match self.github.file(repo, CONFIG_PATH, base).await {
            Ok(None) => None,
            Ok(Some(text)) => match Regenerate::parse(&text) {
                Ok(config) => Some(config),
                Err(why) => {
                    tracing::warn!(repo, base, why, "train: the regenerate config is not used");
                    None
                }
            },
            Err(e) => {
                tracing::warn!(repo, base, error = %e.message, "train: the regenerate config not read");
                return None;
            }
        };
        lock(&self.regen_configs).insert(key, (now, config.clone()));
        config
    }

    /// Where the regeneration of the Change at its current head stands, if one began.
    pub(super) fn regen(&self, change: &Change) -> Option<Regen> {
        lock(&self.regens).get(&regen_key(change)).copied()
    }

    /// Drops what the train remembers of regenerations of `repo`'s Changes no longer in `live`; other repos' stay.
    pub(super) fn forget_regens(&self, repo: &str, live: &[ChangeId]) {
        let gone = |r: &str, id: &ChangeId| r == repo && !live.contains(id);
        lock(&self.regens).retain(|(r, id, _), _| !gone(r, id));
        lock(&self.migrations_read).retain(|(r, id, _)| !gone(r, id));
    }

    /// The Change conflicts with its base (`why` completes "it ..."): regenerated in the background when its repo
    /// says how and its PR's branch is in the repo, else back to its author as before. A regeneration already under
    /// way, or pushed and not yet seen, keeps it waiting.
    pub(super) async fn conflicted(&self, change: &Change, pull: &Pull, why: &str) -> Conflict {
        match self.regen(change) {
            Some(Regen::Running | Regen::Pushed) => return Conflict::Regenerating,
            Some(Regen::Failed) => {}
            None if self.start_regen(change, pull, why, true).await => {
                return Conflict::Regenerating;
            }
            None => {}
        }
        self.needs_rebase(change, why).await;
        Conflict::Bounced
    }

    /// Before a ready Change is taken: one whose PR adds a migration that sorts at or before the base's newest is
    /// regenerated first, which renames it; true while that runs. Read once per head.
    pub(super) async fn early_migration(&self, change: &Change, pull: &Pull) -> bool {
        match self.regen(change) {
            Some(Regen::Running | Regen::Pushed) => return true,
            Some(Regen::Failed) => return false,
            None => {}
        }
        let key = regen_key(change);
        if lock(&self.migrations_read).contains(&key) {
            return false;
        }
        let (repo, base) = (change.repo.as_str(), pull.base.ref_.as_str());
        let Some(config) = self.regenerate_config(repo, base).await else {
            return false;
        };
        let Some(dir) = config.migrations.as_deref() else {
            return false;
        };
        let added = match self.github.added_files(repo, change.pr_number.get()).await {
            Ok(added) => added,
            Err(e) => {
                tracing::warn!(change_id = %change.change_id, error = %e.message, "train: the PR's files not read");
                return false;
            }
        };
        let dir_prefix = format!("{}/", dir.trim_end_matches('/'));
        let early: Vec<String> = if added.iter().any(|p| p.starts_with(&dir_prefix)) {
            match self.github.file_names(repo, dir, base).await {
                Ok(on_base) => config
                    .early_migrations(&added, &on_base)
                    .into_iter()
                    .map(String::from)
                    .collect(),
                Err(e) => {
                    tracing::warn!(change_id = %change.change_id, error = %e.message, "train: the base's migrations not read");
                    return false;
                }
            }
        } else {
            Vec::new()
        };
        lock(&self.migrations_read).insert(key);
        if early.is_empty() {
            return false;
        }
        let why = format!(
            "adds {} that sorts before {base}'s newest migration",
            early.join(", ")
        );
        self.start_regen(change, pull, &why, false).await
    }

    /// Starts the regeneration of the Change at its head in the background: false when its repo has no usable config
    /// or its PR's branch is in another repo. `bounce`: a failure sends it back to its author with `why` and the
    /// reason; else it goes on as it was.
    async fn start_regen(&self, change: &Change, pull: &Pull, why: &str, bounce: bool) -> bool {
        let repo = change.repo.as_str();
        let same_repo = pull
            .head
            .repo
            .as_ref()
            .is_some_and(|r| r.full_name.eq_ignore_ascii_case(repo));
        if !same_repo || pull.head.sha.to_lowercase() != change.head_sha.as_str() {
            return false;
        }
        let Some(config) = self.regenerate_config(repo, &pull.base.ref_).await else {
            return false;
        };
        let Some(me) = self.me.upgrade() else {
            return false;
        };
        let key = regen_key(change);
        {
            let mut regens = lock(&self.regens);
            if regens.contains_key(&key) {
                return true;
            }
            regens.insert(key.clone(), Regen::Running);
        }
        tracing::info!(change_id = %change.change_id, why, "train: regenerating instead of sending it back");
        self.update(&change.change_id, None, |mut c| {
            c.last_error = Some(error_text(&format!("it {why}; {REGENERATING}")));
            c
        });
        let (change, pull, why) = (change.clone(), pull.clone(), why.to_string());
        let checkout = self.train_checkout(&change.repo, &change.project_ref);
        let turn = format!("{}/{}", checkout.machine_id, checkout.project_id);
        let task = tokio::spawn(async move {
            // One at a time in a checkout: two would race for its refs and its worktrees.
            let turns = repo_lock(&me.regen_turns, &turn);
            let _turn = turns.lock().await;
            let still = me
                .records
                .get(&change.change_id)
                .is_some_and(|c| c.head_sha == change.head_sha);
            let outcome = if still {
                me.regenerate(&change, &pull, &config).await
            } else {
                Err("the PR moved while it waited its turn".to_string())
            };
            me.regenerated(&change, &pull, &why, bounce, outcome).await;
        });
        let mut tasks = lock(&self.regen_tasks);
        tasks.retain(|t| !t.is_finished());
        tasks.push(task);
        true
    }

    /// Fetch, the script, push, each on the checkout's node: the pushed head, or why not.
    async fn regenerate(
        &self,
        change: &Change,
        pull: &Pull,
        config: &Regenerate,
    ) -> Result<String, String> {
        let checkout = self.train_checkout(&change.repo, &change.project_ref);
        let root = self
            .host
            .project_root(&checkout)
            .ok_or("the repo's checkout is gone")?;
        let (base, branch, head) = (&pull.base.ref_, &pull.head.ref_, change.head_sha.as_str());
        let git = |args: &[&str]| -> Vec<String> {
            std::iter::once("git")
                .chain(args.iter().copied())
                .map(String::from)
                .collect()
        };
        let fetch = git(&[
            "fetch",
            "-q",
            "--no-tags",
            "origin",
            &format!("+refs/heads/{base}:refs/remotes/origin/{base}"),
            &format!("+refs/heads/{branch}:refs/remotes/origin/{branch}"),
        ]);
        let run = self
            .host
            .node_run(&checkout, &root, fetch, GIT_TIMEOUT_SEC)
            .await?;
        if run.exit_code != Some(0) {
            return Err(format!("fetching from origin failed: {}", said(&run)));
        }
        let mut argv: Vec<String> = ["sh", "-c", SCRIPT, "fleetd-regenerate"]
            .map(String::from)
            .into();
        argv.extend([
            change.repo.to_string(),
            base.clone(),
            head.to_string(),
            config.migrations.clone().unwrap_or_default(),
            config.generated.len().to_string(),
        ]);
        argv.extend(config.generated.iter().cloned());
        argv.extend(config.run.iter().cloned());
        let run = self
            .host
            .node_run(&checkout, &root, argv, config.timeout_sec())
            .await?;
        let outcome = said(&run);
        let sha = match run.exit_code {
            Some(0) => outcome
                .strip_prefix("done ")
                .map(str::trim)
                .filter(|s| s.len() >= 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(|| format!("it ended without a commit: {outcome}"))?
                .to_lowercase(),
            Some(REFUSED) => return Err(outcome),
            Some(code) => return Err(format!("it failed (exit {code}): {outcome}")),
            None => {
                return Err(format!(
                    "it did not finish within {} min: {outcome}",
                    config.timeout_sec() / 60
                ));
            }
        };
        // Nothing to push: on its base already, with its generated files current. Its conflict is with something
        // else (the PRs ahead of it in a batch), which regenerating doesn't settle.
        if sha == head {
            return Err(format!(
                "it is already on origin/{base} with its generated files current, so there is nothing to regenerate"
            ));
        }
        let lease = format!("--force-with-lease=refs/heads/{branch}:{head}");
        let push = git(&[
            "push",
            "-q",
            &lease,
            "origin",
            &format!("{sha}:refs/heads/{branch}"),
        ]);
        let run = self
            .host
            .node_run(&checkout, &root, push, GIT_TIMEOUT_SEC)
            .await?;
        if run.exit_code != Some(0) {
            return Err(format!("pushing to the PR failed: {}", said(&run)));
        }
        Ok(sha)
    }

    /// After a regeneration: pushed, the PR's new head goes through as any push does; else the Change goes back to its
    /// author when `bounce` and its PR is still at the head the train regenerated (a push meanwhile is the author's).
    async fn regenerated(
        &self,
        change: &Change,
        pull: &Pull,
        why: &str,
        bounce: bool,
        outcome: Result<String, String>,
    ) {
        let key = regen_key(change);
        let ours = |c: &Change| {
            c.head_sha == change.head_sha
                && [
                    ChangeState::Queued,
                    ChangeState::Reviewing,
                    ChangeState::Ready,
                    // Not yet put back by the pass that started it.
                    ChangeState::Rebasing,
                ]
                .contains(&c.state)
        };
        match outcome {
            Ok(sha) => {
                lock(&self.regens).insert(key, Regen::Pushed);
                tracing::info!(change_id = %change.change_id, sha, "train: regenerated and pushed");
                let note = format!(
                    "it {why}; the train rebased it onto {}, regenerated its generated files and pushed {}, which goes \
                     through review and CI as any push does",
                    pull.base.ref_,
                    short(&sha)
                );
                self.update(&change.change_id, None, |mut c| {
                    if ours(&c) {
                        c.last_error = Some(error_text(&note));
                    }
                    c
                });
                self.tell_pushed(change, pull, &sha).await;
            }
            Err(reason) => {
                lock(&self.regens).insert(key, Regen::Failed);
                tracing::info!(change_id = %change.change_id, reason, "train: could not regenerate");
                let current = self.records.get(&change.change_id).filter(|c| ours(c));
                let moved = match self.github.pull(&change.repo, change.pr_number.get()).await {
                    Ok(p) => p.head.sha.to_lowercase() != change.head_sha.as_str(),
                    Err(_) => false,
                };
                match current {
                    Some(current) if bounce && !moved => {
                        let why = format!(
                            "{why}, and the train could not regenerate its generated files: {reason}"
                        );
                        self.needs_rebase(&current, &why).await;
                    }
                    Some(current) => {
                        self.update(&current.change_id, None, |mut c| {
                            c.last_error = None;
                            c
                        });
                    }
                    None => {}
                }
            }
        }
        self.kick(&change.repo);
    }

    /// The author task hears that the train pushed to its PR's branch, so its next push builds on that commit rather
    /// than overwriting it.
    async fn tell_pushed(&self, change: &Change, pull: &Pull, sha: &str) {
        let Some(task_id) = &change.task_id else {
            return;
        };
        let (base, branch) = (&pull.base.ref_, &pull.head.ref_);
        let text = format!(
            "The merge train pushed {} to your PR {} (branch {branch}): it rebased the PR onto origin/{base} and \
             regenerated its generated files, so you don't need to. If you push to this PR again, first run \
             `git fetch origin` and put your new work on top of origin/{branch} (`git rebase origin/{branch}`); never \
             force-push over the train's commit.",
            short(sha),
            change.pr_url
        );
        if let Err(e) = self
            .host
            .message_task(&change.project_ref, super::service::TRAIN_BY, task_id, text)
            .await
        {
            tracing::warn!(change_id = %change.change_id, task_id = %task_id, error = %e, "train: author not told of the push");
        }
    }

    /// Waits for every regeneration started so far: tests.
    #[cfg(test)]
    pub(super) async fn regenerations_done(&self) {
        loop {
            let tasks: Vec<_> = lock(&self.regen_tasks).drain(..).collect();
            if tasks.is_empty() {
                return;
            }
            for task in tasks {
                let _ = task.await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Regenerate {
        Regenerate::parse(
            r#"{ "generated": ["site/docs/", "docs/cli.md"], "run": ["make gen"],
                 "migrations": "store/migrations/" }"#,
        )
        .unwrap()
    }

    #[test]
    fn this_repos_own_config_is_usable() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(CONFIG_PATH);
        let config = Regenerate::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(config.generated("site/docs/index.html"));
        assert!(config.generated("crates/fleetd-contracts/schema/tasks.json"));
        assert!(!config.generated("crates/fleetd/src/main.rs"));
    }

    #[test]
    fn a_generated_file_is_one_under_a_directory_or_the_named_file() {
        let c = config();
        assert!(c.generated("site/docs/index.html"));
        assert!(c.generated("docs/cli.md"));
        assert!(!c.generated("site/docsx/a"));
        assert!(!c.generated("docs/cli.md.bak"));
        assert!(!c.generated("src/main.rs"));
    }

    #[test]
    fn a_config_that_reaches_outside_the_repo_or_runs_two_lines_is_refused() {
        for bad in [
            r#"{ "generated": ["../x"], "run": ["true"] }"#,
            r#"{ "generated": ["/etc/"], "run": ["true"] }"#,
            r#"{ "generated": ["a/"], "run": ["true\nfalse"] }"#,
            r#"{ "generated": ["a/"], "run": ["true"], "timeoutMinutes": 0 }"#,
            r#"{ "generated": ["a/"], "run": ["true"], "other": 1 }"#,
        ] {
            assert!(Regenerate::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_migration_at_or_before_the_bases_newest_is_early() {
        let c = config();
        let added = vec![
            "store/migrations/202610010000_a.sql".to_string(),
            "store/migrations/202610300000_b.sql".to_string(),
            "src/202601010000_c.sql".to_string(),
        ];
        let base = vec![
            "202609010000_x.sql".to_string(),
            "202610150000_y.sql".to_string(),
        ];
        assert_eq!(c.early_migrations(&added, &base), ["202610010000_a.sql"]);
        assert!(c.early_migrations(&added, &[]).is_empty());
    }

    #[test]
    fn the_outcome_is_the_scripts_last_line() {
        let run = NodeRun {
            exit_code: Some(3),
            output_tail:
                "noise\nfleetd-regenerate: renamed a\nfleetd-regenerate: it conflicts in x\n".into(),
        };
        assert_eq!(said(&run), "it conflicts in x");
        let run = NodeRun {
            exit_code: Some(128),
            output_tail: "fatal: no remote\n\n".into(),
        };
        assert_eq!(said(&run), "fatal: no remote");
    }
}
