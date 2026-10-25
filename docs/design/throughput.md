# W9 part 5: throughput defaults for any project

Status: design, partly built. This records intent when written; the code is the source of truth. Check `git log` for what has landed.

Read from origin/main at `efe10800` (#401). All paths are under `crates/fleetd/src/` unless stated.

## 0. What main does today, and why the last order ran slow

| Limit | Where | Today |
|---|---|---|
| Fleet cap | `hub/slots/mod.rs:21` `DEFAULT_CAP = 40` | Covers the whole fleet, not one machine. Saved to `slot_settings` only once someone sets it. The lab `m5Tasks.ts` sets it to 1, then puts it back to **40**, so a hub that ran that lab now has 40 saved. |
| Project max agents | `hub/slots/board.rs:150` `max_agents_of` | Falls back to the fleet cap. A value someone sets is saved to `slot_shares` and stays until someone changes it. Nothing tells anyone when it holds agents back, which is how **1 sat there for a day**. |
| Machine size | none | Nothing caps agents per machine. Two projects on one 8 GB laptop could each start 40. |
| #297 guard | `hub/link/guard.rs` | A yes/no check per machine: new agents wait while free disk is below `minFreeBytes` (10% of the volume or 20 GB) or the 1-minute load is above 2× the CPU count. Memory is reported (`mem_used_pct`, Linux only) and never checked. |
| Usage breaker | `hub/usage/state.rs:409` | Two limit hits within 10 min stop new turns on the machine until the reset claude named, a completed turn on the login, or (with no reset named) a check of one parked thread on a 1, 2, 5, 10, 15-minute backoff that gets through. The per-window `utilization` that `limits` reports is never used. |
| Open tasks | `hub/tasks/policy.rs:11` `MAX_OPEN_TASKS = 32` | A fixed limit per project. On a big server this, not the machine, becomes the cap. |

**Worktree base is stale, confirmed.** The hub asks the node for `DefaultBranch`, and `node/worktree.rs:172` `default_branch` returns the **local name** (`main`, from `refs/remotes/origin/HEAD`, or **the branch checked out at the root** when that ref is missing). `ensure` then runs `git worktree add -b <branch> <path> main`, so the worktree starts from **local `main`**. No `git fetch` exists anywhere in `node/`. That local `main` is also stored as `base_ref` and used by:
- `worktree::changes` (merge-base with local `main`). Once a writer rebases onto the real `origin/main`, its "changed files" include every upstream commit local `main` lacks. That is the **850 files**. `hub/tasks/mod.rs:1310` `also_writing` shows those lists to the lead at every spawn ("+845 more"). Under #387's rule "parts that edit the same file go to one writer", fake overlap like that pushes the lead to serialise.
- `worktree::remove`'s merged check, so merged branches stay behind longer.

`refs/remotes/origin/HEAD` is missing in any repo that was `git init`-ed and pushed rather than cloned, and it goes stale after a default branch is renamed. In both cases today's fallback picks the human's **current branch**, which may be a feature branch.

Read and review tasks get no worktree at all: `SessionWorkspace::Root` runs them in the human's own checkout. That is why this task's brief had to say "work from origin/main; the local checkout is stale".

**Policy file and areas.** The repo has no `.fleetd/`. Here is what still reads anything:
- `hub/policy.rs`: `Policies` (60 s cache) reads `.fleetd/policy.yaml` from the **working tree** of the project root (`node/sessions/mod.rs:2413` `read_file`). The docs say "commit it to the default branch", so they and the code disagree. Only `tools.allow/deny` and `branchPrefix` are decoded; `PolicyFile` ignores `areas` and `defaults` (`fleetd-contracts/src/tasks.rs:222`).
  - It is called at spawn (`hub/tasks/mod.rs:972`, which refuses a broken file), at launch for `branch_prefix` (`:346`), and per launch for tool rules (`hub/executor/mod.rs:180`).
  - If the file is missing you get the defaults. **Nothing serialises on it.**
- Areas: none left. `Task` still decodes a stored `areas` array (contract test `tasks.rs:278`), and `hub/time/project.rs:207` still maps old `lease*` span kinds. Both are read-only leftovers. No leases, no `out_of_area`.
- One real cost remains. The spawn-time `policies.get` makes a node round trip, so **a spawn while the node is briefly offline fails** instead of queueing "offline" the way `try_start` does.
- Docs are out of date: `glossary.md:97` says the file "sets the tasks' model".
- Labs write an **untracked** `.fleetd/policy.yaml` to set a `branchPrefix` per lab slot (`m7Train.ts:144`, `chatLead.ts:115`). They depend on the working-tree read.

So a project with no fleetd files is already at full speed as far as policy goes. The work in §3 is small.

## 1. Cap: sized to the machine, per node

### Formula (computed on the hub from facts the node reports)

```
cpus, mem_total, free, min_free     — from the node's heartbeat (NodeLoad)
reserve_cpu   = max(1, ceil(cpus / 8))
cpu_term      = max(1, cpus − reserve_cpu)
reserve_mem   = clamp(0.25 × mem_total, 4 GB, 16 GB)        # the human's own apps, the OS
mem_term      = max(1, floor((mem_total − reserve_mem) / mem_per_agent))   # mem_per_agent = 2 GB
auto_cap      = min(cpu_term, mem_term, 64)                  # 64: hard top for auto; a human can set more
disk_room     = max(0, floor((free − min_free) / disk_per_agent) − started_10m)   # disk_per_agent = 5 GB
machine_cap   = human's machine setting ?? auto_cap

room(project) = min( fleet_cap_set ? fleet_cap − running_fleet : ∞,
                     machine_cap − running_on_machine,
                     disk_room,
                     (project_max ?? machine_cap) − running_in_project )
```

- **CPU: one agent per logical CPU, minus a reserve.** Most of an agent's time goes to waiting on the model. Builds and tests come in bursts that rarely line up, and the #297 load clause (load > 2×CPUs) catches the times they do. Too many on CPU only slows things down; too many on memory causes failures, so memory is the stricter term.
- **Memory: 2 GB per agent.** That covers claude's process (a few hundred MB) plus tool children such as test runners, rustc and language servers. `node.json` `memPerAgentGb` can override it.
- **Disk: room for new agents, not a fixed cap.** `started_10m` counts agents on the machine that started in the last 10 minutes: their worktrees haven't grown yet, so they still count against the room. Without this, a machine just above the floor would start 8 agents at once and fill the disk. `node.json` `diskPerAgentGb` overrides the 5 GB. 5 GB is roughly a Rust worktree with sccache. A JS repo needs about 1–2 GB, so 5 GB is cautious there.
- **Unknown figures.** An older node that sends no `memTotalBytes` gets `mem_term = 4`, and `doctor` says to update it. An offline machine keeps its last auto cap; its tasks queue as "offline" anyway.
- **auto_cap only changes on hello.** CPU count and total memory are fixed, so the cap never flaps. Only `disk_room` moves, and the queue is re-checked when it grows.

### Examples

| Machine | cpu_term | mem_term | auto_cap | disk room (free) | Runs at once |
|---|---|---|---|---|---|
| MacBook Air, 8 CPU, 8 GB, 256 GB | 7 | (8−4)/2 = **2** | 2 | (60−25.6)/5 = 6 | **2** |
| MacBook Pro, 12 CPU, 18 GB, 512 GB | 10 | (18−4.5)/2 = **6** | 6 | (150−51)/5 = 19 | **6** |
| Linux laptop, 16 threads, 32 GB, 1 TB | 14 | (32−8)/2 = **12** | 12 | (400−100)/5 = 60 | **12** |
| Workstation, 32 threads, 128 GB | **28** | 56 | 28 | — | **28** |
| Big server, 64 threads, 256 GB, 2 TB | **56** | 120 | 56 | (1500−200)/5 = 260 | **56** |
| 128 threads, 512 GB | 112 | 248 | **64** (hard top) | — | **64** |
| Small VM, 2 vCPU, 4 GB, 40 GB | 1 | max(1, 0) = 1 | 1 | (25−20)/5 = 1 | **1** |

On the big server the login, not the box, will be the limit. See the rate-limit section below.

### How it fits with the other limits

Gates run in this order at every start (`hub/tasks/mod.rs:527` `try_start_inner`): offline → **usage** → **guard** → **slot board**. All four apply to new agents only; running agents always finish their turn.

- **#297 guard** (`hub/link/guard.rs`): unchanged. It stays as the live brake that stops new agents when free disk drops below the floor or load passes 2×CPUs, with its 10% margin so it doesn't flap.
  - Add one clause: memory in use ≥ 90% pauses new agents ("Paused new agents: memory 93% on mbp").
  - The board's `disk_room` adds a graded step before the floor: a machine with room for 2 starts 2, not 8.
  - The guard and `disk_room` always apply, even when the human sets the machine cap by hand.
- **The human's settings, three levels, all optional:**
  - *Fleet cap* (admin): the default becomes **unset**, meaning the sum of the machine caps. A value saved in `slot_settings` (set by a person, or the lab's 40) stays as an explicit cap, and the app shows it next to the auto total. Recommended in Q2.
  - *Machine cap* (new, Operate): **auto** by default. A number replaces `auto_cap` and may go above it, with a warning: "above the 6 this machine's 18 GB fits". Saved in a new table `slot_machine_caps`.
  - *Project max agents* (existing): unset means the machine's cap, no longer the fleet cap. A value someone sets is a ceiling. It can be set back to **auto**, which deletes the row.
  - The **nudge** covers the 1-for-a-day failure. A cap a person set (project, machine or fleet) may hold queued agents back for 10 minutes while the machine still has room under its auto cap. When that happens, raise one attention item: "Max agents 1 on fleetd is holding 3 agents back; builder-1 has room for 9. [Raise to auto]". Once per lowering. It reuses #214's "serial waits behind free capacity" signal.
- **Model rate limits.** These are per login and plan, and the machine can't see them, so they stay **out of the formula**. Run hot and brake on what the login reports:
  1. The existing breaker (two 429-class hits within 10 min, then pause until reset) stays.
  2. New **soft brake** in `hub/usage`: when any `limits` window reports `allowed_warning` or utilization ≥ 0.90, new agents on machines on that login wait. Running ones continue. It lifts below 0.85 or at `resetsAt`. Line: "Paused new agents: 5-hour limit 91% on builder-1, resets 14:00".
  3. Logins on an API key or gateway report no windows, so only the breaker applies to them.
  4. The human's own Claude Code sessions on the same login show up in the same utilization, so the brake allows for them.
- **Open tasks:** `MAX_OPEN_TASKS` becomes `max(32, 2 × the project's effective max)`, so a 56-agent server isn't held to 32.
- **Lead line:** "agents: 4 running of 6 (auto: memory 18 GB), 2 queued". The binding term is named, so a human can see why.

## 2. Worktree base: a fresh fetch of the remote's default branch

All of this is on the node (`node/worktree.rs`, `node/sessions/mod.rs` launch and `DefaultBranch`). The hub keeps sending `Worktree { base_ref: "main", branch }`. The node now treats `base_ref` as the *name* of the PR target and picks the start point itself. Old hubs keep working and need no contract change for the core fix.

1. **Remote**: `origin`; else the only remote; else none. See forks below.
2. **Default branch, found generically**:
   - Use `refs/remotes/<remote>/HEAD` while it is less than an hour old (the node notes when it last checked).
   - Otherwise run `git ls-remote --symref <remote> HEAD` (10 s timeout), parse `ref: refs/heads/X`, and cache the result with `git remote set-head <remote> X`.
   - This fixes repos that were init-ed and pushed, and renamed default branches. When `ls-remote` fails, use the cached `HEAD`.
   - Never use the root's current branch while a remote exists. (`repos.rs:81` at project add uses the same resolver.)
3. **Fetch**: `git fetch --no-tags <remote> +refs/heads/X:refs/remotes/<remote>/X` from the root.
   - Timeout 20 s. It has to fit inside the hub's 60 s `LAUNCH_TIMEOUT`, together with `worktree add`.
   - Set `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`. Set `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"` only when the user has set neither `GIT_SSH_COMMAND` nor `core.sshCommand`.
   - One fetch at a time per project root, and a fetch less than 30 s old is reused, so a lead spawning 6 writers fetches once. Retry once on "cannot lock ref" (the human's own fetch racing ours).
   - This touches only remote-tracking refs: never the human's local branches or working tree.
4. **Start point** = the SHA of `refs/remotes/<remote>/X`: `git worktree add --no-track -b <branch> <path> <sha>`.
   - Stored `base_ref` = `<remote>/X`, so `changes` and `remove` compare against the remote. The agent's own `git fetch` in its worktree updates the same shared ref.
   - A resumed or re-created worktree keeps its existing branch, as now.
5. **Prompt** (`assets/prompts/task.brief.write.md`): "Your worktree starts at origin/main `abc1234`. Start any extra PR branch from a fresh `git fetch` of origin/main." Today it says "from {{baseBranch}}", and an agent can read that as local `main`.

| Case | Behaviour |
|---|---|
| **Offline** (resolve, connect or timeout errors) | Start from the cached `<remote>/X`. The spawn result and the task line say "based on origin/main as of 10-24 18:02 (fetch failed: offline)". If there is no cached remote-tracking ref at all, fall back to the local branch named X, labelled the same way; if that doesn't exist either, fail the start: "can't reach origin and have no copy of origin/main". |
| **Auth failure** (`Authentication failed`, `Permission denied (publickey)`, `could not read Username`, 403) | Start from the cached ref, as offline. Also raise **one attention item per project**, which `doctor` shows too: "git can't fetch origin for <project>: <first line>. Agents start from origin/main as of …; their pushes will fail the same way. Fix: `gh auth login` or your SSH key." |
| **No remote** | Base = the local default branch: the name recorded at project add, else the root's `HEAD` branch, labelled "no remote: from local main". The write brief already makes pushing and PRs depend on a GitHub origin. |
| **Fork** (origin is a fork, an `upstream` remote exists) | Base and PRs stay on **origin**. That is where the human pushes and where the train has rights to merge (`hub/train/github.rs` default_branch is read through the GitHub API for the same repo). When `upstream/X` is ahead of `origin/X`, `doctor` warns: "your fork's main is 31 behind upstream; `gh repo sync`". Basing on upstream is an option for later (Q5). |

Read and review agents: Q4 recommends a detached worktree at the same fresh base, so they stop reading the human's checkout.

## 3. No policy file needed

Already true for throughput (§0). To make a project with no fleetd files a first-class case:
- **Spawn with the node offline must not fail on the policy read.** At spawn (`hub/tasks/mod.rs:972`), an `Offline` read moves on. The launch re-reads the file and still refuses a broken one, so no deny rule is ever dropped.
- **Docs:** `config-and-files.mdx#policy` should say "optional; read from the project's checkout on its machine", or whatever Q3 decides. `glossary.md:97`: drop "model". `approvals-and-secrets.md:66` is unchanged.
- **Keep** reading old `areas` and `defaults` keys and stored task `areas`; they cost nothing. Removing the old `QueueLease` span mapping is optional cleanup and not needed.
- **Lab, which is W9 done:0:** a non-fleetd repo with no `.fleetd/`, a local `main` 5 commits behind origin, and `origin/HEAD` unset. Assert that every writer's worktree starts at `origin/HEAD`'s SHA, that `also_writing` lists only the writer's own files, and that the machine's auto cap of agents run at once.

## 4. Modules to touch

- **node**:
  - `node/worktree.rs`: remote, default-branch resolver, `fetch_base`, start point for `ensure`.
  - `node/sessions/mod.rs`: launch, `DefaultBranch`, reads in a worktree.
  - `node/repos.rs`.
  - `node/load.rs`: `mem_total` (Linux `/proc/meminfo`, macOS `sysctl hw.memsize`), plus macOS memory used.
  - `node/config.rs`: `memPerAgentGb`, `diskPerAgentGb`.
- **contracts**:
  - `node_link.rs` `NodeLoad.memTotalBytes`.
  - `tasks.rs`: `SlotState.perMachine {machineId, cap, auto, why, running, diskRoom}`, `CapSetInput.machine {machineId, maxAgents | auto}`, project `maxAgents: auto`.
  - Optional `base` on `Launched`/Task.
  - Schema and generated TS.
- **hub slots and queue**:
  - `hub/slots/board.rs`: a machine dimension in `blocker`, `room`, `position` and `evaluate`, with reasons like "machine cap: 6 of 6 on mbp (memory)".
  - `hub/slots/mod.rs`: `observe_machine`, the `slot_machine_caps` table, `DEFAULT_CAP` becomes `Option`.
  - New pure module `hub/slots/sizing.rs` for the formula.
  - `hub/store/migrations.rs`.
  - `hub/link/server.rs` `observe_load` calls the board. `hub/link/guard.rs` gets the memory clause.
  - `hub/usage/state.rs` gets the soft brake.
  - `hub/tasks/{cap.rs,tools.rs,policy.rs,mod.rs}`.
  - `hub/attention` and `hub/time` for the nudge. `hub/doctor/checks.rs` for fetch-failing and fork-behind.
- **cli**:
  - `cli/project.rs`: `--max-agents auto`.
  - `cli/setup/machine.rs`: `fleetd machine set <m> --max-agents <n>|auto`.
  - `cli/status.rs`: the cap and its source.
- **app settings**:
  - `app/desktop/src/renderer/screens/settings/{Agents.tsx,agentsModel.ts}`: a per-machine row with the auto value and why, an override slider and an Auto button; fleet cap "no limit"; the project slider's top is the machine cap.
  - `screens/projects/machineText.ts`, `src/data/queries.ts`.

## 5. Build plan (PRs)

| PR | Size | What | Depends on |
|---|---|---|---|
| **A** fresh base | m | §2 steps 1–4 on the node, plus the prompt line. Tests use a bare repo as origin: stale local main, unset or renamed HEAD, offline (remote path gone), no remote. | — |
| **B** base surfaced | s | `Launched.base {ref, sha, fetchedAt, error?}` (optional), the task and spawn line, the attention item and doctor check for fetch failures, the fork-behind doctor warning. | A |
| **C** readers off the checkout | m | Read and review tasks run in a detached worktree at the fresh base, removed at end (Q4). | A |
| **D** node reports memory | s | `memTotalBytes` and macOS memory; `memPerAgentGb` and `diskPerAgentGb` in node.json. | — |
| **E** machine cap in the board | m | `sizing.rs`, the board's machine dimension and `disk_room`, `observe_machine`, migration, fleet cap unset by default, project max defaults to the machine cap, `SlotState.perMachine`, `MAX_OPEN_TASKS` scaling, the lead line. | D's field (may be built at the same time; reads it as `Option`) |
| **F** machine cap setting | s | `cap_set.machine` and `auto` for a project; `fleetd machine set`, `fleetd project set --max-agents auto`, `fleetd status`. | E |
| **G** app settings | m | Settings › Agents per-machine rows, Auto, wording. | E's contract, F's tool shape |
| **H** brakes | s | Guard memory clause; usage soft brake on window utilization. | — |
| **I** nudge | s | The attention item when a cap someone set holds queued agents behind free room. | E |
| **J** policy optional | s | Spawn doesn't fail on an offline policy read; docs fixed. | — |
| **K** lab | m | §3's lab on a non-fleetd repo: fresh base, no `.fleetd/`, N at once. | A, E |

**In parallel from the start:** A, D, E, H, J. Then B and C after A; F and I after E; G after E and F; K last. A and J alone fix the two failures that hurt most (the stale base and the fake overlap); E/F/G/I fix the cap.

## 6. Open questions, each with a recommendation

1. **Keep the hard top of 64 for auto?** *Yes.* Past that, the login limit binds anyway, and the human can set a number above it.
2. **What to do on upgrade with a stored fleet cap of 40** (from the lab or a person)? *Keep it*: it's explicit, and fleetd can't tell who set it. Show "fleet cap 40 (set) · machines fit 62", and the nudge (I) fires if it holds agents back. Change `m5Tasks.ts` to restore *unset*, not 40.
3. **Where should `.fleetd/policy.yaml` be read from:** the working tree (today, which labs rely on), or `origin/<default>` as the docs say? *Keep the working tree, and fix the docs to match.* The file is optional and no longer affects throughput. Reading it from the remote would break the per-slot `branchPrefix` labs. A later step could move `branchPrefix` and tool rules into project settings in the hub, keeping the file as an override.
4. **Should read and review tasks get a worktree too** (PR C)? *Yes*: they read stale or uncommitted code from the human's checkout today, and this task's brief had to work around it. It costs one checkout per read; it is removed at the end and no build is needed.
5. **Forks: base on upstream?** *No for v1.* Base and PRs stay on origin, where the train can merge, and `doctor` warns when the fork is behind. Add an optional per-project `baseRemote` later if someone asks for upstream contribution.
6. **On an auth failure, start writers or hold them?** *Start them*, from the cached ref, with one attention item. The work is useful and pushes fail loudly. Holding would just add a silent stall back.
7. **Disk per agent: fixed at 5 GB, or learned?** *Fixed with a `node.json` override for v1.* Later, the node can measure each project's worktree footprint (median size at removal, which #297 already does) and report it.
8. **Should the soft brake's threshold be configurable?** *No for v1.* 0.90 to pause and 0.85 to lift, both visible in the paused line. Revisit if subscriptions shared with the human's own sessions brake too early.
