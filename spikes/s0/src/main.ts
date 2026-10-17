// S0 substrate spike: drive two stock, pinned T3 lab servers from outside and check DESIGN §3.2's claims.
// Usage: node spikes/s0/src/main.ts <stage>...   stages: ttl a d c e g h h2   (default: all, in that order)
// Evidence JSON goes to $FLEETD_LAB/s0-evidence/<stage>.json. Bearer tokens are never printed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS as M,
  ProjectId,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  collect,
  descendants,
  LAB,
  LAB_A,
  LAB_B,
  type Lab,
  mintSession,
  openConnection,
  pidOf,
  sampleClaudeProcesses,
  scrubbedEnv,
  T3_SRC,
  type T3Client,
  waitUntil,
} from "./t3.ts";

const MODEL = "claude-haiku-5-5";
const EVIDENCE = path.join(LAB, "s0-evidence");
fs.mkdirSync(EVIDENCE, { recursive: true });

const results: Array<{ claim: string; verdict: "PASS" | "FAIL" | "PARTIAL"; evidence: string }> = [];
const verdict = (claim: string, ok: boolean | "partial", evidence: string) => {
  const v = ok === "partial" ? "PARTIAL" : ok ? "PASS" : "FAIL";
  results.push({ claim, verdict: v, evidence });
  console.log(`${v.padEnd(7)} ${claim}\n        ${evidence}`);
};
const save = (stage: string, data: unknown) =>
  fs.writeFileSync(path.join(EVIDENCE, `${stage}.json`), JSON.stringify(data, null, 2));
const id = () => crypto.randomUUID();
const statePath = path.join(EVIDENCE, "state.json");
const state: Record<string, string> = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : {};
const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

const projection = (client: T3Client, threadId: string) =>
  client[M.getThreadProjection]({ threadId: ThreadId.make(threadId) }).pipe(
    Effect.map((r): OrchestrationV2ThreadProjection => ("projection" in r ? r.projection : r) as never),
  );

const ensureProject = (client: T3Client, l: Lab) =>
  Effect.gen(function* () {
    const key = `${l.name}.projectId`;
    if (state[key]) return ProjectId.make(state[key]);
    const projectId = ProjectId.make(id());
    yield* client[WS_METHODS.projectsMutate]({
      type: "project.create",
      commandId: CommandId.make(id()),
      projectId,
      title: `s0 ${l.name}`,
      workspaceRoot: l.repo,
    });
    state[key] = projectId;
    saveState();
    return projectId;
  });

const launch = (client: T3Client, l: Lab, title: string, effort: string, text: string) =>
  Effect.gen(function* () {
    const projectId = yield* ensureProject(client, l);
    return yield* client[M.launchThread]({
      commandId: CommandId.make(id()),
      projectId,
      title,
      generateTitle: false,
      modelSelection: { instanceId: "fleetd", model: MODEL, options: [{ id: "effort", value: effort }] } as never,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text, attachments: [] },
    });
  });

const sendMessage = (client: T3Client, threadId: string, text: string) =>
  client[M.dispatchCommand]({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(id()),
    threadId: ThreadId.make(threadId),
    messageId: MessageId.make(id()),
    text,
    attachments: [],
    deliveryIntent: "auto",
    dispatchMode: { type: "start_immediately" },
  } as never);

const lastAssistantText = (p: OrchestrationV2ThreadProjection) =>
  p.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";

const runsSummary = (p: OrchestrationV2ThreadProjection) =>
  p.runs.map((r) => ({
    id: r.id,
    ordinal: r.ordinal,
    status: r.status,
    effort: (r.modelSelection.options ?? []).find((o) => o.id === "effort")?.value,
    restartContinuationOfRunId: r.restartContinuationOfRunId,
  }));

const terminal = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

const waitForRun = (client: T3Client, threadId: string, ordinal: number, timeoutMs = 180_000) =>
  Effect.gen(function* () {
    let last: OrchestrationV2ThreadProjection | undefined;
    yield* waitUntil(
      `thread ${threadId} run #${ordinal} terminal`,
      () => {
        const run = last?.runs.find((r) => r.ordinal === ordinal);
        return run !== undefined && terminal.has(run.status);
      },
      timeoutMs,
    ).pipe(
      Effect.raceFirst(
        Effect.forever(
          projection(client, threadId).pipe(
            Effect.tap((p) => Effect.sync(() => { last = p; })),
            Effect.andThen(Effect.sleep("1 second")),
          ),
        ),
      ),
    );
    return last!;
  });

const commandItems = (p: OrchestrationV2ThreadProjection) =>
  p.turnItems.flatMap((i) =>
    i.type === "command_execution"
      ? [{ id: i.id, runId: i.runId, input: i.input, status: i.status, exitCode: i.exitCode, outputIndicatesFailure: i.outputIndicatesFailure, output: i.output?.slice(0, 80) }]
      : [],
  );

const eventSeqs = (items: ReadonlyArray<OrchestrationV2ThreadStreamItem>) =>
  items.flatMap((i) => (i.kind === "event" || i.kind === "unknown-event" ? [i.sequence] : []));
const shellSeqs = (items: ReadonlyArray<OrchestrationV2ShellStreamItem>) =>
  items.flatMap((i) => ("sequence" in i ? [i.sequence] : []));

// ---------------------------------------------------------------------------------------------
// ttl: how long a locally minted bearer session may live, and that a long one actually works.
const stageTtl = Effect.gen(function* () {
  const issue = (ttl: string) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(T3_SRC, "apps/server/src/bin.ts"), "auth", "session", "issue", "--base-dir", LAB_A.home,
          "--ttl", ttl, "--label", "fleetd-s0-ttl", "--json"],
        { env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ),
    ) as { sessionId: string; token: string; expiresAt: string; scopes: string[] };
  const long = issue("3650d");
  const { client, close } = yield* openConnection(LAB_A, long.token);
  const cfg = yield* client[WS_METHODS.serverGetConfig]({});
  yield* close;
  execFileSync(process.execPath, [path.join(T3_SRC, "apps/server/src/bin.ts"), "auth", "session", "revoke",
    "--base-dir", LAB_A.home, long.sessionId], { env: scrubbedEnv(), stdio: "ignore" });
  const evidence = { requestedTtl: "3650d", expiresAt: long.expiresAt, scopes: long.scopes, connectedEnvironment: cfg.environment.environmentId };
  save("ttl", evidence);
  verdict("locally minted bearer session (t3 auth session issue)", true,
    `3650d session expiresAt=${long.expiresAt}, ${long.scopes.length} scopes, WS connect + server.getConfig OK, then revoked`);
});

// ---------------------------------------------------------------------------------------------
// a + b + d + e(lab-a) + f: launch with explicit selection and full-access; stream with a cursor across
// a reconnect; read command exit codes; check launch args and effort on the spawned CLI.
const PROMPT_A =
  "Use the Bash tool to run `echo hi`, then in a separate Bash call run `false`. " +
  "Then reply with exactly one line: the comma-separated names of every tool available to you whose name " +
  "starts with mcp__t3-code__ (write NONE if there are none). Do nothing else.";

const stageA = Effect.gen(function* () {
  const token = mintSession(LAB_A);
  const ctl = yield* openConnection(LAB_A, token);
  let rc = yield* openConnection(LAB_A, token);

  // b: two shell subscribers; the "rc" one drops mid-turn and resumes from its cursor.
  const shellCtl = yield* collect(ctl.client[M.subscribeShell]({}));
  let shellRc = yield* collect(rc.client[M.subscribeShell]({}));
  yield* waitUntil("shell snapshots", () => shellCtl.items.some((i) => i.kind === "snapshot") && shellRc.items.some((i) => i.kind === "snapshot"));
  const shellRcSnapshot = shellRc.items.find((i) => i.kind === "snapshot");
  const shellBase = shellRcSnapshot?.kind === "snapshot" ? shellRcSnapshot.snapshot.snapshotSequence : 0;

  const sampler = sampleClaudeProcesses(LAB_A);
  const launched = yield* launch(ctl.client, LAB_A, "s0 a: echo/false", "high", PROMPT_A);
  const threadId = launched.threadId;
  state.threadA = threadId;
  saveState();

  const threadCtl = yield* collect(ctl.client[M.subscribeThread]({ threadId }));
  let threadRc = yield* collect(rc.client[M.subscribeThread]({ threadId }));
  yield* waitUntil("thread snapshot", () => threadRc.items.some((i) => i.kind === "snapshot"));
  const rcSnap = threadRc.items.find((i) => i.kind === "snapshot");
  const threadBase = rcSnap?.kind === "snapshot" ? rcSnap.snapshotSequence : 0;

  // Drop the rc connection once the first command item exists, keep it down while the turn runs on.
  yield* waitUntil("first command item", () =>
    threadCtl.items.some((i) => i.kind === "event" && i.event.type === "turn-item.updated" && (i.event.payload as { type?: string }).type === "command_execution"),
  );
  const threadBefore = eventSeqs(threadRc.items);
  const shellBefore = shellSeqs(shellRc.items);
  const threadCursor = Math.max(threadBase, ...threadBefore);
  const shellCursor = Math.max(shellBase, ...shellBefore);
  yield* threadRc.stop;
  yield* shellRc.stop;
  yield* rc.close;
  const downAt = Date.now();
  yield* Effect.sleep("4 seconds");
  rc = yield* openConnection(LAB_A, token);
  threadRc = yield* collect(rc.client[M.subscribeThread]({ threadId, afterSequence: threadCursor }));
  shellRc = yield* collect(rc.client[M.subscribeShell]({ afterSequence: shellCursor }));
  const downMs = Date.now() - downAt;

  const final = yield* waitForRun(ctl.client, threadId, 1);
  yield* Effect.sleep("2 seconds"); // let the last frames reach both subscribers
  sampler.stop();

  // b: compare what the resumed subscriber saw against the never-disconnected one.
  const ctlThread = eventSeqs(threadCtl.items).filter((s) => s > threadBase);
  const rcThread = new Set([...threadBefore, ...eventSeqs(threadRc.items)]);
  const missingThread = ctlThread.filter((s) => !rcThread.has(s));
  const resumedWithSnapshot = threadRc.items.some((i) => i.kind === "snapshot");
  const ctlShell = shellSeqs(shellCtl.items).filter((s) => s > shellBase);
  const rcShell = new Set([...shellBefore, ...shellSeqs(shellRc.items)]);
  const missingShell = ctlShell.filter((s) => !rcShell.has(s));
  const replayedDuringOutage = eventSeqs(threadRc.items).filter((s) => s <= Math.max(...ctlThread) && s > threadCursor).length;

  const cmds = commandItems(final);
  const claudeArgv = [...sampler.seen.values()];
  const argvFlag = (flag: string) => claudeArgv.map((a) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; }).filter(Boolean);
  const run1 = final.runs.find((r) => r.ordinal === 1);
  const answer = lastAssistantText(final);

  const pidA = pidOf(LAB_A);
  save("a", {
    threadId, shell: final.thread, runs: runsSummary(final), commands: cmds, answer,
    claudeArgv: claudeArgv.map((a) => a.map((x) => (x.length > 300 ? `${x.slice(0, 300)}…` : x))),
    resume: { threadBase, threadCursor, downMs, ctlThread, rcBefore: threadBefore, rcAfter: eventSeqs(threadRc.items), missingThread, resumedWithSnapshot, shellBase, shellCursor, ctlShell, missingShell, failures: [threadRc.failure(), shellRc.failure(), threadCtl.failure(), shellCtl.failure()].map(String) },
    serverPid: pidA,
  });

  // a
  const shellThread = [...shellCtl.items].reverse().find((i) => i.kind === "thread.updated" && i.thread.id === threadId);
  const rtm = shellThread?.kind === "thread.updated" ? shellThread.thread.runtimeMode : undefined;
  const approvals = final.runtimeRequests.length;
  verdict("a. project create + launchThread with explicit model/effort and runtimeMode full-access over WS",
    rtm === "full-access" && run1?.status === "completed" && approvals === 0,
    `thread ${threadId}: shell runtimeMode=${rtm}, run#1 status=${run1?.status}, model=${run1?.modelSelection.model}, ` +
      `effort=${JSON.stringify(run1?.modelSelection.options)}, approval requests=${approvals}`);
  verdict("b. subscribeThread/subscribeShell resume with afterSequence after a reconnect, no gaps",
    missingThread.length === 0 && missingShell.length === 0 && !resumedWithSnapshot && ctlThread.length > 0,
    `socket down ${downMs} ms mid-turn; thread cursor ${threadCursor}: control saw ${ctlThread.length} events, ` +
      `resumed client missing ${missingThread.length} (replayed ${replayedDuringOutage} on resume, snapshot on resume=${resumedWithSnapshot}); ` +
      `shell cursor ${shellCursor}: control ${ctlShell.length} items, missing ${missingShell.length}`);
  const echo = cmds.find((c) => c.input.includes("echo hi"));
  const fals = cmds.find((c) => /(^|\s)false(\s|$)/.test(c.input));
  verdict("d0. projection command_execution items carry exitCode (echo hi -> 0, false -> 1)",
    echo?.exitCode === 0 && fals?.exitCode === 1,
    `items: ${cmds.map((c) => `${JSON.stringify(c.input)} exit=${c.exitCode} failure=${c.outputIndicatesFailure} status=${c.status}`).join("; ")}`);
  const disallowed = argvFlag("--disallowedTools");
  verdict("e. (lab-a) launchArgs `--disallowedTools mcp__t3-code__delegate_task` reach the claude CLI and hide the tool",
    disallowed.some((v) => String(v).includes("mcp__t3-code__delegate_task")) && !answer.includes("delegate_task"),
    `claude argv --disallowedTools=${JSON.stringify(disallowed)}; agent's own tool list: ${JSON.stringify(answer.slice(0, 400))}`);
  const efforts = argvFlag("--effort");
  verdict("f. effort sent (high) is the effort the spawned claude CLI runs with",
    efforts.length > 0 && efforts.every((e) => e === "high"),
    `claude processes seen=${claudeArgv.length}, argv --effort=${JSON.stringify(efforts)}, --model=${JSON.stringify(argvFlag("--model"))}`);
  yield* threadCtl.stop;
  yield* shellCtl.stop;
  yield* threadRc.stop;
  yield* shellRc.stop;
  yield* rc.close;
  yield* ctl.close;
});

// ---------------------------------------------------------------------------------------------
// d (detail): read each command item in full with getTurnItem; Claude items carry no exitCode, so check
// what the full output says.
const stageD = Effect.gen(function* () {
  const threadId = state.threadA;
  if (!threadId) throw new Error("run stage a first");
  const { client, close } = yield* openConnection(LAB_A, mintSession(LAB_A));
  const p = yield* projection(client, threadId);
  const full = [];
  for (const c of commandItems(p).filter((c) => c.input === "echo hi" || c.input === "false")) {
    const r = yield* client[M.getTurnItem]({ threadId: ThreadId.make(threadId), itemId: c.id });
    const item = r.item?.type === "command_execution" ? r.item : undefined;
    full.push({ input: c.input, status: item?.status, exitCode: item?.exitCode, outputIndicatesFailure: item?.outputIndicatesFailure, output: item?.output });
  }
  save("d", full);
  const parsed = full.map((f) => ({ ...f, derivedExit: f.status === "completed" ? 0 : Number(/Exit code (\d+)/.exec(f.output ?? "")?.[1] ?? NaN) }));
  const echo = parsed.find((f) => f.input === "echo hi");
  const fals = parsed.find((f) => f.input === "false");
  verdict("d. exit codes readable for Claude Bash items (getTurnItem)",
    echo?.exitCode === 0 && fals?.exitCode === 1 ? true : echo?.derivedExit === 0 && fals?.derivedExit === 1 ? "partial" : false,
    parsed.map((f) => `${JSON.stringify(f.input)}: status=${f.status} exitCode=${f.exitCode} outputIndicatesFailure=${f.outputIndicatesFailure} output=${JSON.stringify((f.output ?? "").slice(0, 60))}`).join("; "));
  yield* close;
});

// ---------------------------------------------------------------------------------------------
// c: wake an idle thread with a dispatched message, then interrupt a running turn.
const stageC = Effect.gen(function* () {
  const threadId = state.threadA;
  if (!threadId) throw new Error("run stage a first");
  const { client, close } = yield* openConnection(LAB_A, mintSession(LAB_A));
  const before = yield* projection(client, threadId);
  const idleBefore = before.runs.every((r) => terminal.has(r.status));
  const n = before.runs.length;
  yield* sendMessage(client, threadId, "Reply with the single word OK.");
  const woke = yield* waitForRun(client, threadId, n + 1);
  const wakeRun = woke.runs.find((r) => r.ordinal === n + 1);
  verdict("c1. message.dispatch wakes an idle thread (new run, answered)",
    idleBefore && wakeRun?.status === "completed" && /\bOK\b/.test(lastAssistantText(woke)),
    `idle before=${idleBefore}; run#${n + 1} status=${wakeRun?.status}; reply=${JSON.stringify(lastAssistantText(woke).slice(0, 80))}`);

  yield* sendMessage(client, threadId, "Use the Bash tool to run `sleep 45`, then reply DONE.");
  let running: OrchestrationV2ThreadProjection | undefined;
  yield* waitUntil("sleep command running", () => {
    const item = running && commandItems(running).find((c) => c.input.includes("sleep 45"));
    return item !== undefined && item.status === "running";
  }, 120_000).pipe(
    Effect.raceFirst(Effect.forever(projection(client, threadId).pipe(Effect.tap((p) => Effect.sync(() => { running = p; })), Effect.andThen(Effect.sleep("500 millis"))))),
  );
  const run = running!.runs.find((r) => r.ordinal === n + 2)!;
  const sleepsBefore = descendants(pidOf(LAB_A)).filter((p) => p.argv.join(" ").includes("sleep 45")).length;
  const t0 = Date.now();
  yield* client[M.dispatchCommand]({
    type: "run.interrupt",
    commandId: CommandId.make(id()),
    threadId: ThreadId.make(threadId),
    runId: run.id,
    reason: "fleetd s0 interrupt test",
  });
  const after = yield* waitForRun(client, threadId, n + 2, 60_000);
  const ms = Date.now() - t0;
  yield* Effect.sleep("1 second");
  const sleepsAfter = descendants(pidOf(LAB_A)).filter((p) => p.argv.join(" ").includes("sleep 45")).length;
  const interrupted = after.runs.find((r) => r.ordinal === n + 2);
  save("c", { threadId, runs: runsSummary(after), commands: commandItems(after), sleepsBefore, sleepsAfter, interruptToTerminalMs: ms });
  verdict("c2. run.interrupt stops a running turn",
    interrupted?.status === "interrupted" && sleepsAfter === 0,
    `run#${n + 2} ${run.status} -> ${interrupted?.status} in ${ms} ms; 'sleep 45' processes under the server before=${sleepsBefore} after=${sleepsAfter}`);
  yield* close;
});

// ---------------------------------------------------------------------------------------------
// e (control): lab-b's fleetd instance has no launch args; the tool should be visible there.
const stageE = Effect.gen(function* () {
  const { client, close } = yield* openConnection(LAB_B, mintSession(LAB_B));
  const sampler = sampleClaudeProcesses(LAB_B);
  const launched = yield* launch(client, LAB_B, "s0 e: control tool list", "low",
    "Reply with exactly one line: the comma-separated names of every tool available to you whose name starts with mcp__t3-code__ (write NONE if there are none). Do nothing else.");
  const final = yield* waitForRun(client, launched.threadId, 1);
  sampler.stop();
  const answer = lastAssistantText(final);
  const argv = [...sampler.seen.values()];
  save("e-control", { threadId: launched.threadId, runs: runsSummary(final), answer, claudeArgv: argv.map((a) => a.filter((x) => x.length < 300)) });
  verdict("e. (lab-b control, no launchArgs) the same tool IS visible without the flag",
    answer.includes("delegate_task"),
    `--disallowedTools in argv: ${argv.some((a) => a.includes("--disallowedTools"))}; agent's tool list: ${JSON.stringify(answer.slice(0, 400))}`);
  yield* close;
});

// ---------------------------------------------------------------------------------------------
// g: T3's direct `api/oauth/usage` probe must never fire for an instance whose CLAUDE_CONFIG_DIR has no
// .credentials.json (auth via ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN env instead).
const stageG = Effect.gen(function* () {
  const out: Record<string, unknown> = {};
  let ok = true;
  for (const l of [LAB_A, LAB_B]) {
    const trace = fs.readFileSync(path.join(l.home, "userdata/logs/server.trace.ndjson"), "utf8").split("\n").filter(Boolean);
    const spans = trace.map((line) => JSON.parse(line) as { name: string; attributes?: Record<string, unknown> });
    const resetSpans = spans.filter((s) => /ResetCredit/i.test(s.name)).length;
    const anthropicHttp = spans.filter((s) => JSON.stringify(s.attributes ?? {}).includes("api.anthropic.com")).length;
    const httpSpans = spans.filter((s) => /^http\.client|HttpClient/.test(s.name)).map((s) => String(s.attributes?.["url.full"] ?? s.attributes?.["http.url"] ?? s.name));
    const credentials = fs.existsSync(path.join(l.claudeDir, ".credentials.json"));
    const { client, close } = yield* openConnection(l, mintSession(l));
    const cfg = yield* client[WS_METHODS.serverGetConfig]({});
    yield* close;
    const fleetd = cfg.providers.find((p) => p.instanceId === "fleetd");
    out[l.name] = { traceSpans: spans.length, resetSpans, anthropicHttp, httpSpans: [...new Set(httpSpans)], credentialsFile: credentials,
      fleetdAuth: fleetd?.auth, usageLimits: fleetd?.usageLimits };
    ok &&= resetSpans === 0 && anthropicHttp === 0 && !credentials && fleetd?.status === "ready";
  }
  save("g", out);
  verdict("g. no direct oauth/usage probe with a separate CLAUDE_CONFIG_DIR and env-token auth", ok,
    Object.entries(out).map(([k, v]) => { const o = v as Record<string, unknown>; return `${k}: ${o.traceSpans} spans, reset-credit spans=${o.resetSpans}, spans naming api.anthropic.com=${o.anthropicHttp}, .credentials.json=${o.credentialsFile}, auth=${JSON.stringify(o.fleetdAuth)}`; }).join(" | "));
});

// ---------------------------------------------------------------------------------------------
// h: restart lab-b mid-turn (stop by recorded PID, start again) and watch T3's restart continuation.
// h2 does the same with SIGKILL, i.e. a crash rather than a planned restart.
const stageH = (mode: "restart" | "crash-restart") => Effect.gen(function* () {
  const token = mintSession(LAB_B);
  const first = yield* openConnection(LAB_B, token);
  const launched = yield* launch(first.client, LAB_B, "s0 h: restart mid-turn", "low",
    "Use the Bash tool to run `sleep 20 && echo slept`, then reply with the single word DONE.");
  const threadId = launched.threadId;
  let p: OrchestrationV2ThreadProjection | undefined;
  yield* waitUntil("sleep command running", () => p && commandItems(p).some((c) => c.input.includes("sleep 20") && c.status === "running"), 120_000).pipe(
    Effect.raceFirst(Effect.forever(projection(first.client, threadId).pipe(Effect.tap((x) => Effect.sync(() => { p = x; })), Effect.andThen(Effect.sleep("500 millis"))))),
  );
  const oldPid = pidOf(LAB_B);
  yield* first.close.pipe(Effect.ignore);
  const t0 = Date.now();
  const restartOut = execFileSync(process.execPath, [path.join(import.meta.dirname, "../../../lab/lab.mjs"), mode, "lab-b"], { encoding: "utf8" });
  const restartMs = Date.now() - t0;
  const newPid = pidOf(LAB_B);
  // The bearer session minted before the restart is reused on purpose: sessions live in the T3 db.
  const second = yield* openConnection(LAB_B, token);
  let q: OrchestrationV2ThreadProjection | undefined;
  yield* waitUntil("continuation settled", () => {
    if (!q) return false;
    const cont = q.runs.find((r) => r.restartContinuationOfRunId !== undefined);
    const orig = q.runs.find((r) => r.ordinal === 1);
    return orig !== undefined && terminal.has(orig.status) && (cont === undefined ? false : terminal.has(cont.status));
  }, 180_000).pipe(
    Effect.raceFirst(Effect.forever(projection(second.client, threadId).pipe(Effect.tap((x) => Effect.sync(() => { q = x; })), Effect.andThen(Effect.sleep("1 second"))))),
    Effect.catch(() => Effect.void),
  );
  const final = yield* projection(second.client, threadId);
  const msgs = final.messages.map((m) => ({ role: m.role, createdBy: m.createdBy, runId: m.runId, text: m.text.slice(0, 200) }));
  save(mode === "restart" ? "h" : "h2", { mode, threadId, oldPid, newPid, restartMs, restartOut, runs: runsSummary(final), commands: commandItems(final), messages: msgs, lastError: final.thread });
  const cont = final.runs.find((r) => r.restartContinuationOfRunId !== undefined);
  verdict(mode === "restart" ? "h. planned restart (SIGTERM) mid-turn: T3 continues the turn by itself" : "h2. crash (SIGKILL) mid-turn, then start: T3 continues the turn by itself",
    cont !== undefined && cont.status === "completed" ? true : cont !== undefined ? "partial" : false,
    `server pid ${oldPid} -> ${newPid} (${restartMs} ms); runs: ${runsSummary(final).map((r) => `#${r.ordinal} ${r.status}${r.restartContinuationOfRunId ? ` (continues ${r.restartContinuationOfRunId.slice(0, 8)})` : ""}`).join(", ")}; ` +
      `commands: ${commandItems(final).map((c) => `${JSON.stringify(c.input)} ${c.status} exit=${c.exitCode}`).join("; ")}; last reply=${JSON.stringify(lastAssistantText(final).slice(0, 80))}`);
  yield* second.close;
});

const STAGES: Record<string, Effect.Effect<void, unknown>> = { ttl: stageTtl, a: stageA, d: stageD, c: stageC, e: stageE, g: stageG, h: stageH("restart"), h2: stageH("crash-restart") };
const wanted = process.argv.slice(2);
for (const name of wanted.length > 0 ? wanted : Object.keys(STAGES)) {
  const stage = STAGES[name];
  if (!stage) throw new Error(`unknown stage ${name}`);
  console.log(`\n== stage ${name}`);
  const exit = await Effect.runPromiseExit(stage);
  if (exit._tag === "Failure") {
    console.log(`FAIL    stage ${name} crashed: ${String(exit.cause).slice(0, 2000)}`);
    results.push({ claim: `stage ${name}`, verdict: "FAIL", evidence: "crashed" });
  }
}
const resultsPath = path.join(EVIDENCE, "results.json");
const all = fs.existsSync(resultsPath) ? (JSON.parse(fs.readFileSync(resultsPath, "utf8")) as typeof results) : [];
fs.writeFileSync(resultsPath, JSON.stringify([...all.filter((r) => !results.some((x) => x.claim === r.claim)), ...results], null, 2));
process.exit(0);
