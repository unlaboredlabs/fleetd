# W9 design (6): self-healing agents

Status: design, partly built. This records intent when written; the code is the source of truth. Check `git log` for what has landed.

Source: `origin/main` at `efe10800`. Evidence: the hub's and the node's own records and logs.

## 1. Why T18, T19 and T23 ended "failed"

### 1.1 What happened

None of the three died on its own. The **fleetd node service was stopped under them**. Each node stop then reached the tasks layer as a plain `thread.interrupted`, and `hub/tasks` turns every interrupt into `failed`.

In short: the node service on the agents' machine was stopped twice, and the machine powered off once; three agents died mid-run. Each time the node came back, its late `thread.interrupted` turned the task into `task.failed`, and the lead had to steer each one to continue by hand.

The code path:

1. **Node SIGTERM.** `node/mod.rs:246` calls `SessionService::shutdown` (`node/sessions/mod.rs:2583`). That sends an `Interrupt` to every active run, waits `SHUTDOWN_DRAIN` (10 s), then closes the processes. claude ends the turn as interrupted (`aborted_*`). `failure::classify` returns `None` for that (`node/runner/failure.rs:244-250`), so the run is `Interrupted`.
   - The build that was running recorded no cause. `RunOutcome::Interrupted => (Interrupted, asked.map(state::ended_by))` landed afterwards in #329 (`253e8e6f`).
   - On today's main the run would carry `failure {class: process_exited, message: "the node stopped"}`. A `stop_agent` cancel gets the same class, with message `"stopped"` (seq 905). So even now the cause is free text under a class that also means "a person cancelled it".
2. **A crash, SIGKILL or power loss** instead: on start, `SessionService::start` (`node/sessions/mod.rs:622-660`) kills recorded pids and calls `close_out(.., EndCause::NodeRestarted)` → `Interrupted`, "node restarted mid-run" (`node/sessions/state.rs:57-83`).
3. **Hub, while the node is gone.** The thread row still says running. The watchdog only looks at "threads … on machines with a live node link" (`hub/watchdog/mod.rs`, `WatchPort::running`). The sweep reports the machine once per offline spell (`hub/sweep/mod.rs:offline_machines`). Nothing else happens.
4. **Hub, when the node is back.** The snapshot diff yields `Transition { late: true }` (`hub/executor/shell_mapper.rs:210-215, 700-704`). `Tasks::on_thread_event` maps `ThreadFailed | ThreadInterrupted if live` to `finish(.., Failed, ..)` with no look at the cause (`hub/tasks/mod.rs:862-870`). `finish` wakes the lead with `- T23 failed: …` and the tail (`render::task_result_lines`, `leads/events.rs:153`).
5. **Recovery, today, is manual only.** The lead's message reaches the `_ =>` arm of `message`. That bumps `attempt` and runs `try_start` with the message as `pending_message`, which sends it into the same thread. The thread resumes with `--resume` in the same cwd (`hub/tasks/mod.rs:1083-1096`, `node/sessions/mod.rs:1344-1370`). That is exactly what this design automates.

### 1.2 Two bugs the data shows

- **(B1) A late event for an old run fails the task's new run (T19).** When the machine came back, `machine.online` fired `retry_when_live` → `retry_queue`. That continued T19, which was queued `paused` (by a max-agents pause just before the stop), as attempt 2 (seq 530). It did so **before** the follower had applied seq 528, the late `thread.interrupted` for the previous run `24cfc0d2`. Then 528 was applied to a task that was Running again, and the result was `task.failed` (532) while run `2244cb55` worked on and completed.
  - So the lead got a false "T19 failed".
  - `retry_later` calls `catch_up()` first, but `retry_when_live` doesn't (`hub/tasks/mod.rs:454-480`).
  - And `on_thread_event` never compares the event's `runId` with the run the task is on.
- **(B2) Node shutdown starts a queued send.** T19's run 2 (`24cfc0d2`, the "pause" message queued just before) started 6 ms after run 1 was interrupted for the shutdown. It then ran its 10 s drain and was cut. `shutdown` sets `st.stopping`, but a message already queued in the live process still starts.

Two smaller gaps:

- **(G1)** `worktree::ensure` recreates a missing worktree from the local branch, or else from `base_ref` (`node/worktree.rs:66-95`). If the local branch is gone but `origin/<branch>` has pushed commits, the new branch silently starts from the default branch.
- **(G2)** `Tasks::new` follows events from `events.head()` at hub start (`hub/tasks/mod.rs:218-229`). A terminal thread event appended but not applied before a hub crash is never applied, and its task stays Running forever.

### 1.3 Every way a run ends today, and what the task does

| Cause | Where it's decided | Run as the node records it | Task today |
|---|---|---|---|
| Node SIGTERM (`systemctl stop`, `fleetd update` restart, logout, shutdown) | `sessions/mod.rs:2583` | `interrupted`, "the node stopped" (since #329) | **failed** |
| Node crash, SIGKILL, power loss | `sessions/mod.rs:654` | `interrupted`, "node restarted mid-run" | **failed** |
| claude exits or is killed (OOM, signal) with nobody asking | `state::close_out(EndCause::Exited)` | `failed`, `process_exited`, "claude was killed by signal N…" | **failed** |
| Machine slept; stream lost | `recover_after_sleep` → Network | the node retries with `--resume`, 1/4/15 min | survives, or **failed** after 3 tries |
| 529/5xx, network | `failure::retryable` + `schedule_retry` (`sessions/mod.rs:1915`) | the node retries 3× ("Continue where you left off.") | survives, or **failed** |
| Usage or rate limit | `failure::decide` → UsageLimit/RateLimit | `failed`, reset time | parked (Idle); `hub/usage` sends `usage.continue` at the reset |
| No frames for 10 min (+ the tool's timeout) | `hub/watchdog` emits `thread.failed{reason:"stalled"}`, then interrupts | `interrupted` | **failed**, "[stalled] …" |
| Context full (`prompt_too_long`) | `decide` → InvalidRequest. `failure::context_full` exists but **nothing calls it** | `failed` | **failed** |
| Max turns or budget | fleetd passes no `--max-turns`, so not seen. It would be `Other` | `failed` | **failed** |
| Auth, pool exhausted, bad model | `decide` → Auth/PoolExhausted/InvalidRequest | `failed` | **failed** (machine degraded) |
| Max agents lowered | `tasks/cap.rs:pause_extras` → `task.pause`, queued with `task.resume` | `completed` | queued, then resumed (already self-healing) |
| Cancel, order stop | `Tasks::cancel` → stop("stopped") | `interrupted` | cancelled |
| Hub restart | executor rebuilds from node snapshots | — | fine, except G2 |

Every bold "failed" above is either infrastructure, or a loop risk with a real reason. Telling those two apart is the job.

## 2. Dead, slow, waiting or finished

These signals exist for any project. They come from the node link, the run record, the event stream and git. None depends on a test command, CI vendor or language.

| State | Signals | Action |
|---|---|---|
| **Finished** | `thread.completed` (claude's result, not an error) | `done`. Never recovered. The existing receipts and `claimsUnverified` flag a done that shows no evidence. |
| **Waiting on a person** | `thread.waiting` (a permission, approval or secret request), task `Idle`; the task is in `asking` (`ask_lead` open) | Never touched by recovery. The lead was already woken (`TaskWaiting`). |
| **Waiting on usage** | `thread.usage_limited` → `task.parked` | Untouched; `hub/usage` continues it. Doesn't count as a recovery. |
| **Waiting on the node's own retry** | The run is still active and has a `NodeRetry` item (`sessions/mod.rs:1990-2025`) | Untouched. |
| **Waiting on CI or the train** | Not an agent state. A writer pushes, opens a PR and ends its turn (`task.brief.write.md`): the task is `done` and the train owns it. `pr.fix` continues it later. An agent that watches checks itself (`gh pr checks --watch`) has an open tool, which is "slow" below. | — |
| **Slow** | The run is active; the last frame is within `STALL_MS` (10 min), or an open tool is within its stated timeout + 10 min (`watchdog::threshold_ms`) | Untouched. |
| **Unreachable** | Task Running, machine `offline` (no word for 45 s) | Keeps its slot. The lead is told once after 30 min; resumes when the node returns (§3). |
| **Dead** | The run ended without completing: (a) `interrupted` with a node cause (stopping, restarted); (b) `failed` with `process_exited`; (c) watchdog `stalled`; (d) `failed` for a reason that won't fix itself (auth, bad request, `Other`); (e) **orphan**: task Running, but the thread is not running, the machine is online and no event has come for 2 min (G2) | (a)-(c), (e): recover (§3). (d): escalate. |

Telling "dead because of the node" from "a person interrupted it" needs a structured cause, not message text. **New contract field:** `RunInfo.end: Option<RunEnd>` (in `fleetd-contracts/src/sessions.rs`), with `#[serde(other)] Unknown` so old hubs and new nodes interoperate:

```rust
#[serde(rename_all = "snake_case")]
pub enum RunEnd {
    Completed,
    Requested,      // interrupt/stop by someone: `RunInfo.ended_by` says who ("lead", "watchdog", "stopped", "cap")
    NodeStopping,   // node SIGTERM drain
    NodeRestarted,  // found active on node start: crash, SIGKILL, power loss
    MachineSlept,
    Exited,         // claude exited/killed with nobody asking (code/signal in failure)
    Failed,         // classified failure (class in failure)
    #[serde(other)] Unknown,
}
```

The hub copies it into `thread.*` event data as `endCause` (`shell_mapper::transition_event`).

**Fallback for nodes that don't send `end`** (like the node in §1.1): treat a run as node-lost when it is `interrupted` with no `superseded_by`, **and** either the event is `late: true` or the machine had an offline spell since the run started. Treat the message texts "the node stopped" and "node restarted mid-run" the same way. Both observed incidents pass this test.

## 3. Recovery policy

### 3.1 Where it lives

Recovery lives in the **hub**, in a new `hub/tasks/recovery.rs`: a pure `decide()` plus the wiring in `on_thread_event`. The node already owns API-level retries; it keeps them and only reports causes. The hub owns slots, max agents, attempts, the workstream state and the lead, so it decides. Lead threads are out of scope here (open question 5).

### 3.2 The decision

`decide(cause, task, history, facts, now) -> Action`. It is deterministic and needs no LLM, like the watchdog:

```text
Action = Resume { delay, note }        // same thread, same worktree, claude --resume
       | Fresh  { delay, handoff }     // new thread for the same task id, same worktree/branch
       | AwaitMachine                  // keep as is; resumes when the node returns
       | Escalate { why }              // finish(Failed) with a decision line for the lead
```

| Cause | First time | Again (same signature) | Counts toward budget |
|---|---|---|---|
| `NodeStopping`, `NodeRestarted`, legacy node-lost | **Resume** as soon as the node is live + 30 s settle (+0-10 s jitter) | Resume (a node going away is not the task's fault) | Yes, but the same-signature rule doesn't apply; the lifetime cap does |
| `Exited` by signal (9/15, OOM), or exit code ≠ 0 | Resume after 1 min | Escalate ("dies the same way twice") | Yes |
| `stalled` (watchdog) | Resume after 1 min, with a note naming the stuck tool | Escalate | Yes |
| `MachineSlept`, or Network/Overloaded after the node's 3 retries | Resume after 15 min | Resume after 60 min, then escalate | Yes |
| Context full (`prompt_too_long`) | Send `/compact`, then the resume note | **Fresh**, with a handoff | Yes |
| `Requested` by the lead, a person or cancel | — (not dead) | — | No |
| Auth, PoolExhausted, InvalidRequest (not context), `Other` (max turns, billing) | **Escalate** | — | — |
| Workspace missing and not recreatable; project removed | **Escalate** | — | — |
| Resume refused by the node (config dir changed, the session's `.jsonl` is gone) | **Fresh** | Escalate | Yes |

**Never recover** in these cases, but still finish with the plain result:

- the task was cancelled, or its workstream is not `Open` (order stopped or closed);
- the task's PR merged (`pr.merged` for its `taskId`) after the run was cut off (after the dead run started, for a death other than node-lost), or its plan item is done. A merge from before that is a PR the task went on past, like T514's first PR before the lead continued it for a second;
- the project's lead has an unanswered `ask_lead` from this task. Then deliver the answer when it comes, and the note with it.

When the lead (or a person) has already sent a message into the gap (`pending_message`), recovery only prepends the note to it. That avoids a double continue like S7 and S9.

### 3.3 Limits, backoff, no loops

- **Lifetime cap:** 3 automatic recoveries per task (`RECOVERY_MAX = 3`, with `FLEETD_RECOVERY_MAX` for the lab). The 4th death escalates.
- **Same signature twice in a row → escalate.** Signature = `(cause class, exit signal or code, the open or last tool's command head)`. One example: "killed by signal 9 while running `cargo test --workspace`", twice. That signals a real problem, such as OOM, a hanging test or a tool that kills claude.
- **Progress guard:** a recovery counts as productive if, by the next death, the run made at least 3 tool calls or ran 5 minutes, or the branch moved (new commits or a push, from the extended `changes`). A recovered run that dies unproductively counts double toward the cap. That stops a crash loop at the first tool.
- **Backoff** per the table: node-lost waits on liveness, not on time; the others take 1 → 15 → 60 min, ±10% jitter.
  - The delay is stored as `Task.recovery.next_at`. A `tokio` timer calls `retry_later` at that time, and a new sweep check runs `retry_queue` for any task past `next_at`, which covers a hub restart.
  - `retry_queue` skips tasks whose `next_at` is in the future.
- **Machine breaker:** if 3 or more tasks on one machine die `Exited` or `stalled` within 10 min, auto-recovery is paused there. The hub raises one `machine.recovery_paused` event (shown by doctor/status) and lead lines, and recovery goes on when a task on that machine completes or a person runs `fleetd doctor --fix`. This mirrors the usage breaker (`hub/usage/service.rs`). Node-lost causes never trip it.
- **Manual continue:** the lead's `send_message` to a failed task resets the same-signature counter, but not the lifetime cap. When the lead decides, the lead's call stands.
- **Slots:** a recovering task re-queues through the existing queue (`queue(stored, "recover", reason)`, like `pause_extras`), so max agents and the load and disk guard still apply. The queued reason reads, for example: "recovering: resumes when devbox is back (attempt 2 of 4)" or "recovering: resumes at 10:12 (attempt 3 of 4)".

### 3.4 Resume: same thread, same worktree (the default)

This is what the lead did by hand. Set `attempt + 1`, put the note in `pending_message` (plus any held steer, as now), then `try_start`. The node respawns claude with `--resume` in the same cwd.

The note is a new prompt-registry entry `task.recover` (`assets/prompts/task.recover.md`), so people can edit it like `task.resume`:

```text
fleetd: your run was cut off ({{cause}}) while you were {{doing}}. Your worktree is as you left it{{recreated}}.
Check `git status` and what you last ran, then continue where you stopped; rerun the step that was cut off.
(Automatic recovery {{attempt}} of {{max}}.)
```

- `{{cause}}` is plain words: "the node on devbox stopped", "claude was killed by signal 9", "no output for 20 min inside a tool".
- `{{doing}}` is the last action's summary from `ports.action_texts(thread, 1)`, falling back to the tail's headline. Both are generic for any project, for example "running the full fleetd and contracts suites".

### 3.5 Fresh: a new thread on the pushed branch

Fresh is used when resume can't work: context full after `/compact`, a resume refused, or a resume that failed twice the same way while the worktree is fine.

- **Same task id, new thread.** `Task.thread_ref` moves to the new one; the old one goes to `Task.previous_threads`. `TaskRecords::by_thread` looks at both, so late events for old threads are found and ignored (see B1).
- **Workspace,** in this order:
  1. The existing worktree, if it exists. Uncommitted work is kept.
  2. Else the worktree recreated on the local branch.
  3. Else on `origin/<branch>` (needs the G1 fix).
  4. Else, when nothing was ever pushed, from the remote's fresh default branch. That is the same base as a new task, per W9 part (5).
- **Prompt:** the original brief (`task.brief.*`) plus a `task.handoff` block. The block holds the previous attempt's last message tail (1500 chars), the commits on the branch (`git log base..HEAD --oneline`, max 20), uncommitted paths, and the PR URL if one is open. All of it comes from git and the thread, so it works for any project.

### 3.6 The worktree is gone

- **Read tasks** run in the project root; nothing to recreate.
- **Write tasks:** the node already recreates a removed worktree at the same path on resume (`sessions/mod.rs:1350-1364`), so `--resume` still finds its session (`claude_session_file` keys on cwd). Fix G1 so it recreates from `origin/<branch>` when the local branch is gone. The node also reports `recreatedFrom: "local" | "remote" | "base"` in the session summary, and the note then says "Your worktree was recreated from origin/<branch>; uncommitted changes from before are gone".
- **Project root gone, or the project removed** → escalate.

### 3.7 The machine stays away

The task keeps its slot and stays `Running`, shown in the app as unreachable. After 30 min offline, the lead gets one line per offline spell (§4); the sweep already tracks spells. Nothing moves to another machine (open question 4). When the node returns, the late end event flows through `decide` → Resume.

## 4. Telling the lead

The lead only needs a turn when it has something to decide.

- **New `LineKind::Recovery` lines are quiet.** They are rendered into the **next** wake and the digest, and never trigger a wake by themselves. That way an idle lead isn't spent on "nothing to do". The lead still sees them before it would act on that task.
- **Escalation lines wake** the lead like `TaskResult` today.
- All of them are also events (`task.recovering`, `task.recovered`, `task.escalated`), so the app's chat and Agents views can show them.

Wording, rendered in `leads/events.rs` (`Event::AgentRecovered`, `Event::AgentUnreachable`, and `AgentEnded` with a reason):

```text
- T23 resumed automatically (attempt 2 of 4): B: progress bar takes in-flight credit back [fleetd/T23-b-progress-bar-takes-in-flight-credit]
  > it died while running the full fleetd and contracts suites: the node on devbox stopped. Nothing pushed yet; the worktree is intact. Nothing for you to do.

- T41 restarted in a fresh thread (attempt 3 of 4): Design (6): self-healing agents
  > its context filled up twice; the new agent starts on branch fleetd/T41-… (2 commits) with a handoff of where it stopped.

- T23 waits for devbox, offline for 30 min (running, nothing pushed); it resumes on its own when devbox is back.
```

Escalation (wakes the lead):

```text
- T23 failed and was not resumed: B: progress bar takes in-flight credit back (branch fleetd/T23-…, 2 commits pushed, no PR)
  > it died the same way twice: claude was killed by signal 9 while running `cargo test --workspace` (likely out of memory on devbox).
  > Decide: continue it with instructions (send_message), split the work, or cancel it.
```

The digest's running line shows the state too:

```text
- T23 running (write, high): B: … [fleetd/T23-…]; recovered after node stop, attempt 2
```

That way a lead that only reads the digest never sends a second "continue".

**Escalate instead of resume** when any of these is true:

- the budget is used up;
- the same signature came twice;
- the cause is non-retryable (auth, a bad request, `Other`);
- the workspace is lost;
- the machine breaker is open.

Escalations for auth and the breaker also go to the human's attention (status, doctor), because the lead can't fix a login.

## 5. Modules to touch

| Area | Change |
|---|---|
| `fleetd-contracts/src/sessions.rs` | `RunEnd` + `RunInfo.end`, `RunInfo.ended_by`. `SessionChanges.ahead`, `.unpushed`, `.dirty` counts. `SessionSummary.recreated_from`. |
| `fleetd-contracts/src/tasks.rs` | `Task.recovery: Option<TaskRecovery { count, max, last_cause, last_cause_text, signature, next_at, mode }>`. `Task.previous_threads`. `Task.attempt_started_at`. `task.recovering` / `.recovered` / `.escalated` event types (`events.rs`). |
| `node/sessions/state.rs`, `node/sessions/mod.rs` | Set `end` in `close_out`, `run_ended`, `shutdown` and `start`. B2: don't start queued sends once `stopping`. |
| `node/worktree.rs` | G1: `ensure` checks `refs/remotes/origin/<branch>`. `changes` returns ahead/unpushed/dirty counts. |
| `hub/executor/shell_mapper.rs` | `endCause` in the `thread.*` event data. |
| `hub/tasks/mod.rs` | B1: `retry_when_live` runs `catch_up` first. `on_thread_event` ignores end events whose run ended before `attempt_started_at`, or that are not the current run. Recovery hooks into the `ThreadFailed \| ThreadInterrupted` arm. `retry_queue` honours `next_at`. |
| `hub/tasks/recovery.rs` (new) | Pure `decide()`, signature, progress guard, breaker state (rebuilt from events at start, like usage). |
| `hub/tasks/render.rs`, `hub/leads/events.rs`, `hub/leads/wakes.rs` | `AgentRecovered`, `AgentUnreachable`, quiet `LineKind::Recovery`, escalation wording, the digest suffix. |
| `hub/prompts/registry.rs`, `assets/prompts/task.recover.md`, `task.handoff.md` | New editable prompts. |
| `hub/sweep/mod.rs` | Checks: due recoveries (`next_at`), orphan reconcile (G2), the "unreachable 30 min" lead line. |
| `hub/watchdog/mod.rs` | None, beyond `reason:"stalled"`, which is already in the data. |
| `tests/lab/failure/` | New scenarios (§6, PR 8). |

## 6. Build plan

| # | PR | Size | Depends on | Parallel with |
|---|---|---|---|---|
| 1 | **hub tasks: stale end events never fail a newer run (B1).** `catch_up` in `retry_when_live`; `attempt_started_at` + a run check in `on_thread_event`. A fake-node regression test replays T19's seq 526-532. | s | — | 2, 3 |
| 2 | **contracts + node: structured run end cause.** `RunEnd`/`ended_by`; node sets it; `shell_mapper` forwards `endCause`; B2. | s | — | 1, 3 |
| 3 | **node worktree: recreate from the pushed branch, report git counts.** G1, `SessionChanges` counts, `recreated_from`. | s | — | 1, 2 |
| 4 | **hub tasks: automatic resume.** `recovery.rs` (`decide`, budget, signature, progress guard, backoff via `next_at` + timer), the `Task.recovery` contract, `task.recover` prompt, the queue path, events, stop conditions. Legacy node-lost fallback, so it works before PR 2 ships. | m | 1 (2 and 3 used if present) | — |
| 5 | **hub leads: tell the lead.** Quiet recovery lines, escalation wording, the digest suffix, `AgentUnreachable` from the sweep at 30 min. | s | 4 | 6, 7 |
| 6 | **hub tasks + node: fresh restart and context-full handling.** `previous_threads`, `by_thread` over them, `task.handoff`, `/compact`-then-resume, and fresh on a refused resume. | m | 4, 3 | 5, 7 |
| 7 | **hub sweep: orphans and the machine breaker.** G2 reconcile, `machine.recovery_paused`, doctor line. | s | 4 | 5, 6 |
| 8 | **lab: self-healing on a non-fleetd repo** (`labRepo`). (a) Node SIGTERM mid-task: a writer resumes, opens its PR, and the lead's next wake says "resumed automatically (attempt 2 of 4)". (b) SIGKILL: same. (c) The claude shim kills itself twice on the same command: escalates once, no third run. (d) Worktree and local branch deleted, branch pushed: recreated from origin. (e) T19's race: no false "failed". Builds on `failure/killMidTurn.ts` and `claudeShim.ts`. | m | 4, 5 (and 3, 6 for d) | — |

The critical path is 1 → 4 → 5 → 8. 1, 2 and 3 can start at once, and 5, 6 and 7 can run in parallel after 4.

PR 1 alone would have prevented the false T19 failure. PRs 1 + 4 alone would have recovered T18, T19 and T23 within about 30 s of their node coming back, with no lead message.

## 7. Open questions, each with a recommendation

1. **Should a recovery wake the lead?** Recommend **no**: it goes in the next wake and the digest, and only escalations wake. A wake per recovery spends lead turns on nothing to decide.
2. **Budget numbers:** 3 recoveries per task, same signature twice → escalate, 30-min unreachable notice. Recommend these as constants with lab env overrides, **no project setting** (W9 part 5: no policy file needed).
3. **A person stopping the node** (`systemctl --user stop`, `fleetd update`): resume when it's back, or treat it as an intent to pause? Recommend **resume**. Stopping work has its own verbs (`stop_agent`, order stop), and in this incident the lead resumed all three anyway. If `fleetd update --restart ask` (W8 C) knows a restart is coming, it can drain first; recovery covers the rest.
4. **Move a task to another machine when its machine stays offline?** Recommend **no**. The worktree, unpushed commits and the claude session are local. Tell the lead at 30 min; the lead can cancel and respawn elsewhere.
5. **Lead threads cut off by the same node stop:** same policy? Recommend a separate s follow-up: one "continue" to a lead thread interrupted with a node cause. #400's re-delivery of missed replies covers only the chat half.
6. **Should the node resume after its own restart?** It already has `RETRY_MESSAGE`. Recommend **no**. The hub owns slots, max agents, attempts and the lead, and a node-only retry would bypass the cap and the queue. The node reports `RunEnd`; the hub decides.
7. **Context full:** `/compact` first, or a fresh thread straight away? Recommend `/compact` once (it keeps the reasoning), then fresh with a handoff. This needs a lab check that `/compact` works as a stream-json user message on the pinned claude version. If it doesn't, go straight to fresh.
8. **A write task that "completed" with nothing pushed:** recover it? Recommend **no**. It finished by claude's account. Add "nothing pushed" to the result line (from PR 3's counts) so the lead can see it.
9. **Duplicates:** T23 was later cancelled as "Duplicate: B already merged in #261". Recovery should check the W9 (1) work ledger before resuming. Recommend: until the ledger lands, the "PR merged or plan item done" stop condition is enough; afterwards, add "claim superseded" to the stop conditions.
