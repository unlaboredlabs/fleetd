# Head-to-head speed bench

The question: on complicated, multi-part work, how much faster does fleetd finish than a single agent harness, at
the same quality? `scripts/bench-vs` runs one contender on one task and measures it the same way every time.

## Contenders

| Contender | What runs | Done when |
|---|---|---|
| `claude-p` | One `claude -p` session in the clone, with its own subagents allowed. The honest baseline. | The process exits. |
| `fleetd` | A lab hub and one node on a lab slot, the project added, the task sent once as the person's chat message, the project's max agents set (default 40, the fleet cap). | The lead's orders are done, every PR it opened is merged into the run branch, nothing is running, and that holds for 90 s. |
| `t3` | One T3 Code thread, run by whoever drives T3 Code. The script prepares the clone and prints the task. | The thread says it is finished; the driver reports the wall time. |

`reference` copies a known-good solution over the clone. It costs nothing and exists to test the harness and the
hidden checks.

## Controls

Every contender runs under the same conditions. A run that breaks one is reported but does not count.

- **One model, one effort.** Every call is `claude-opus-5-5` at effort `high`: main loops, subagents, leads, workers,
  reviewers, compaction and background helpers. It is pinned three ways: the flags (`--model`, `--effort`), the
  settings (`model`, `effortLevel`), and claude's model environment variables (the opus, sonnet, haiku and fable
  aliases, the small fast model, the forced subagent model, the effort level; fast mode off). fleetd's node and hub
  also get a `claude` shim on their PATH that rewrites any print-mode call to the pinned model and effort, and logs
  what fleetd asked for.
- **Verified per request.** Each run's claude calls go through a local logging proxy in front of the user's endpoint,
  which records the model and effort of every API request, including helper calls that never reach a session file.
  The session files are checked too: claude records `model`, `requestedModel` and `effort` on every assistant
  message. Anything else, such as a haiku helper call, sets `valid: false` and the run does not count. A T3 run is
  checked from its session files only.
- **The same claude setup.** Each contender gets its own HOME under `/tmp/fleetd-bench` with a copy of the user's
  `~/.claude` setup: their settings (hooks, env, login), `CLAUDE.md` and user MCP servers. The real `~/.claude` is
  only read. The result records which hooks, MCP servers and plugins were active, by name.
- **The same CLI and machine.** The claude CLI version is recorded per run. Runs happen on one machine.
- **The same start.** A fresh clone of the task's frozen base, the same task text, and no human input after it.
- **The same verdict.** The same hidden checks and the same blind, blocker-only review (also pinned).
- **Load.** The load average and the number of running claude processes are recorded at the start and end of each
  run. A run on a machine loaded above half its cores is flagged `busy`; compare busy runs with care.

## Tasks

Each task sits on a frozen snapshot of a real codebase, on the lab repo's branch `bench/<task>/base`. Its text is in
`tests/lab/bench/tasks/<task>/task.md`, identical for every contender. Its acceptance checks are hidden: they live in
`~/src/fleetd-lab/bench/checks/<task>/` (`FLEETD_BENCH_HOME`), outside every repo, and are never pushed or copied into
a contender's tree. **Pass** means every hidden check is green and the blind review found zero blockers.

| Task | Kind | Codebase |
|---|---|---|
| `tinyhttp-six` | A spec of six independent parts: four new packages, a cookie option, `app.param` | tinyhttp (MIT) |
| `smoke` | One file, one PR: tests the harness, not measured | tinyhttp (MIT) |

## Running

Once: `npm ci --prefix tests/lab`, a release build of fleetd for the fleetd contender (`cargo build --release -p
fleetd`, or `FLEETD_BIN=<path>`), the `gh` login, and the hidden checks in `~/src/fleetd-lab/bench/checks`.

```sh
scripts/bench-vs --list
scripts/bench-vs --task tinyhttp-six --contender claude-p
scripts/bench-vs --task tinyhttp-six --contender fleetd --slot 9
scripts/bench-vs --task tinyhttp-six --contender reference --no-review   # the harness itself
```

The fleetd contender takes a lab slot: the slot's local lock and its GitHub lease (`lease/slot/<n>`), and its ports.
It copies the base to a run branch, `bench/<task>/run-<time>/main`, and its PRs merge there through the merge train,
with the snapshot's own CI. The base never moves.

**T3 Code.** `scripts/bench-vs --task <task> --contender t3` prepares the clone and prints its directory and the task
text. Start one T3 Code thread in that directory with Claude, `claude-opus-5-5` at effort high, and send the text as
its first message. When the thread says it is finished, record the result with the wall time from sending the message
to that reply, and the thread's claude session files:

```sh
scripts/bench-vs --finish /tmp/fleetd-bench/<run> --wall-sec <seconds> --usage <dir with the thread's session JSONL>
```

## Metrics

One JSON file per run in `~/src/fleetd-lab/bench/results/<task>-<contender>-<time>.json`; session files, the request
log, the chat and the result's patch are archived in `~/src/fleetd-lab/bench/runs/<run>/`.

- `wallMs`: from sending the task to the contender being done. `wallToGreenMs` is the same when the run passed, and
  `null` when it did not.
- `pass`, with `checks` (each hidden check) and `review` (the blockers, if any).
- `humanFree`: the contender finished by itself, without a timeout or a stop to wait for a person.
- `usage`: tokens per model from every session file of the run (a message counts once), and their API-equivalent
  dollars at list prices. `agents`: claude sessions for `claude-p` (the main one plus each subagent), tasks plus the
  lead for fleetd.
- `pinning`: requests and messages by model and effort, and any violation. `valid` is false when there is one.
- `env`: the claude version, the active setup, and the load at start and end.
- fleetd only, in `extra`: tasks by kind, the PRs, the workstreams, what fleetd asked for before the shim pinned it,
  and the time inspector's breakdown for the project, the lead and each order (categories, critical path, top
  commands, CI checks).

## Results

Times are wall-clock minutes from sending the task to done. Only valid runs count.

| Task | Contender | Wall (min) | Pass | Human-free | Agents | Tokens | API $ | Pinning | Load | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
