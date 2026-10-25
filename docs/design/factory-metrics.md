# W9 design (7): factory metrics for any project

Status: design, partly built. This records intent when written; the code is the source of truth. Check `git log` for what has landed.

Written against `origin/main` at `efe10800`.

## 0. What exists, and what can be reused

| Area | What it has today | Use for metrics |
|---|---|---|
| `hub/time` (`store.rs`, `project.rs`, `ingest.rs`) | Spans from the nodes and from the hub's choke points. Per-UTC-day roll-ups (`time_rollups`, kept 400 days, `ROLLUP_DAYS`). Each order's bounds (`time_orders`, start = `workstream.created`). An **event-log projector** that walks `events` from a cursor in `time_cursors` and is woken by the log's append notification, so a replay does nothing. `wait.permission` / `wait.request` spans (category `Human`) with `decidedBy` / `answeredBy`. | **The pattern to copy**: the metrics area is a second projector shaped the same way. It reuses `time_orders` for order bounds and the `time_cursors` helpers. The `Human` spans measure **agents waiting on the person**, not the person's effort, so they don't count toward human minutes (§3.3). |
| `hub/train` (`service.rs`, `github.rs`, `batch.rs`, `records.rs`) | `pr.merged` event when the train lands a Change (`changeId, workstreamId, repo, prNumber, mergedSha, taskId`), batch members included. **`check_merged_outside`** runs every 60 s on each train repo and emits **`pr.merged_outside`** (`repo, prNumber, mergedSha, changeId?`) for PRs merged into the default branch, or a guarded base, without the train. A Change whose PR was merged by hand becomes `Abandoned` with "was merged outside the train". `merged_pulls` reads the 50 most recently updated closed PRs. `trains.watch_since_ms` is the cursor. | The train already sees **merges made outside fleetd**, but only on repos that have a train, only after the train was created, and only from the latest 50 PRs. Metrics read these two events, and add a sweep for repos with no train and for backfill. |
| `hub/status` (`rows.rs`, `credit.rs`) | One row per project with `last_merged`, agents running and the progress bar, read on demand and cached 250 ms. "Nothing estimates time." | A link from each Status row to the project's metrics, plus one small fact on the row (§5.4). The bar itself is unchanged. |
| `hub/prs` (`github.rs`) | `gh pr list` / detail through a short TTL cache. Runs only when a person opens a PR view. | Reuse `GhRunner` and the `explain()` error text. The PR views' cache isn't a metrics source, because it never runs without a viewer. |
| `hub/usage` | Usage-limit parking and the breaker, rebuilt from the event log. | Nothing to reuse for these four metrics. Agent tokens per merged PR could come later (§8 Q12). |
| retro | **Gone** (migration ~481 drops `retro_runs` / `retro_proposals`; `prompts/retired.rs` says "fleetd no longer runs a retro"). | Nothing to reuse. Don't revive it. Metrics are numbers, not a lead turn. |
| chat (`hub/chat`) | `chat.message` events and stored messages with `author` (human / lead / agent / system), `client` (app / cli), `by` (key name), `created_at`. Inline items (secret request, command approval) and their `answered_at`. | The main source of human touches. The asks were folded into the chat (#245), so "answering asks" now means human chat replies and answered inline items. |
| Time screen (`app/desktop/src/renderer/screens/time`) | Filter bar (range presets, project, machine, role, compare), Breakdown, Insights, Timeline on a canvas. No chart library; marks are drawn by hand from CSS tokens. | Reuse `filters.ts` (range presets, `period()`, saved filters) and `format.ts` (`fmtDur`). Draw plain SVG the same way. No new dependency. |

**What's missing:** a durable record of merges (events are pruned at 30 days), merges in repos with no train, direct
pushes, the time an order was *requested* (as opposed to opened), any measure of the person's own time, and a view.

Two facts that shape everything:

- **Agents commit under the human's own git identity** (`node/actions.rs` reads `GIT_AUTHOR_EMAIL` / global
  config), and `gh` runs under the human's login. **Git author and PR author can't tell agent work from human work.**
  Only fleetd's own records can: Changes, tasks, `fleetd/T<n>-…` branches, and the train's scratch prefix.
- **The train batches.** It squash-merges one batch PR, then *closes* each member PR with a link. Counting GitHub
  merged PRs would count one merge where fleetd landed eight, and none of the eight members.

## 1. The unit: a landed change

Every metric counts **landed changes**. A landed change is one unit of work whose content reached the repo's
**default branch**:

- a PR merged into the default branch (by anyone, by any method: merge, squash or rebase);
- each **member** of a train batch, counted once. The batch PR itself is not counted (its head starts with the
  train's scratch prefix, the same test `check_merged_outside` uses);
- a **direct push**: a first-parent commit on the default branch that no PR and no Change is associated with.

Not counted (each shown as a count in the tooltip, never silently dropped):

- PRs into any other base, unless the train guards that base (same rule as `check_merged_outside`);
- PRs by bot accounts (GitHub `user.type == "Bot"`: dependabot, renovate…). These are excluded from all four
  metrics;
- closed-unmerged PRs and drafts;
- merge-backs: a PR whose head is the default branch of another remote, or a branch that is itself the base of PRs
  (release → main).

Each landed change gets one **route**:

| Route | Rule | Plain label |
|---|---|---|
| `train` | A Change in state `Merged` (from `pr.merged`), batch members included. | Through fleetd |
| `fleetd_by_hand` | Written by fleetd but landed without the train: `pr.merged_outside` with a `changeId`, or a PR whose head is `fleetd/T…` / whose `head_sha` is a known task's, with no Merged Change. | Made by fleetd, merged by you |
| `outside` | A merged PR with no Change and no fleetd branch. If design (1)'s ledger has a claim for it from a human session, it is tagged `seen` but keeps this route. | Merged outside fleetd |
| `direct` | A first-parent commit on the default branch with no PR. | Pushed straight to the default branch |

"In the last order, most work was merged directly by the human" is the `fleetd_by_hand` and `outside` / `direct` gap.
The design keeps `fleetd_by_hand` separate on purpose: it is where fleetd did the work but not the landing, and it is
the case the human most wants to see shrink.

Metrics are **keyed by repo**, not by project. A project is (machine, path), and the same repo can be checked out on
two machines. Each project's view shows its repos' landed changes. The fleet's totals dedupe on
(repo, unit). When two projects share a repo, both views show the same merges and say so ("also checked out on
devbox-2").

## 2. The four metrics, exactly

All periods are **calendar days in the viewer's time zone** (the tool takes `tz`). Days with zero merges count:
"per day" is a rate over the range, not an average over active days.

### 2.1 Pull requests merged per day

- **Definition:** landed changes (all four routes, bots excluded) with `merged_at` in the range, divided by the
  calendar days in the range. Today counts as a fraction: elapsed hours / 24, at least 1 hour.
- **Shown:** the rate. Per day, a column split by route. A delta vs the previous period of the same length.
- **Per project / fleet:** per repo, deduped across projects for the fleet.
- **Sources:** `pr.merged` (immediate) for `train`, `pr.merged_outside` for the train's repos, and the **host sweep**
  (§4.2) for every repo and for backfill. Direct pushes come from git or the git host's commits list (§4.3).

### 2.2 Time from order to merged

- **Definition:** for each landed change that belongs to an order (route `train` or `fleetd_by_hand`, so it has a
  `workstream_id`): `merged_at − order.requested_at`.
  - `requested_at` is when the human asked: `Workstream.source.at` when the human submitted the order (channel App or
    MCP, `by` "human"). When the lead opened it from the chat (channel Lead), it is the `created_at` of the
    **earliest human chat message delivered in the lead run that opened it**. That needs a new stamp (PR 5). Until
    then it falls back to `workstream.created`, flagged "from when the lead opened it". That runs later than the real
    request by the lead's turn.
- **Shown:** median and p90, with n. Not the mean, because one week-long order swamps it. A dot per PR over time.
- **Included:** orders that are done, stopped or still open. A PR merged from a stopped order still counts.
- **Excluded:** `outside` and `direct` changes, which have no order. They are shown as "n merged with no order". For
  a like-for-like comparison across routes, the tooltip and the list also give **PR open → merged** for every PR
  (`pr_created_at` → `merged_at`), which the git host has for all routes.
- **Per stage**, for the list and the tooltip: requested → first PR opened → review passed → merged. These come from
  stamps kept on the merge row when `change.state` events pass (§4.1), because the event log is pruned at 30 days.
- **Order-level figure** (secondary, in the list): `last merge − requested_at` for done orders.

### 2.3 Human minutes per merged pull request

- **Headline definition:** *(estimated human minutes on fleetd work in the range)* / *(landed changes with route
  `train` or `fleetd_by_hand` in the range)*.
  - "On fleetd work" means touches on fleetd surfaces (chat, inline items, steers, decisions, the app) plus GitHub
    reviews and comments on fleetd-written PRs, plus merging fleetd PRs by hand.
- **Second figure** (in the breakdown, labelled as a lower bound): *(visible human minutes on outside work)* / *(landed
  `outside` + `direct` changes)*. fleetd sees almost none of the time behind outside work (§3.4), so this number is
  always low. It is shown so the human can see the gap, not to compare against.
- It is a **ratio of period totals**, not a sum of per-PR attributions. A chat reply rarely belongs to one PR, and
  splitting it would invent precision. The list does show touches that do belong to one PR (a review on it, its manual
  merge).
- Estimation, floors, what is invisible: §3.

### 2.4 Share of merged work through fleetd

- **Headline:** `train` / all landed changes in the range, as a percentage, by count.
- **Shown beside it:** "made by fleetd" = (`train` + `fleetd_by_hand`) / all. The gap between the two numbers is work
  fleetd wrote that the human landed by hand.
- **Weighted by count**, not lines. The tooltip gives lines changed per route so a reader can tell if outside work is
  the big changes (§8 Q3).
- Also per day, as the route split of chart A (§5.2).

## 3. Human minutes, estimated honestly

### 3.1 Touches

A **touch** is one observed act by the person, with a time and a **credit**: the least time the act could take.

| Touch | Source | Credit (floor) | Notes |
|---|---|---|---|
| Chat message sent (app or `fleetd chat`) | `chat.message`, author `human` | max(1 min, chars / 150 per min) | ≈30 wpm typing. Only the message, not thinking before it. |
| Inline item answered (command approval, secret) | approval / secret records `answered_at`, answered by a human key | 30 s | `decidedBy: human` on `wait.permission`. Policy- and lead-answered prompts never count. |
| Steer to an agent | `steers` rows by a human key | 1 min | |
| Decision recorded by the human | `decision.recorded`, source `human` | 1 min | |
| Order submitted directly | `workstream.created`, channel App/MCP by human | max(1 min, chars / 150) | |
| GitHub review submitted on a project PR | host sweep: reviews by a non-bot login, `submitted_at` | 3 min + 1 min per 100 changed lines, at most 20 | **Estimated, and marked so.** GitHub records when a review was submitted, not how long it took. |
| GitHub review or PR comment | host sweep | 30 s each | |
| PR merged by hand | `fleetd_by_hand` / `outside` merges where the merger is a human | 1 min | |
| Commit pushed by the human | commits on non-`fleetd/` branches and direct pushes | 2 min | The writing behind it is invisible (§3.4). |
| App in use | **new**: the app reports intervals when its window is focused, a project's screen is showing and there was input in the last 60 s (PR 7) | the interval itself | The strongest signal, and desktop only. It covers reading the lead's replies and PRs in the app. |
| Human Claude Code session (design 1) | the session's claim open / close and its fleetd MCP calls, through the ledger of work in flight | 1 min per MCP call; none for the claim being open | An open session is not attention. Only acts count. |

The floors are constants in one place (`hub/metrics/human.rs`) and are listed on the view's info sheet. Each touch
carries its project (and its order or PR when it has one) and the key that made it.

### 3.2 From touches to minutes

Per day and project, after sorting touches by time:

1. Each touch becomes the interval `[at − credit, at]`: the act happened before it was recorded. App-use intervals
   are taken as they are.
2. Intervals less than **5 minutes** apart are bridged into one session: someone answering in the chat three minutes
   after the last answer was most likely there all along.
3. Human minutes = the length of the **union** of the sessions, so app focus and chat messages in the same minute
   count once.

The view shows that number. The info sheet gives the **low bound**: the union of credits alone, with no bridging.
"≈ 42 min (at least 31)". Both are computed the same way every time, so a trend is honest even if the level is a
little off.

### 3.3 Not counted as human minutes

- `wait.permission` / `wait.request` spans: that is **how long agents waited** on the person. It is mostly the person
  being away. It belongs on the Time screen's critical paths, where it already is.
- An open chat with no action, or an open human session with no act.
- Lead and agent time of any kind.

### 3.4 What fleetd can't see (stated on the view)

- Thinking and planning away from the keyboard; meetings; Slack.
- Time in an editor or IDE, or a Claude Code session that isn't registered with fleetd.
- Reading on GitHub's website without leaving a review or comment, and reading time before an approval.
- The real length of a review: GitHub keeps only when it was submitted.
- Work on machines with no fleetd node, or on a phone.
- Typing in a human Claude Code session: fleetd sees only the session's fleetd calls unless the human opts in to
  sharing transcript timing (§8 Q8).

So human minutes per PR through fleetd is close to a **lower bound** where the human works in the app and chat, and a
loose lower bound otherwise. The outside-work figure is a bare minimum. The view says so in one line under the tile:
"From what fleetd sees: chat, approvals, reviews, the app. Your editor and thinking time aren't in it."

## 4. Sources, storage, computation, cadence, retention

### 4.1 Hub tables (new migration)

```sql
-- One row per landed change. Written by the projector (fleetd events) and the host sweep, merged on unit_key.
CREATE TABLE metric_merges (
  repo TEXT NOT NULL, unit_key TEXT NOT NULL,          -- "pr:<n>" or "commit:<sha>"
  machine_id TEXT, project_id TEXT,                    -- the owning project (train owner, else newest Change's, else the first project on the repo)
  pr_number INTEGER, merged_ms INTEGER NOT NULL, merged_sha TEXT,
  route TEXT NOT NULL,                                 -- train | fleetd_by_hand | outside | direct | bot | skipped
  skip_why TEXT,                                       -- other_base | merge_back | ...
  workstream_id TEXT, task_id TEXT, change_id TEXT, batch_pr INTEGER,
  requested_ms INTEGER, requested_basis TEXT,          -- source | chat | opened
  pr_created_ms INTEGER, first_pr_ms INTEGER, review_passed_ms INTEGER,
  author_kind TEXT,                                    -- human | bot | unknown (the git host's, not git's)
  merged_by_kind TEXT,                                 -- train | human | bot | unknown
  additions INTEGER, deletions INTEGER,
  seen_claim TEXT,                                     -- design (1): the claim id that saw it, if any
  src TEXT NOT NULL,                                   -- event | host | git: the best source that wrote it
  PRIMARY KEY (repo, unit_key)
) WITHOUT ROWID;
CREATE INDEX metric_merges_by_day ON metric_merges (merged_ms);
CREATE INDEX metric_merges_by_order ON metric_merges (workstream_id) WHERE workstream_id IS NOT NULL;

-- Human touches; idempotent on (src, src_key) like time_spans.
CREATE TABLE metric_touches (
  id INTEGER PRIMARY KEY, src TEXT NOT NULL, src_key TEXT NOT NULL,
  kind TEXT NOT NULL, at_ms INTEGER NOT NULL, credit_ms INTEGER NOT NULL, end_ms INTEGER,   -- end_ms: app-use intervals
  machine_id TEXT, project_id TEXT, repo TEXT, workstream_id TEXT, pr_number INTEGER,
  key_id TEXT, estimated INTEGER NOT NULL DEFAULT 0,  -- 1 for review credits
  UNIQUE (src, src_key)
);
CREATE INDEX metric_touches_by_at ON metric_touches (at_ms);

-- Per-repo host cursors and what the sweep last saw (for staleness).
CREATE TABLE metric_repos (repo TEXT PRIMARY KEY, host TEXT NOT NULL, default_branch TEXT,
  merged_cursor_ms INTEGER, commits_cursor_sha TEXT, reviews_cursor_ms INTEGER,
  last_ok_ms INTEGER, last_error TEXT, backfilled_ms INTEGER);
```

The projector cursor goes in `time_cursors` under `metrics:events`, through `time::store::{cursor, set_cursor}`, so
there is no second cursor table.

**No daily roll-up table.** There are at most a few thousand merge and touch rows a year per fleet. Medians and p90
don't add across days, and days must be cut in the viewer's zone. So reads compute from rows, with a cache keyed by
(event head, metric_repos version, query) like `status::rows::reusable`. That stays well under the `time_breakdown`
read budget. If a fleet ever outgrows this, a roll-up of counts and human ms can be added without changing the tool.

### 4.2 Writers and cadence (nothing assumes a nightly, a CI or a release cadence)

1. **Event projector** (`hub/metrics/project.rs`): a copy of `time/project.rs`'s loop. It wakes on each append and
   folds these:
   - `pr.merged` → a `train` row. Stamps `merged_ms`, `requested_ms` from the workstream, and `batch_pr`.
   - `pr.merged_outside` → `fleetd_by_hand` when it has a `changeId` or a fleetd branch, else `outside`.
   - `change.state` → stamps `first_pr_ms` (first `queued`) and `review_passed_ms` (first move to `ready`) on a
     pending row keyed by change. These are kept because the event log goes after 30 days.
   - `chat.message` (human), approvals and secrets answered, steers, `decision.recorded` (human),
     `workstream.created` → touches.
   - The new `app.presence` → touches (PR 7).
   It is immediate, has no timer, and replays to the same rows.
2. **Host sweep** (`hub/metrics/sweep.rs`): per repo of every added project, not only repos with a train:
   - it reads merged PRs since `merged_cursor_ms`, paging until it passes the cursor (not one page of 50), with
     author type, merged-by, head ref, `created_at`, additions and deletions;
   - it reads reviews and comments on PRs updated since `reviews_cursor_ms`;
   - it reads the default branch's commits since `commits_cursor_sha` and asks which PR each belongs to (§4.3), to find
     direct pushes.
   - **When it runs:** (a) when a node reports the default branch moved. Design (5) has every worktree branch from a
     freshly fetched remote default branch, so the node already fetches; it adds `repo.advanced {repo, from, to}` to
     the event it sends. (b) When the metrics view or tool is read and the repo's last sweep is older than 60 s. (c) A
     low-rate fallback, so merges the human makes while no agent runs are still seen: every 15 min while the repo had
     activity in the last 7 days, else hourly. The rate is per repo, shared with the train's GitHub budget (one gh
     process at a time per hub, like `PrsGitHub.fetch`).
   - For train repos, the train's 60 s `check_merged_outside` stays the fast path, and the sweep only fills what it
     can't see (no train yet, more than 50 PRs, reviews, direct pushes).
   - **Backfill:** on first sight of a repo, it reads 90 days back (bounded pages), so the trend is there on day one.
     Routes for old PRs come from the `changes` table (kept forever) and `fleetd/` branch names. Human touches from
     before go back as far as the chat, approvals, steers and decisions tables hold them. Review touches are backfilled
     from the git host. App use can't be backfilled.
3. **Reads** (`hub/metrics/compute.rs`, pure): range + tz + scope → tiles, daily series, merge list. They are
   unit-tested like `time/path.rs` and `status/credit.rs`.

Staleness: `metric_repos.last_ok_ms` feeds `status::fresh` the same way `fresh::github(repo)` does. A repo whose sweep
has been failing shows "GitHub not read since 14:02" on the view, never a silent zero.

### 4.3 Git host abstraction (GitHub first)

```rust
// hub/metrics/host/mod.rs
trait GitHost: Send + Sync {
    fn merged_since(&self, repo: &RepoRef, since_ms: i64) -> BoxFut<'_, Result<Vec<MergedPr>, GitHostError>>;
    fn reviews_since(&self, repo: &RepoRef, since_ms: i64) -> BoxFut<'_, Result<Vec<ReviewAct>, GitHostError>>;
    fn default_commits(&self, repo: &RepoRef, after: Option<&str>) -> BoxFut<'_, Result<Vec<LandedCommit>, GitHostError>>;
    fn prs_of_commit(&self, repo: &RepoRef, sha: &str) -> BoxFut<'_, Result<Vec<i64>, GitHostError>>;
}
```

| Host | Merged PRs | Merge time / sha | Reviews | Commit → PR | Bot flag |
|---|---|---|---|---|---|
| **GitHub** (`gh api`, the hub's login) | `pulls?state=closed&sort=updated&direction=desc` paged, or GraphQL `search(is:pr is:merged merged:>=…)` | `merged_at`, `merge_commit_sha`, `merged_by` | `pulls/{n}/reviews`, `issues/comments`, `pulls/comments` | `commits/{sha}/pulls` | `user.type == "Bot"` |
| GitLab (`glab api` / token) | `merge_requests?state=merged&updated_after=` | `merged_at`, `merge_commit_sha` / `squash_commit_sha`, `merged_by` | MR `notes`, `approvals` (approvals have no time on older versions: use the note) | `repository/commits/{sha}/merge_requests` | `author.bot` (16.x+), else a known-bot list |
| Gitea / Forgejo | `pulls?state=closed` + `merged` | `merged_at`, `merge_commit_sha`, `merged_by` | `pulls/{n}/reviews` | none: match `merge_commit_sha` | known-bot list |
| Bitbucket Cloud | `pullrequests?state=MERGED&q=updated_on>…` | `updated_on` when state MERGED, `merge_commit.hash`, `closed_by` | `activity` (approvals with dates) | `commit/{sha}/pullrequests` | `account type == app` |
| Azure DevOps | `pullrequests?searchCriteria.status=completed` | `closedDate`, `lastMergeCommit`, `closedBy` | `threads` | `pullrequestquery` by commit | `isContainer` / service identity |
| **No git host, or an unknown one** | (none) | `git log --first-parent --format=%H%x00%cI%x00%s origin/<default>` run on the node | (none) | the `merged_sha` of fleetd's Changes, and a `Fleetd-Change:` trailer (below) | (none) |

**Git-only fallback:** every first-parent commit on the default branch is a landed change. It is `train` if it matches
a Merged Change's `merged_sha` or carries the trailer, else `direct`/`outside` (they can't be told apart without a
git host, so it is labelled "outside fleetd"). For this to work on any host, the train adds a
`Fleetd-Change: C<n> (T<n>, W<n>)` trailer to the squash message it writes (`train/github.rs` `merge` already sets
`commit_message`). A human who merges a fleetd PR by hand with the git host's default message keeps the PR's commits,
which carry no trailer today. So agents' commits also get `Fleetd-Task: T<n>` (`node/worktree.rs` commit template),
which lets `fleetd_by_hand` be found from git alone.

The hub knows a repo's host from `RepoFacts.remote` (`short_remote` / `github_repo`). Only GitHub ships first. The
others are named so the trait has the right shape; each is its own m-sized PR when a user needs it.

### 4.4 Retention

- `metric_merges` and `metric_touches`: **400 days**, the same as `time::store::ROLLUP_DAYS`. Pruned in the time
  area's hourly prune loop (one more `DELETE … WHERE merged_ms < ?` / `at_ms < ?`). A row is ~300 bytes. At 50 merges
  and 200 touches a day that is under 30 MB a year.
- `metric_repos`: kept while the repo belongs to a project, and deleted with the project.
- The retention can be set like `time_retention_set` (a `metrics_retention_days` key in `time_settings`, minimum 30).
- **Because merges are stored, the metrics outlive the 30-day event log and the 30-day span retention.** A 90-day trend
  works even though the events behind it are gone.

## 5. The app view

### 5.1 Where it lives

- A new secondary screen **Factory** at `#/factory`, with an optional `?project=<machine>/<project>`, in the sidebar
  between Status and Time (`shell/routes.ts`, `Sidebar.tsx`), with a ⌘ shortcut beside Status's.
  - Status is "now", Time is "where agent time went", Factory is "what came out and what it cost you". Folding it
    into Time would mix agent minutes with human minutes on one screen, which is exactly the confusion §3.3 avoids.
- Each **Status row** gets one fact in its hover, "12 merged this week · 64 % through fleetd", that links to
  `#/factory?project=…`.
- The CLI gets `fleetd metrics [--project p] [--days 30] [--json]`, and the lead can call `metrics_get` (read-only,
  `Role::Read`).

### 5.2 Layout (dataviz: form first, color last)

**One filter row** above everything (dataviz: filters in one row, date range first, they scope everything below):
range presets **Last 7 days · Last 30 days (default) · Last 90 days · Custom**, then project (All projects / one),
then a "Compare with previous period" toggle. It reuses `screens/time/filters.ts` (`period()`, `parseWhen`, saved
filters) with its own saved key. A refetch keeps the frame at reduced opacity, with no skeleton flash after the first
load.

**At a glance: a KPI row of four stat tiles** (dataviz: a handful of headline numbers is a KPI row, not a chart).
Each tile has a sentence-case label, the value in sans semibold with auto-compact figures, a signed delta vs the
previous period, and a 12-point sparkline in the de-emphasis gray with the current point in the accent.

| Tile | Value | Delta colour (direction × good) | Under the value |
|---|---|---|---|
| Merged per day | `4.3` | up = good | "129 in 30 days" |
| Order to merged | `3 h 10 m` median | down = good | "p90 19 h · 84 PRs" |
| Your minutes per merged PR | `≈ 6 min` | down = good | "≈ 8 h 20 m in all · from what fleetd sees" (links to §3.4's sheet) |
| Through fleetd | `64 %` | up = good | "81 % made by fleetd" |

There are no hero figures. All four are equal, because the factory is measured by all four together. Delta colours
use the status ramp only for good/bad, with an arrow and a sign, never colour alone.

**Chart A: Merged per day, by route.** A stacked column per day, bucketed by week on 90 days. It answers both 2.1 and
2.4 over time. There are four categorical series in a **fixed order, bottom up: Through fleetd, Made by fleetd and
merged by you, Merged outside fleetd, Pushed straight**. The colour follows the route on every chart and is never
re-cycled when a filter removes one. Four series means direct labels are required (dataviz series ladder): label each
segment's name at the right end of the last non-empty column, with a legend above. Marks: thin columns, 4 px rounded
top on the stack's top segment only, a 2 px surface gap between segments and between columns, recessive grid, and
zero days drawn as an empty slot on the baseline. Hover shows the day, each route's count and the PR numbers (top 5,
"+n more"). A click filters the list below to that day. Bots and skipped PRs are not stacked. The day's tooltip gives
them as a line: "2 bot PRs not counted".

**Chart B: Order to merged.** A dot per landed change: x = merged date, y = order-to-merged on a log time axis
(10 m, 1 h, 6 h, 1 d, 1 w), with the period's median as a 2 px line and its label at the right. This is the
**emphasis** form: dots in one accent hue, ≥ 8 px with a 2 px surface ring where they overlap. `fleetd_by_hand` dots
are hollow, so route is not colour alone. Hover shows the PR, its order, and the stage split
(requested → PR → reviewed → merged). It is one series, so there is no legend, and the title names it.

**Chart C: Your minutes per day, by source.** Stacked columns. Sources are folded to at most **five** in fixed order:
Chat & approvals, Reviews on GitHub, The app, Your sessions, Other (steers, decisions, merges, commits). Estimated
segments (reviews) carry the texture fill **only** when the accessibility or print mode asks for it. Otherwise they
take a lighter step of the same hue, with "estimated" in the legend. Hover shows minutes per source and the touches
counted. The line under the title says what is invisible.

There is no dual axis anywhere. Merges and minutes are different scales, so they are separate charts (dataviz
non-negotiable), stacked vertically with a shared x domain so a day lines up.

**Below: the merge list** (the table view the accessibility pass requires). One row per landed change: date,
repo#PR, title, route (word + swatch), order (link to its chat), order-to-merged, PR open-to-merged, lines ±, human
touches on it. It sorts by any column and gives CSV through "Copy as table". Under "All projects" a **projects
table** sits above it: one row per repo with the four numbers and a sparkline column. That is the cross-fleet
comparison; with more than 4 projects a table reads better than small multiples.

**Empty and partial states:** "No merges in this range." When the git host can't be read: "fleetd hasn't read GitHub for
acme/web since 14:02: `gh` is signed out", using `prs::github::explain`. On a repo with no host, the host-only
figures are absent: reviews show "—", and the tile says why.

**Colour:** use the app's existing category tokens. The PR that builds the screen runs the skill's
`validate_palette.js` over the four route hues, in light and in dark against the app's surfaces, and records the
output in the PR. Dark mode takes its own steps from the same ramps. Text is always in ink tokens, never the series
colour.

### 5.3 Not on the view

There are no time estimates or forecasts (in keeping with Status's "nothing estimates time"), no agent cost, and no
per-person leaderboard.

### 5.4 Status row

Status adds only `merged_7d` and `through_fleetd_pct_7d` to `ProjectStatusRow`, read from the same compute, for the
hover line and the link. The bar is unchanged.

## 6. Modules to touch

| Module | Change |
|---|---|
| `crates/fleetd-contracts/src/metrics.rs` (new), `mcp.rs` | `MetricsGetInput {project?, since, until?, tz, compare}`, `MetricsGetOutput {tiles, days[], merges[], projects[], coverage}`, `MergeRoute`, `TouchKind`, `Coverage {repos, stale[], invisible[]}`. Tool table entries and the TS schema parity test. |
| `crates/fleetd-contracts/src/events.rs` | `app.presence` and `repo.advanced` event types. Richer `pr.merged_outside` data: `mergedAt`, `head`, `authorKind`. |
| `crates/fleetd/src/hub/metrics/` (new) | `mod.rs` (area wiring, like `time/mod.rs`), `store.rs` (tables, upserts, prune), `project.rs` (event projector), `sweep.rs` (per-repo scheduler), `host/{mod,github}.rs`, `human.rs` (touches → minutes, pure), `compute.rs` (tiles, series, list, pure), `tools.rs` (`metrics_get`, `metrics_retention_set`), `tests.rs`. |
| `hub/store/migrations.rs` | The three tables. |
| `hub/time/mod.rs` | Call the metrics prune from the hourly prune loop (or give metrics its own loop). Share `time::store::cursor`. |
| `hub/train/service.rs`, `train/github.rs` | `merged_pulls` pages to the cursor and returns `user.type`, `merged_by`, `created_at`. `check_merged_outside` adds those to `pr.merged_outside`. `finish_merged` adds `mergedAt` and the batch PR. The squash message gets the `Fleetd-Change:` trailer. |
| `hub/leads/workstreams.rs` / `leads/calls.rs` / `chat/flow.rs` | Stamp `requested_at` (+ basis) on an order the lead opens, from the human messages its run was woken by. `Workstream` gets an optional `requested_at`. |
| `node/` (worktree commit, session events) | `Fleetd-Task:` trailer on agent commits. `repo.advanced` after the fetch that design (5) adds. The git-only `landed_log` command (later PR). |
| `hub/app_ws/` | Accept the app's presence frames and turn them into `app.presence` events, rate-limited to one per minute per key. |
| `hub/api` / tool registry | Register the metrics tools under `Role::Read`. |
| `hub/status/rows.rs`, contracts `status.rs` | The two 7-day fields. |
| `crates/fleetd/src/cli/` | `fleetd metrics`. |
| `app/desktop/src/renderer/screens/factory/` (new) | `FactoryScreen.tsx`, `Tiles.tsx`, `charts/{Merged,Lead,Minutes}.tsx` (SVG), `MergeList.tsx`, `data.ts`, `fixture.ts`, tests. `shell/routes.ts`, `Sidebar.tsx`, `status/StatusScreen.tsx` hover link, palette command. |
| `app/desktop/src/main/` | Window focus, input activity and the visible route → presence frames over the hub link. |
| `tests/lab/factoryMetrics.ts` (new) | The lab scenario on a non-fleetd repo (done:0). |
| `docs/site` | One page, "What the factory numbers mean": §1–§3 in plain words. |

## 7. Build plan

| # | PR | Size | Depends on | Can run alongside |
|---|---|---|---|---|
| 1 | **contracts**: metrics shapes, tool table, new event types, TS parity | s | (none) | 5 |
| 2 | **hub core**: tables, event projector (`pr.merged`, `pr.merged_outside`, `change.state`, `workstream.created`), compute for metrics 1, 2 and 4 on train repos, `metrics_get`, prune | m | 1 | 5, 6 |
| 3 | **host sweep, GitHub**: every project's repo, paging, 90-day backfill, bots, merge-backs, direct pushes via commits → PRs, staleness; richer `merged_pulls` / `pr.merged_outside`; `repo.advanced` trigger once design (5)'s fetch exists (else the timer and on-read triggers alone) | m | 2 | 4, 8 |
| 4 | **human touches**: projector for chat, items, steers, decisions; review and comment touches from the git host (needs 3's reader: land after 3, or stub it); `human.rs` sessionizing; metric 3 | m | 2 (3 for reviews) | 3, 8 |
| 5 | **order request time**: `requested_at` on lead-opened orders, from the waking human message | s | (none) | 1, 2, 6 |
| 6 | **app Factory screen** on fixtures: route, sidebar, filter row, tiles, three charts, list, projects table, empty and stale states, palette validated | m | 1 | 2, 3, 4, 5 |
| 7 | **app presence**: main-process focus and input → hub `app.presence` → touches; setting to turn it off | m | 4 | 8, 9 |
| 8 | **CLI + Status**: `fleetd metrics`, the Status row's 7-day fact and link | s | 2 | 3, 4, 7 |
| 9 | **lab scenario** on a non-fleetd repo: one change through the train, one fleetd PR merged by hand, one human PR, one direct push, chat and approval touches. Asserts routes, share, lead time and minutes within the stated floors | m | 2, 3, 4 | 7 |
| 10 | **trailers + git-only fallback**: `Fleetd-Change` / `Fleetd-Task` trailers, node `landed_log`, no host route rules | m | 2 | after 3 |
| 11 | **human sessions** (design 1): touches from registered human Claude Code sessions' fleetd calls and claims | s | 4, design (1)'s ledger | 7 |
| 12 | **other git hosts**: GitLab first, each further host its own PR | m each | 3 | (any) |

Order: 1 and 5 → {2, 6} → {3, 4, 8} → {7, 9} → {10, 11, 12}. PRs 1 to 9 cover the workstream's part (7) for GitHub
projects. 10 to 12 widen it to any host.

## 8. Open questions, each with a recommendation

1. **Where does the view live?** A new screen, a Time tab, or Status columns. → **A new `#/factory` screen**, linked
   from Status rows (§5.1). It keeps human minutes apart from agent minutes.
2. **What is one "PR"?** A GitHub PR or a landed change. → **A landed change**: batch members count one each, the batch
   PR counts zero, and direct pushes count. Otherwise every batch undercounts fleetd up to 8×.
3. **Weight the share by count or by size?** → **Count**, with lines ± per route in the tooltip. Size is easy to
   game and penalizes small, safe PRs.
4. **Is a fleetd-written PR merged by hand "through fleetd"?** → **No** for the headline. It shows as its own route and
   in "made by fleetd". The human's last order is exactly this case, and folding it in would hide it.
5. **Calendar days or working days?** → **Calendar days** in the viewer's zone, with zero days shown. Working days
   assume a schedule fleetd doesn't know.
6. **Bots?** → **Excluded** from all four, counted in the tooltip.
7. **App presence reporting.** → **On by default.** It sends only focused / project-on-screen / input-in-the-last-minute,
   never keystrokes or content, stays on the hub, and can be turned off in Settings › General. Without it, metric 3
   misses most reading time.
8. **Read the human's local Claude Code transcripts for prompt timing?** → **Not now.** Count only the fleetd-visible
   acts of sessions registered through design (1). Revisit as an explicit opt-in that sends timing and lengths only,
   never text.
9. **Order start for lead-opened orders.** → **The waking human message's time** (PR 5), falling back to
   `workstream.created`, flagged.
10. **Several people on one hub?** → **One "you" for now**, keeping `key_id` on every touch so a per-person split can
    come later without a migration.
11. **The touch floors (§3.1).** → **Ship the stated constants, label reviews "estimated"**, and show the low bound.
    Revisit after two weeks of the human's real data (done:2 asks them to trust the numbers).
12. **Add agent cost per merged PR (tokens, agent minutes)?** It's cheap from `time_rollups` and usage. → **Later**, as
    a fifth tile. It isn't one of the four asked for, and it would crowd the KPI row.
13. **Retention.** → **400 days** like the time roll-ups, settable down to 30.
14. **Projects sharing a repo.** → **Key by repo**, show the same merges under both projects with a note, and dedupe
    for the fleet.
15. **Should the sweep reuse the train's loop?** → **No.** Keep the sweep in `hub/metrics`, and let the train's 60 s
    outside-merge check stay the fast path on train repos. Projects with no train still need it, and the train
    shouldn't grow a reporting job.
