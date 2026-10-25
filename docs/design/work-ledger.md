# W9 design (1): one ledger of work in flight

Status: design, partly built. This records intent when written; the code is the source of truth. Check `git log` for what has landed.

Read from origin/main at `efe10800`.

## 0. The short version

- **Don't build a second task table.** Most of the work in flight is already in the hub: write tasks (queued, running
  or idle) with their branches and the paths they've changed so far, the train's Changes, and plan items linked to
  tasks or PRs. The ledger is a **read view** over those, plus two new tables: `work_claims` for work fleetd can't
  see (the human's sessions, and anything else that declares its intent) and `landings` for every commit that reaches
  a base branch, however it got there.
- **Outside merges are seen with plain git, on any host.** The node runs `git ls-remote` once a minute per watched
  base and, when the base has moved, `git fetch` and `git log --first-parent`. Each new commit becomes a landing.
  Its route (train, PR merged outside the train, or direct push) is worked out from the Changes' `merged_sha` and
  the commit message. GitHub's API only adds detail, so it's optional. Today only GitHub PRs merged outside the train
  are noticed, only on repos that have a train, and the result is one line to the lead that links to nothing.
- **Matching runs in three tiers, and only exact ids block.** (1) Exact ids are refused outright: the same plan item,
  issue, PR or branch. (2) A strong match (several shared title words plus a shared file, or a near-identical title)
  is a **one-time refusal**: the lead calls again with `notDuplicateOf: [ids]` and its reason, and the spawn goes
  through. (3) Weak matches are only listed in the result. A refusal costs one extra call, so a false positive never
  blocks real work.
- **Where it plugs in:** `spawn_agent` (the check), the lead's digest (an "Elsewhere" section), the hub's MCP
  (`work_claim` / `work_list` / `work_done`, with server `instructions` telling Claude Code to call them), a
  `fleetd work` CLI that reads the repo, branch and changed paths from the session's cwd, and the app's Agents tab.
- **The build is 8 PRs (5 m, 3 s).** After the first two, four can run in parallel.

## 1. What exists today (findings)

| Piece | Where | What it gives the ledger | Gap |
|---|---|---|---|
| Write tasks | `hub/tasks/mod.rs:919` `spawn`; `Task` in `contracts/tasks.rs` | Title, prompt, `item_id`, branch, state Queued/Running/Idle = in flight | Spawn checks only the workstream, the fan-out and `check_spawn_item`. Nothing compares the new work with other work. |
| Observed paths | `Tasks::also_writing` (`tasks/mod.rs:1311`) → `ports.changes(thread)` → node `worktree::changes` (`node/worktree.rs:142`) | Files each running writer has changed so far | Shown only as information in the spawn result, never compared with anything |
| #387 "one file, one writer" | `assets/prompts/lead.start.md` only | — | **There is no lease code.** `grep lease` finds nothing in `crates/fleetd/src`. It's a prompt rule plus the `also_writing` line. The ledger is what turns it into a check. |
| Plan items | `hub/plan/mod.rs` (`check_spawn_item` :619, `link_task`, `link_pr`, `verify` :712) | Planned intent with stable ids; links to tasks and PRs | `status/progress.rs:85` `verified`: "a bypass merge never counts". Work merged outside fleetd leaves the item open forever, and the lead spawns it again. **This is the 9-agent bug.** |
| Train Changes | `contracts/train.rs:124` | PR, head branch, `task_id`, `patch_id`, `merged_sha` | — |
| Merges outside the train | `train/service.rs:1257` `check_merged_outside`; `trains.watch_since_ms` | `pr.merged_outside` event and a wake line | GitHub PRs only; only repos with a train; misses **direct pushes** to main; tied to no item, task or claim |
| Open PRs | `train/github.rs:785` `open_pulls` (60 s `ready_every`) | Every open PR on the repo, not just fleetd's | Used only to find writers' ready PRs; the human's open PRs are thrown away |
| Repo identity | `contracts/projects.rs:238` `short_remote` → `host/owner/name` | A key that works on any host | The train and PR views key on `GitHubRepo` |
| Human access | Hub MCP over HTTP with an agent key (`docs/.../mcp-clients.md`); CLI `--key-file` | Claude Code sessions already reach the hub | The hub's MCP `initialize` (`hub/mcp/mod.rs:269`) sends no `instructions`, so a session is never told to check |
| "ledger" | `hub/ledger/` | — | **The name is taken** (the decision log). Call the new area `hub/work`. |

## 2. The model

### 2.1 Work in flight: one view over four sources

`Work::in_flight(scope)` returns `WorkItem`s. Its scope is **(repo key, base branch)**, not a project: two projects or
fleets on the same repo see each other, and the lab's `slot/N/main` namespaces don't. Each source becomes one kind of
item:

| Source | Kind | Id | Title | Exact keys | Paths | State comes from |
|---|---|---|---|---|---|---|
| Write task Queued/Running/Idle | `task` | `T12` | task title | item, branch, issue refs and PR URLs parsed from the title and prompt | the writer's observed Changes, plus paths named in the prompt | the task |
| Change not merged or abandoned | `change` | `X4` | PR title | PR, branch, `task_id` | PR files (already cached by `prs/github.rs`) | the Change |
| Open PR that isn't fleetd's (GitHub; §4.3 for others) | `pr` | `owner/repo#57` | PR title | PR, branch, issue refs in the body | PR files, read lazily for strong text matches only | the remote |
| Claim (new table) | `claim` | `C7` | claim title | declared keys, branch | declared and observed paths | the claim's own state (§3) |
| Open plan item with no live task | `planned` | `P5` | item title | item | none | the plan; **weak only**, never blocks |

A writer task appears once: its Change takes over when the PR is enqueued.

### 2.2 Claims (new rows)

A claim is for intent fleetd can't otherwise see: a human session, or a lead holding something in reserve. It is
**a free-text intent plus optional exact keys and paths**, not one of those alone:

```
Claim {
  claimId: "C<n>", repoKey: "github.com/acme/shop", base: "main", projectRef?,  // projectRef when it maps to one
  owner: { kind: human_session | agent_key | lead, keyId, label },          // label: "laptop", the git user.email
  title: Line<1,120>,                                                        // "dark mode toggle in settings"
  keys: [ {issue:"#123"|"ABC-123"|url} | {item:"P5"} | {pr:url} | {branch:"ada-lovelace/dark-mode"} ],
  paths: [ "app/theme.ts", "app/settings/**" ],                              // declared; ≤ 50
  observed: { paths, headSha, at }?,                                         // refreshed from the remote branch or the CLI
  authorEmail?,                                                              // from `git config user.email`, for matching direct pushes
  state: active | landed | released | expired,
  end?: { at, reason, landing?: sha },
  createdAt, renewedAt, expiresAt
}
```

Tasks are not copied into claims. They are already the source of truth, and a second copy would drift.

### 2.3 Landings (new rows)

A landing is every commit on the first-parent line of a watched base, whoever made it. This is also the denominator
for W9 part 7 ("share of merged work that went through fleetd"), so build it once and build it right:

```
Landing { repoKey, base, sha, at, route: train | pr_outside | direct_push,
          pr?: number|url, headBranch?, subject, authorEmail, paths (≤200), patchId?,
          changeId?, taskId?, claimIds[], itemIds[] }
```

## 3. Matching a new intent

`work::matcher` is a pure function `match(intent, candidates) -> Vec<Match{ id, kind, strength, why }>`.
It's deterministic and explains every result ("3 shared words: dark, mode, toggle; same file app/theme.ts").

**Intent** = title, plus exact keys parsed from the title and prompt (`#123`, `ABC-123`, PR URLs, `P5`), plus paths
named in the prompt (tokens that look like paths and exist in the tree are kept as given; the hub can't stat them),
plus the optional new `paths` field.

**Text:** lowercase; split on anything that isn't a letter or digit; drop the conventional-commit type (`feat`,
`fix(hub):` keeps `hub`); drop a short stop list (articles, `add`, `update`, `fix`, `make`, `support`, `use`, …) and
tokens under 3 characters. Score = shared tokens / the smaller set (overlap coefficient). Titles only: whole prompts
add noise.

| Strength | Rule | Effect on `spawn_agent` | Effect on `work_claim` |
|---|---|---|---|
| **exact** | Same item (held by another *owner*, so a lead's own split item is fine), same issue key, same PR, same branch | Refused: `taken`, fix "message T12, or stop it first" | Refused: "taken by T12 (lead's agent)"; `--anyway` records it with a link |
| **strong** | (score ≥ 0.6 and ≥ 3 shared) **or** (score ≥ 0.4, ≥ 2 shared and ≥ 1 same file), against a live item or a landing from the last 14 days | Refused once: `possible_duplicate`; the same call with `notDuplicateOf: ["C7"]` and a reason goes through, and the override is logged | Claimed, and the answer lists the match first |
| **weak** | ≥ 2 shared words, or any same file | Goes through; the result lists up to 3 | Listed |

Why no false positives block work: only exact ids refuse outright, and those are ids someone chose on purpose.
Everything fuzzy costs at most one repeated call with a reason, and that reason is useful in the log.

**Calibrating it:** a unit test runs the matcher over a frozen fixture of fleetd's own last ~500 commit subjects
against each other. Distinct merged PRs must almost never pair as strong. A second fixture holds known duplicates
(revert/redo pairs, batch PR titles), which must. The thresholds are tuned on these, not guessed.

## 4. How claims end, and how outside merges are seen

### 4.1 Endings

| Item | Landed | Released | Expired |
|---|---|---|---|
| task / change | Its Change merged by the train (as today); or a landing whose `headBranch` is the task's branch; or whose `patchId` equals its Change's | task cancelled or failed without a PR; Change abandoned; order closed or stopped (existing `close_order`) | — (a dead agent is W9 part 6) |
| claim | A landing with one of its exact keys (branch, PR, issue key in the message); or, for direct pushes, a landing by the claim's `authorEmail` that strongly matches it; or `work done` | `work drop`; the owner key is revoked | No renewal for **12 h**. Renewals: any `work_*` call from the owner, a push to its branch, a landing by its author touching its paths. Kept as weak for 24 h after, then hidden. |
| open plan item | **New:** exact match → done automatically with evidence "abc1234 landed outside fleetd" (route kept). Strong match → the lead is told, and marks it with `plan` `covered` (§5.2). | dropped (as today) | — |
| outside open PR | It merges (becomes a landing) or closes | — | — |

### 4.2 The landing scanner (`hub/work/landings.rs`), generic git

For each watched (repo key, base): every project's default branch, plus each train's guarded bases.

1. Every 60 s, if the node is online: `git ls-remote origin refs/heads/<base>` in the project's root (`link::commands`
   with `cwd` = `workspace_root`, which is already a command root). Same sha as last time → done.
2. Moved: `git fetch --no-tags origin <base>`, then
   `git log --first-parent --diff-merges=first-parent --name-only --format=%H%x1f%ct%x1f%ae%x1f%s%x1f%b%x1e <last>..origin/<base>`,
   capped at 200 commits. Merge commits stay in: for merge-style PRs they are the landing, and
   `--diff-merges=first-parent` gives their files. If `<last>` isn't an ancestor (force push, first run), take the commits since the watch
   started and don't report anything older. `git patch-id --stable` runs only for commits that might be a task's.
3. Route of each commit:
   - its sha is a Change's `merged_sha` → **train**;
   - its message names a PR → **pr_outside**. The patterns cover each host's default merge message: GitHub squash
     ends in `(#123)`, GitHub merge says `Merge pull request #123 from owner/branch`, GitLab says
     `See merge request group/proj!123`, Bitbucket says `Merged in branch (pull request #123)`, Gitea/Forgejo uses
     `(#123)`/`Merge pull request`. The head branch comes from the merge message when it names one;
   - otherwise **direct_push**.
4. GitHub only, and optional: `merged_pulls` (already read) fills in the PR URL and head branch for squash merges.
5. Write the landing; end the claims and tasks it matches exactly; auto-mark exact plan items; emit
   `work.landed` (route + subject + matches). Wake the lead **only for outside routes**, with one line per landing
   and its matches: "abc1234 'feat: dark mode toggle' pushed straight to main by ada-lovelace@…; covers P5, may cover T12".
6. While the node is offline, the watch waits. It never guesses; the next run's `git log` catches up.

`check_merged_outside` in the train stops sending its own wake line once landings are in (§7 PR 3), so the lead hears
about each merge once. The train's own abandon logic (`service.rs:978, 1142`, `batch.rs:151`) stays as it is.

Part 5 also needs a fresh `git fetch` of the default branch before each worktree. The two should share one per-repo
fetch: the scanner's fetch keeps `origin/<base>` fresh, and a worktree branched right after it costs no second fetch.

### 4.3 What each host needs

| Need | GitHub | Others |
|---|---|---|
| Landings and their route | git only (above) | git only: works for GitLab, Bitbucket, Gitea, bare SSH remotes |
| PR number for a squash with no marker in the message | `merged_pulls` via `gh` | Not available. The landing counts as `direct_push` unless the host's merge template names the MR. Say so in docs. |
| Humans' open PRs as in-flight items | `open_pulls` (already read) | An adapter per host: list open MRs (number, head branch, title, author, updated) and their files. GitLab `GET /projects/:id/merge_requests?state=opened` (or `glab mr list -F json`), Bitbucket `/pullrequests?state=OPEN`, Gitea `/repos/{o}/{r}/pulls?state=open`. Token as a hub secret. **Not in this build.** |
| Fallback with no adapter | — | `git ls-remote --heads origin`: branches updated in the last 7 days that aren't the fleet's prefix become **weak** items titled by branch name |

## 5. Where it plugs in

### 5.1 `spawn_agent` (leads; this covers their agents)

In `Tasks::spawn`, after `check_spawn_item` and before `TaskRecords::create`: `work.check(scope, intent)` with the
lead's own items left out of the exact tier (splitting an item is fine).

- exact → `ErrorCode::Conflict` (new code `taken`, or reuse `invalid` with a clear message), fix: "message_agent T12"
  / "it landed as abc1234: mark P5 covered with `plan`";
- strong and not acknowledged in `notDuplicateOf` → `possible_duplicate`, with the match lines and the fix "call again
  with notDuplicateOf: [ids] if this is different work";
- else spawn. The result's existing `also writing:` line becomes `also writing:` (this project's writers) plus
  `elsewhere:` (weak matches, other projects on the repo, human claims, recent outside landings), ≤ 3 lines each.

`TaskSpawnCall` gets `paths?: [path] (≤50)` and `notDuplicateOf?: [id] (≤10)`, plus a `notDuplicateWhy?` line. The
writer's prompt (`tasks/render.rs`) gets the matching `elsewhere` lines and one rule: "If `origin/<base>` already does
this, stop and reply `already done: <sha>`." A writer is the last agent that can notice.

A landing that strongly matches a **running** task wakes the lead: "main now has abc1234 'feat: dark mode' by ada-lovelace;
it may cover T12 (running)". The lead decides whether to stop it. The hub never stops agents on a fuzzy match.

### 5.2 The lead's digest and prompt

- `leads/digest.rs` `DigestInput` gets `elsewhere: Option<Vec<String>>`, rendered after the train lines within
  `DIGEST_MAX_CHARS`: active human claims, open PRs that aren't fleetd's, outside landings since the last wake (the
  newest 5 for 24 h), and expired claims for a day. Each line gives who, the title, and what it may cover.
- `plan` gets `covered: [{ item, landing: sha }]`: the item is done with evidence "abc1234 landed outside fleetd".
  `progress::verified` stays train-only for **train evidence**; a `covered` item counts toward progress, with its
  route kept for metrics. That's open question 1.
- `lead.start.md` gets one line under "Running the work": "Before spawning, read Elsewhere. Work that landed outside
  fleetd: mark its items `covered`, don't rebuild it. Work a person has claimed is theirs: ask in chat before you
  touch it." `docs/.../what-agents-are-told.md` gets the same.

### 5.3 The human's own Claude Code sessions

The human has to actually call these, so they're shaped around what a Claude Code session already has.

- **MCP tools on the hub endpoint** (Claude Code already holds an operate key for chat):
  - `work_claim { repo | projectRef, base?, title, keys?, paths?, branch?, authorEmail? }` checks and claims in one
    call. The answer is `claimed C7` plus any matches, or `taken by T12 (lead's agent on the dark mode order)` with
    what to do. One call instead of check-then-claim, so it gets used.
  - `work_list { repo | projectRef }`: what's in flight, and what landed in the last 24 h, with the route of each.
  - `work_done { claimId, outcome: landed | dropped }`.
  - `repo` accepts any remote form (`short_remote`), so a session in a laptop clone with no `projectRef` still works.
- **Server `instructions`** in the hub MCP's `initialize` (`hub/mcp/mod.rs:269`), which Claude Code puts in the
  system prompt: "Before you start a code change in a repository fleetd manages, call `work_claim` with a one-line
  intent; if it's taken, tell the user before going on. Call `work_done` when it lands or you drop it."
- **CLI `fleetd work`** (`cli/work.rs`), for sessions without MCP and for hooks:
  `fleetd work claim "<intent>" [--issue #12] [--paths a,b]`, `fleetd work [list]`, `fleetd work done|drop [C7]`.
  It reads `git remote get-url origin`, the current branch, `user.email` and the changed paths (`merge-base` with
  `origin/<base>` plus uncommitted) **from the cwd**, so the human types only the intent. Every call refreshes the
  claim's observed paths. `--key-file` (or `FLEETD_KEY_FILE`) as for `chat`.
- **Optional hook** (open question 4): `fleetd work hook` adds a Claude Code `SessionStart` hook to the user's local
  settings, running `fleetd work list --brief`, so every session in the repo starts knowing what's in flight.
- **Passive backstop**, for a human who never calls anything: their open PRs (GitHub), their pushed branches (weak),
  and every push to main (landings) are still seen. That alone would have prevented the 9 duplicate agents.

### 5.4 The app

- The Agents tab (`screens/agents/model.ts`, `AgentsPane.tsx`) gets an **Elsewhere** group under the project's
  agents: human-session claims ("You · laptop · dark mode toggle · 2 h"), open PRs that aren't fleetd's, and expired
  claims dimmed. Read from `work_list`; refetched on `work.*` events, like `agents_list`.
- Outside landings reach the human through the lead's chat message (the lead wakes on them), not through a new screen.
- Status (part 7) reads `landings` for "share through fleetd". That's out of this design.

## 6. Modules to touch

| Area | Files |
|---|---|
| contracts | **new** `fleetd-contracts/src/work.rs` (ClaimId, Claim, ClaimOwner, WorkKey, WorkItem, WorkMatch, Landing, LandingRoute, tool inputs and outputs); `events.rs` (`work.claimed`, `work.ended`, `work.landed`); `lead_calls.rs` (`TaskSpawnCall.paths`, `notDuplicateOf`, `notDuplicateWhy`); `plan.rs` (`PlanCall` `covered`, evidence route); `mcp.rs` (error codes `taken`, `possible_duplicate` if new codes are chosen); then `fleetd-schema` regenerates the TS |
| hub | **new** `hub/work/{mod.rs, store.rs, matcher.rs, view.rs, landings.rs, tools.rs}`; `store/migrations.rs` (`work_claims`, `landings`, `landing_watch`); `serve/wire.rs` (build it and give `Work` to `Hub`, `TaskDeps`, leads); `tasks/mod.rs` (`spawn` check, `also_writing` → elsewhere), `tasks/render.rs` (writer prompt lines); `plan/mod.rs` + `plan/calls.rs` (`covered`, auto-done from exact landings); `status/progress.rs` (evidence wording); `leads/digest.rs`, `leads/wiring.rs`, `leads/events.rs` (Elsewhere, wakes on `work.landed`); `train/service.rs` (`check_merged_outside` stops waking; Changes give `merged_sha` to landings); `train/github.rs` (open PRs' title, author and body for the view: `OpenPull` today keeps only number, draft and head); `mcp/mod.rs` (`instructions`); `api/mod.rs` registry (work tools) |
| assets | `assets/prompts/lead.start.md`, the writer task prompt |
| cli | **new** `cli/work.rs`; `cli/mod.rs` dispatch and usage; `cli/agent_mcp.rs` (spawn_agent description mentions `notDuplicateOf`) |
| app | `app/desktop/src/renderer/screens/agents/{model.ts, AgentsPane.tsx}`, data layer query for `work_list`; generated contracts |
| docs | `reference/cli.md` (generated), `mcp-clients.md` (tools + instructions), `what-agents-are-told.md`, `merge-train.md` (landings replace "merged outside" wording), `glossary.md` (claim, landing); `site/` rebuild |
| lab | **new** `tests/lab/workLedger.ts` on the lab repo (not fleetd's code) |

## 7. Build plan

| # | PR | Size | Depends on | Notes |
|---|---|---|---|---|
| 1 | `feat(hub): the work ledger's claims and its in-flight view` — contracts `work.rs`, migrations, `hub/work/{store,view}`; the view over tasks, Changes and claims; expiry in the existing `sweep` | m | — | No callers yet |
| 2 | `feat(hub): the work matcher` — `hub/work/matcher.rs`, pure, with the commit-subject calibration fixtures | s | — | **Parallel with 1** (works on its own `Candidate` struct) |
| 3 | `feat(hub): every commit that lands on a base is recorded, however it got there` — `landings.rs`, the node git scan, route parsing, exact endings and auto-done items, `work.landed` wakes; the train's merged-outside wake retired | m | 1 | Parallel with 4, 5, 6 |
| 4 | `feat(hub): spawn_agent refuses work that's taken and asks again on a likely duplicate` — `Tasks::spawn` check, `TaskSpawnCall` fields, elsewhere lines, writer prompt rule | m | 1, 2 | Parallel with 3, 5, 6 |
| 5 | `feat: claim work from any Claude Code session` — MCP `work_claim/list/done`, server `instructions`, `fleetd work` CLI reading cwd git facts, docs | m | 1, 2 | Parallel with 3, 4, 6 |
| 6 | `feat(hub): the lead sees work elsewhere` — digest Elsewhere section, `plan covered`, lead prompt line, humans' open PRs (and remote branches, weak) in the view | m | 1 (3 for landing lines; can land first, without them) | Parallel with 3, 4, 5 |
| 7 | `feat(desktop): the Agents tab shows work elsewhere` | s | 5 | |
| 8 | `test(lab): two sessions reach for the same work on a project that isn't fleetd` — the lead's agent and a human CLI session claim the same work: the second sees it and stops; a direct push to the lab base is seen, its item covered, and no agent is spawned for it | s | 3, 4, 5, 6 | Proves done:0 for part 1 |

Waves: **{1, 2}** → **{3, 4, 5, 6}** → **{7, 8}**. 5 m + 3 s. A `SessionStart` hook (`fleetd work hook`, s) and a
GitLab MR adapter (m) can come later, if the open questions say so.

## 8. Open product questions (recommendation for each)

1. **Does work that landed outside fleetd count toward an order's progress?** Today it never does, by design
   (`verified`: "a bypass merge never counts"). **Rec: yes.** An exact match marks the item done; the lead marks a
   strong match `covered`. Evidence names the sha and the route, and part 7 still counts it as "not through fleetd".
   Leaving it open is what made the lead rebuild finished work.
2. **Should a strong fuzzy match refuse once, or only warn?** **Rec: refuse once, overridden by `notDuplicateOf` +
   a reason.** A warning in a spawn result arrives after the agent has already started; the incident was 9 agents.
   The override costs one call and leaves a reason in the log.
3. **Can a lead override a human's exact claim?** **Rec: no.** The lead asks in chat; a human's `--anyway` or `work
   drop` frees it. A human claim is the human's decision, and the lead's rules already put the human first.
4. **How do the human's sessions find out about claims: MCP instructions only, or also a `SessionStart` hook?**
   **Rec: instructions now; offer the hook (`fleetd work hook`, opt-in, written to the user's local settings, never
   committed) in a follow-up.** Instructions are free and reach every session with the MCP. The passive backstop
   catches the rest.
5. **How long does a human claim last?** **Rec: 12 h since the last renewal**, with pushes and commits by its author
   counting as renewals. Long enough for a work session; short enough that a forgotten claim stops blocking by the
   next day. Exact claims block only while active.
6. **How far back do landings count against new work?** **Rec: 14 days for strong, 24 h shown in the digest.**
7. **Other hosts' open MRs in v1?** **Rec: no.** Landings work everywhere with git alone; open MRs use GitHub now and
   weak remote branches elsewhere. Add a GitLab adapter when a real project needs it.
8. **Should `fleetd work` find a key on its own?** `chat` refuses to, because agents run as the same OS user.
   **Rec: keep `--key-file` / `FLEETD_KEY_FILE`, and make MCP the main human route,** since Claude Code already holds
   the key in its MCP config.
9. **What should the app call it?** **Rec: "Elsewhere" in the panel; "taken by …" and "landed outside fleetd" in
   text.** "Claim" stays an id prefix and a CLI verb, not a screen.

## 9. Risks

- **Scanner cost:** one `ls-remote` per watched base per minute, and a fetch only when the base moved. Cheap. The
  scan waits while the node is offline; nothing is guessed.
- **Matching titles across languages and styles:** the thresholds come from a fixture of real history, and only exact
  ids block outright. Expect to tune the stop list once the lab runs on a second project.
- **Auto-done from an exact landing could mark an item done that the push only half did.** That's limited to exact
  keys the human or lead chose (branch, PR, issue), and the evidence line says exactly what landed.
