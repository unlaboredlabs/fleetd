# S0 substrate spike: results

**Question:** can fleetd drive stock, pinned T3 entirely from outside, as an ordinary WebSocket client?
**T3 pin:** `2fbd4318fc` (same as `vendor/t3/PIN`), unmodified, run from source (`node apps/server/src/bin.ts serve`).
**Lab:** `lab/up.sh` / `lab/down.sh` (logic in `lab/lab.mjs`) start `lab-a` (:4711) and `lab-b` (:4712) with homes
`~/src/fleetd-lab/home-a|b`, their own `CLAUDE_CONFIG_DIR` (`claude-a|b`), test repos `repo-a|b`, a scrubbed env,
and PIDs in `~/src/fleetd-lab/pids/`. Both seed a `fleetd` Claude instance; lab-a's has
`launchArgs: --disallowedTools mcp__t3-code__delegate_task`, lab-b's has none (the control).
**Client:** `spikes/s0/src/main.ts`, built **only from the vendored slice** (`@t3tools/contracts` and
`@t3tools/client-runtime/rpc` under `vendor/t3/`), not from the lab's checkout. The slice was enough: the spike
needed `WsRpcGroup` plus effect's `RpcClient`/`Socket`, and the `rpc/http` helpers for the ws-ticket exchange.
**Claude cost:** 8 turns in total, all `claude-haiku-5-5`, each one line or one shell command.

Run: `lab/up.sh && node spikes/s0/src/main.ts [ttl a d c e g h h2] ; lab/down.sh`. Evidence JSON goes to
`~/src/fleetd-lab/s0-evidence/` (not committed).

## Claims

| Claim (16 §1.1 / DESIGN §3.2) | Result | Evidence (from the run) |
|---|---|---|
| Locally minted session works (`t3 auth session issue`) | **PASS** | `auth session issue --base-dir <home> --ttl 3650d --token-only` → 16 standard scopes, `expiresAt 2036-10-14`. The bearer gets a ws ticket from `POST /api/auth/websocket-ticket`, then `/ws?wsTicket=…&orchestrationProtocol=2` connects and `server.getConfig` answers. `auth session revoke` works. |
| a. Project create + `launchThread` with explicit model/effort, `runtimeMode: full-access`, over WS | **PASS** | `projects.mutate project.create`, then `orchestration.launchThread` with `{instanceId: fleetd, model: claude-haiku-5-5, options: [effort=high]}`. Shell shows `runtimeMode=full-access`, run #1 `completed`, 0 approval requests. The spawned CLI got `--permission-mode bypassPermissions`. ws.ts passes `input.runtimeMode` straight into `ThreadMessageIntake.launchThread` (`apps/server/src/ws.ts:1944`). The runtime-mode ceiling (`rtc`) exists only on MCP OAuth sessions (`EnvironmentAuth.ts:1271,1291`); CLI-issued sessions have none. |
| b. `subscribeThread` / `subscribeShell` with `afterSequence`, resumed after a reconnect, no gaps | **PASS** | The socket was dropped mid-turn for 4007 ms, then resubscribed with the last cursor (thread 31, shell 29). Compared with a subscriber that never disconnected: thread events 22-51, resumed client missing 0 (32-51 replayed as events, no fallback snapshot); shell 8 items, missing 0. Server rule: replay `(after, highWater]` unless it exceeds the replay budget, then send a snapshot (`ThreadStream.ts decideThreadResume`). |
| c1. `message.dispatch` wakes an idle thread | **PASS** | Idle thread → `message.dispatch` (`deliveryIntent: auto`, `dispatchMode: start_immediately`) → run #2 `completed`, reply `OK`. The run kept the thread's `effort=high` without resending `modelSelection`. |
| c2. `run.interrupt` stops a running turn | **PASS** | During `sleep 45`: `run.interrupt` → run #3 `running → interrupted` in 1262 ms. `sleep 45` processes under the server: 2 before, 0 after. |
| d. `command_execution` items carry `exitCode` | **PARTIAL** | **The Claude adapter never sets `exitCode`** (no occurrence in `ClaudeAdapterV2.ts`; only T3's own "Preparing workspace" item has `exitCode: 0`). Projection: `echo hi` `status=completed`; `false` `status=failed`, `outputIndicatesFailure=true`. With `getTurnItem`: `echo hi` output `"hi"`, `false` output `"Error: Exit code 1"` (and no `outputIndicatesFailure`). Success or failure is readable; the numeric code only by parsing the output text. |
| e. Per-instance `launchArgs` reach the `claude` CLI and hide `delegate_task` | **PASS** | lab-a CLI argv: `--disallowedTools mcp__t3-code__delegate_task`, alongside T3's own `--allowedTools mcp__t3-code__*`; the deny wins. The agent listed 82 `mcp__t3-code__*` tools without `delegate_task`. Control (lab-b, no launchArgs): no `--disallowedTools` in argv, and the agent listed `mcp__t3-code__delegate_task`. |
| f. The effort sent is the effort the spawned run uses | **PASS** | Sent `effort=high` → CLI argv `--effort high --model claude-haiku-5-5` (read from `/proc/<pid>/cmdline` of the server's child), and `run.modelSelection.options = [effort=high]`. lab-b runs sent `low` and recorded `low`. |
| g. No direct `api/oauth/usage` probe with a separate `CLAUDE_CONFIG_DIR` and no `.credentials.json` | **PASS** | Both labs: 0 `*ResetCredit*` spans in `server.trace.ndjson` (3231 and 1452 spans) and 0 spans naming `api.anthropic.com`; no `.credentials.json` in `claude-a|b`. The instance reports auth `apiKey`, so usage is `unavailable: unsupported`. The probe is skipped twice over: it needs a `subscriptionType` (OAuth only, `ClaudeProvider.ts:639-645`) and the credentials file (`claudeResetCredits.ts:137-153`). Claude got its base URL and token from `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, read by `lab.mjs` from `~/.claude/settings.json` at start and passed only through the spawn env (never written to a file or argv). |
| h. Planned restart (SIGTERM) mid-turn: T3's continuation | **PASS** | During `sleep 20 && echo slept`, `lab.mjs restart lab-b`: run #1 → `cancelled`. After start, T3 queued run #2 with `restartContinuationOfRunId = run #1`, which **re-ran the command from scratch** (`completed`) and replied `DONE`. No user-visible message was added. The same bearer session kept working across the restart. |
| h2. Crash (SIGKILL) mid-turn, then start | **PASS** | Same result after `kill -9` of the recorded PID: run #1 `cancelled`, continuation run #2 `completed`, `DONE`. Kill plus restart took 4861 ms. The killed server's `claude`/`sleep` children did not survive as orphans (checked by `CLAUDE_CONFIG_DIR` in `/proc/*/environ`). |

## Session TTL

`t3 auth session issue --ttl` has **no maximum**. The default is 30 days (`SessionStore.ts:425`). `--ttl 1000000d`
was accepted (expiry in the year 4764), and verification only checks `exp`. So the policy belongs to `fleetd node`:
mint short sessions (for example 1 h), re-mint before expiry, and revoke on rotation. Sessions survive a T3 restart
because they live in the T3 database.

## Surprises

1. **No numeric exit codes from Claude** (d). Receipts must use `status` / `outputIndicatesFailure` and parse
   `Exit code N` from the output. `outputIndicatesFailure` shows up in the projection but not in `getTurnItem`.
   That is fine for fleetd, since checks that matter are `cmd` checks the node runs itself (DESIGN §2 Claim/Check).
2. **`delegate_task` is not the only spawn path.** Every Claude thread gets about 83 `mcp__t3-code__*` tools,
   including `t3_thread_launch`, `create_threads`, `t3_thread_fork`, `schedule_task`, `run_scheduled_task_now`,
   `t3_worktree_handoff` and `t3_thread_send`. Hiding only `delegate_task` leaves the slot board leaky.
3. **Continuation repeats work.** T3 does not resume the cancelled tool call: a new run re-executes it, so
   non-idempotent commands run twice. The original run ends `cancelled`, not `interrupted`.
4. **Graceful stop mid-turn is slow.** An idle SIGTERM exits in 251 ms. Mid-turn, the restart took 24.4 s against
   4.9 s for SIGKILL plus start. T3 logged "shutdown reconciliation completed" about 2 s after SIGTERM, then seemed
   to linger until the lab's 20 s SIGKILL fallback fired. That last part is inferred from timing; the old script
   did not report which signal ended it.
5. The **default `claudeAgent` instance stays registered** next to `fleetd`, and both are ready. fleetd must always
   pass `instanceId: fleetd`. With env-token auth T3 calls the account `apiKey` and shows no usage windows.
6. The server trace logs the full `/ws?wsTicket=…` URL. The ticket is short-lived (5 min), but trace files should
   count as sensitive.
7. `t3 serve` prints a one-time pairing token to stdout, so lab logs are not shareable as-is.

## Verdict

**Confirmed: fleetd can drive stock, pinned T3 from outside.** Every executor operation worked at runtime from a
client built only on the vendored slice:
- launch with full-access, an explicit model and effort;
- send/wake and interrupt;
- cursor-resumed shell and thread streams with no gaps;
- item reads;
- per-instance launch args;
- locally minted sessions;
- T3's own restart continuation, after both SIGTERM and SIGKILL.

The one real miss is cosmetic for the design: Claude command items carry pass/fail but no numeric exit code.

DESIGN §3.2 should change in four places:
1. **"Outside agents capped below full access"**: verified, not just claimed (the cap is MCP-OAuth only).
2. **Slot board**: the "fleetd" instance's `launchArgs` must deny every T3 spawn tool, not just `delegate_task`.
   The simplest version is `--disallowedTools mcp__t3-code__*`, since leads reach fleetd through the `fleetd` CLI.
   The wildcard deny is untested and should be checked in M1.
3. **Receipts**: exit status comes from item `status` plus the output text. Numeric exit codes come only from the
   node's own `cmd` checks.
4. **Restart**: continuation is automatic, but it re-runs the in-flight tool call, so drain before planned restarts
   matters more. The node can treat "restart dead T3" as just "start it again"; a crash loses nothing beyond what a
   graceful stop loses.
