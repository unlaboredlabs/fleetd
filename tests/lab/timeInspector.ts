// The agent time inspector on one real order, on lab-a against the public lab repo unlaboredlabs/fleetd-lab in this
// slot's namespace (the M7 setup and its `ci` check). An order with one writer goes through the merge train while the lead's gated run
// waits 15 s for a human key's Approve. Then the order's timeline must add up: the critical path covers the order's
// wall time exactly and the wall matches submit-to-done, every run is tiled by its spans, the `ci` check span is
// GitHub's own interval inside `change.ci`, the approval wait is a `wait.request` span of the right length, coverage is
// complete, and `fleetd time <W>` prints it. About 6 turns. It resets only its own namespace, before and after.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Body, MODEL, openWorkstream, cli, fleetdCommand, HUB_PORT, type Lab, MECHANICS, nodeSock, requireGhLogin, scrubbedEnv } from "./harness.ts";
import { BASE, checkClone, CLONE, NAMESPACE, onBase, prepareCheckout, REPO, removeLabRepoProject, resetNamespace } from "./m7Train.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const CI_MS = 600_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
const APPROVAL_WAIT_MS = 15_000;
const FILE = `lab/${new Date().toISOString().slice(0, 19).replace(/\D/gu, "")}/time.md`;
const POLICY = `
`;
/** The spec's tolerance for a run's spans against its own start and end. */
const tiles = (sum: number, wall: number) => Math.abs(sum - wall) <= Math.max(250, wall / 100);

const gh = (...args: Array<string>) => {
  const out = spawnSync("gh", args, { cwd: path.dirname(CLONE), env: scrubbedEnv(), encoding: "utf8" });
  if (out.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${out.stderr.trim()}`);
  return out.stdout.trim();
};

/** The desktop app's protocol with a human key, so the Approve counts as a person's. */
const appSession = async (key: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${HUB_PORT}/app`);
  const waiting = new Map<string, { resolve: (v: Body) => void; reject: (e: Error) => void }>();
  let ready: (() => void) | undefined;
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data)) as Body;
    if (m.t === "ready") ready?.();
    const w = typeof m.id === "string" ? waiting.get(m.id) : undefined;
    if (w === undefined) return;
    waiting.delete(m.id);
    if (m.t === "result") w.resolve(m.output as Body);
    else w.reject(new Error(`${m.code}: ${m.message}`));
  };
  await new Promise<void>((resolve, reject) => {
    ready = resolve;
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", key }));
    ws.onerror = () => reject(new Error("cannot open /app"));
  });
  let nextId = 0;
  const call = (tool: string, input: Record<string, unknown> = {}) =>
    new Promise<Body>((resolve, reject) => {
      const id = `c${++nextId}`;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ t: "call", id, tool, input }));
    });
  return { call, close: () => ws.close() };
};

export async function timeInspector(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  requireGhLogin();
  check(NAMESPACE.startsWith("slot/"), `time needs CI: run it in a slot/<n> namespace, not ${NAMESPACE}`);
  checkClone(check);
  resetNamespace();
  prepareCheckout(POLICY);
  fs.rmSync(lab.dir, { recursive: true, force: true });
  fs.mkdirSync(lab.dir, { recursive: true });
  const scenarioStart = await lab.cursor();
  const since = new Date().toISOString();
  let prUrl: string | undefined;
  let app: Awaited<ReturnType<typeof appSession>> | undefined;
  try {
    const projectId = await lab.addProject(MACHINE, CLONE, "fleetd-lab");
    const ref = { machineId: MACHINE, projectId };
    const fleetd = (...args: Array<string>) => {
      const out = spawnSync(...fleetdCommand(args), {
        cwd: CLONE,
        encoding: "utf8",
        env: { ...scrubbedEnv(), PWD: CLONE, FLEETD_NODE_SOCK: nodeSock(MACHINE) },
      });
      return { code: out.status, stdout: out.stdout, stderr: out.stderr };
    };

    const started = await callTool("lead_start", ref);
    check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
    const leadThread = started.body.threadId as string;
    await lab.waitEvent("lead start turn", TURN_MS, { cursor: scenarioStart, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });

    // The order, opened and its brief registered from the shell as the lead would, so the lead has nothing to plan.
    const submitAt = Date.now();
    const w = openWorkstream(check, fleetd, `Add ${FILE}. The harness spawns the task and claims done.`);
    const brief = {
      goal: `add ${FILE}`,
      why: "the time inspector lab scenario",
      pointers: [],
      constraints: [],
      doneWhen: [{ type: "cmd", machineId: MACHINE, argv: ["gh", "api", onBase(FILE), "--silent"], expectExit: 0 }],
    };
    const frozen = fleetd("brief", "create", "--workstream", w, "--json", JSON.stringify(brief));
    check(frozen.code === 0, `brief create ${w}: ${JSON.stringify(frozen)}`);

    // One writer: its PR goes on the train by itself.
    let cursor = await lab.cursor();
    const spawned = fleetd(
      "task", "spawn", "--workstream", w, "--title", "add time.md", "--profile", MECHANICS,
      "--prompt",
      `Create the file ${FILE} (from the repo root) containing exactly one line: time. Commit it with the message "add ${FILE}". Then push your branch and open the pull request as your rules say, with the title "add ${FILE}" and the body exactly "Adds the file.". Reply with the PR URL.`,
    );
    const taskId = /^Spawned (T\d+)/mu.exec(spawned.stdout)?.[1];
    check(spawned.code === 0 && taskId, `task spawn: ${JSON.stringify(spawned)}`);
    ok(`${w} with writer ${taskId}`);

    // Mid-order, the lead's gated run waits on a person: refused to the agent key, approved by a human key 15 s later.
    const humanKey = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", lab.hubHome, "--human", "--name", "lab-time"))?.[0];
    check(humanKey, "hub key create --human printed a key");
    app = await appSession(humanKey!);
    const gatedOut = fleetd("gated", "run", "--class", "irreversible", "--argv", JSON.stringify(["true"]), "--reason", "time lab approval", "--workstream", w);
    // The command is a request (Q<n>), shown in the project's chat with Approve / Deny.
    const askId = /\bQ\d+\b/u.exec(gatedOut.stdout)?.[0];
    check(gatedOut.code === 0 && askId, `gated run: ${JSON.stringify(gatedOut)}`);
    const itemOf = async () =>
      ((await app!.call("chat_history", { projectRef: ref, limit: 100 })).messages as Array<Body>).find((m) => m.item?.requestId === askId)?.item as Body | undefined;
    const filedAt = Date.now();
    await new Promise((r) => setTimeout(r, APPROVAL_WAIT_MS));
    const open = await itemOf();
    check(open?.kind === "command_approval" && open.state === "open", `${askId} is open in the chat: ${JSON.stringify(open)}`);
    const ranFrom = await lab.cursor();
    const approved = await app.call("approval_answer", { requestId: askId, decision: "approve" });
    check(approved !== undefined, "Approve");
    const answeredAt = Date.now();
    await lab.waitEvent(`${askId} ran`, 60_000, { cursor: ranFrom, types: ["request.updated"], match: (e) => e.data?.requestId === askId && ["ran", "failed"].includes(e.data?.state) });
    // The chat shows the request's change from its request.updated, just after.
    const ran = await lab.until(`${askId}'s chat item ran`, 30_000, async () => {
      const item = await itemOf();
      if (item?.state === "ran" || item?.state === "failed") return item;
      await new Promise((r) => setTimeout(r, 250));
      return undefined;
    });
    check(ran?.state === "ran" && ran.exitCode === 0, `${askId} ran: ${JSON.stringify(ran)}`);
    ok(`${askId} approved by the human key after ${((answeredAt - filedAt) / 1000).toFixed(1)} s; it ran`);

    // The writer's PR, through its review, the train and CI, to main.
    const end = await lab.waitEvent(`${taskId} ends`, TURN_MS, { cursor, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === taskId });
    check(end.event.type === "task.completed", `${taskId} completed: ${end.event.summary}`);
    prUrl = ((await callTool("task_get", { taskId })).body.task as Body).result?.prUrl as string | undefined;
    check(prUrl?.startsWith(`https://github.com/${REPO}/pull/`), `${taskId} names its PR: ${prUrl}`);
    const pr = JSON.parse(gh("pr", "view", prUrl!, "--json", "headRefName,baseRefName")) as Body;
    check(pr.baseRefName === BASE && (pr.headRefName as string).startsWith(`${NAMESPACE}/fleetd/`), `${prUrl} is ${pr.headRefName} into ${pr.baseRefName}, in ${NAMESPACE}`);
    const queued = await lab.waitEvent(`${taskId}'s PR enqueued`, 60_000, { cursor, types: ["change.queued"], match: (e) => prUrl!.endsWith(`/pull/${e.data?.prNumber}`) });
    const changeId = queued.event.data.changeId as string;
    const changeLane = `change:${REPO}#${queued.event.data.prNumber}`;
    cursor = queued.cursor;
    const merged = await lab.waitEvent(`pr.merged for ${changeId}`, CI_MS, { cursor, types: ["pr.merged"], match: (e) => e.data?.changeId === changeId });
    const change = ((await callTool("changes_list", { projectRef: ref, limit: 100 })).body.changes as Array<Body>).find((c) => c.changeId === changeId)!;
    ok(`${changeId} (${prUrl}) merged as ${String(merged.event.data.mergedSha).slice(0, 12)}`);

    const claim = fleetd("claim", "done", "--workstream", w);
    check(claim.code === 0, `claim done: ${JSON.stringify(claim)}`);
    const done = await lab.waitEvent("workstream.done", 60_000, { cursor: scenarioStart, types: ["workstream.done"], match: (e) => e.data?.workstreamId === w });
    const doneAt = Date.parse(done.event.at as string);
    // Let the lead's last wakes run out, so the order's lanes are closed when they are read.
    for (let after = done.cursor; ; ) {
      const wake = await lab.waitEvent("a late lead wake", 75_000, { cursor: after, machineId: MACHINE, types: ["lead.woken"], match: (e) => e.threadId === leadThread }).catch(() => undefined);
      if (wake === undefined) break;
      after = (await lab.waitEvent("a lead turn to end", TURN_MS, { cursor: wake.event.seq, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) })).cursor;
    }

    // The timeline.
    const scope = { kind: "order", workstreamId: w };
    const b = await callTool("time_breakdown", { scope, since });
    check(!b.isError, `time_breakdown: ${JSON.stringify(b.body)}`);
    const breakdown = b.body;
    const spans: Array<Body> = [];
    for (let afterId: number | undefined; ; ) {
      const page = (await callTool("time_spans", { scope, since, limit: 500, ...(afterId === undefined ? {} : { afterId }) })).body;
      spans.push(...(page.spans as Array<Body>));
      afterId = page.nextAfterId as number | undefined;
      if (afterId === undefined) break;
    }
    const dur = (s: Body) => (s.endMs as number) - (s.startMs as number);
    // The only gaps a clean order may have are short nothing-running stretches of the path (hub processing between
    // a thread's end and the next span); anything else is missing data.
    const gaps = breakdown.coverage.gaps as Array<Body>;
    check(gaps.every((g) => g.why === "nothing_running") && breakdown.coverage.complete === (gaps.length === 0), `coverage: ${JSON.stringify(breakdown.coverage)}`);
    check(spans.every((s) => s.endMs !== undefined), `every span of a done order is closed: ${JSON.stringify(spans.filter((s) => s.endMs === undefined))}`);

    // 1. The critical path adds up to the order's wall time, and the wall is submit to done.
    const p = breakdown.criticalPath as Body;
    const segments = p.segments as Array<Body>;
    const pathSum = segments.reduce((n, s) => n + dur(s), 0);
    const contiguous = segments.every((s, i) => i === 0 || s.startMs === segments[i - 1]!.endMs);
    check(pathSum === p.endMs - p.startMs && contiguous && segments[0]?.startMs === p.startMs, `path segments tile [${p.startMs}, ${p.endMs}]: sum ${pathSum}, contiguous ${contiguous}`);
    check(p.endMs - p.startMs === breakdown.wallMs, `path ${p.endMs - p.startMs} ms = wall ${breakdown.wallMs} ms`);
    check(Math.abs(breakdown.wallMs - (doneAt - submitAt)) <= 1000, `wall ${breakdown.wallMs} ms = submit to workstream.done ${doneAt - submitAt} ms (±1 s)`);
    check(p.nothingRunningMs <= Math.max(5000, breakdown.wallMs / 50), `nothing-running time on the path ${p.nothingRunningMs} ms ≤ max(5 s, 2% of wall)`);
    ok(`1. critical path ${segments.length} segments = wall ${(breakdown.wallMs / 1000).toFixed(1)} s (submit to done ${((doneAt - submitAt) / 1000).toFixed(1)} s); agent time ${(breakdown.agentMs / 1000).toFixed(1)} s`);

    // 2. Every run is tiled by its spans: the exclusive time below it adds up to its own length.
    const byId = new Map(spans.map((s) => [s.id as number, s]));
    const runOf = (s: Body): Body | undefined => {
      for (let at = s.parent === undefined ? undefined : byId.get(s.parent); at !== undefined; at = at.parent === undefined ? undefined : byId.get(at.parent)) if (at.kind === "run") return at;
      return undefined;
    };
    const runs = spans.filter((s) => s.kind === "run");
    check(runs.some((r) => r.taskId === taskId), `the writer's run is on the order: ${JSON.stringify(runs.map((r) => r.lane))}`);
    let worst = 0;
    for (const run of runs) {
      const sum = spans.filter((s) => s.runId === run.runId && runOf(s) === run).reduce((n, s) => n + ((s.exclMs as number | undefined) ?? 0), 0);
      check(tiles(sum, dur(run)), `${run.lane} run ${run.runId}: its spans' exclusive time ${sum} ms vs ${dur(run)} ms`);
      worst = Math.max(worst, Math.abs(sum - dur(run)));
    }
    ok(`2. ${runs.length} runs tiled by their spans within max(250 ms, 1%); worst off by ${worst} ms`);
    // And each lane as a whole: on session, change and task lanes nothing is counted twice, so the lane's exclusive
    // time is the length of the time it covers. Detail spans carry no exclusive time and are left out; asks and
    // checks lanes are not tiled by design (two open asks both count).
    const DETAIL = ["ci.check", "ci.queue", "ask.info", "gap"];
    const lanes = new Map<string, Array<Body>>();
    for (const s of spans.filter((s) => /^(thread|change|task):/u.test(s.lane) && !s.lane.endsWith("/ci") && !DETAIL.includes(s.kind))) {
      lanes.set(s.lane, [...(lanes.get(s.lane) ?? []), s]);
    }
    let laneWorst = 0;
    for (const [lane, own] of lanes) {
      const sorted = [...own].sort((x, y) => x.startMs - y.startMs);
      let covered = 0;
      let reach = -Infinity;
      for (const s of sorted) {
        covered += Math.max(0, s.endMs - Math.max(s.startMs, reach));
        reach = Math.max(reach, s.endMs);
      }
      const excl = own.reduce((n, s) => n + ((s.exclMs as number | undefined) ?? 0), 0);
      check(tiles(excl, covered), `${lane}: exclusive time ${excl} ms vs ${covered} ms covered`);
      laneWorst = Math.max(laneWorst, Math.abs(excl - covered));
    }
    ok(`2. ${lanes.size} session, change and task lanes tiled: exclusive time = time covered; worst off by ${laneWorst} ms`);

    // 3. CI: the train's stages back to back, and the `ci` check as GitHub timed it, inside change.ci.
    const stages = spans.filter((s) => s.lane === changeLane && (s.kind as string).startsWith("change.")).sort((x, y) => x.startMs - y.startMs);
    check(stages.every((s, i) => i === 0 || s.startMs === stages[i - 1]!.endMs), `change stages back to back: ${stages.map((s) => `${s.kind} ${s.startMs}-${s.endMs}`).join(", ")}`);
    for (const kind of ["change.review", "change.ci", "change.merge"]) check(stages.some((s) => s.kind === kind), `${changeId} has a ${kind} span`);
    const runsOnHead = JSON.parse(gh("api", `repos/${REPO}/commits/${change.headSha}/check-runs`)).check_runs as Array<Body>;
    const github = runsOnHead.filter((r) => r.name === "ci").sort((x, y) => Date.parse(y.started_at) - Date.parse(x.started_at))[0];
    check(github?.completed_at, `GitHub has a finished ci run on ${change.headSha}`);
    const ciSpan = spans.find((s) => s.kind === "ci.check" && s.lane === `${changeLane}/ci` && s.extra?.check === "ci");
    check(ciSpan, `a ci.check span named ci: ${JSON.stringify(spans.filter((s) => s.kind === "ci.check"))}`);
    const [ghStart, ghEnd] = [Date.parse(github!.started_at), Date.parse(github!.completed_at)];
    check(Math.abs(ciSpan!.startMs - ghStart) <= 1000 && Math.abs(ciSpan!.endMs - ghEnd) <= 1000, `ci span ${ciSpan!.startMs}-${ciSpan!.endMs} = GitHub ${github!.started_at} to ${github!.completed_at} (±1 s)`);
    const ciStage = stages.find((s) => s.kind === "change.ci")!;
    // On a rebased head the check runs inside change.ci. After a no-op rebase the train waits on the PR's own head,
    // whose CI may have finished before the train got to it; either way it ends before the train decides.
    check(ciSpan!.endMs <= ciStage.endMs + 1000 && ciSpan!.startMs >= p.startMs - 1000, `the ci check ${ciSpan!.startMs}-${ciSpan!.endMs} ends by change.ci's end ${ciStage.endMs}, within the order`);
    ok(`3. ${stages.map((s) => `${s.kind.slice(7)} ${(dur(s) / 1000).toFixed(0)}s`).join(" → ")}; ci check ${(dur(ciSpan!) / 1000).toFixed(0)} s matches GitHub; the train noticed ${((ciStage.endMs - ghEnd) / 1000).toFixed(0)} s after`);

    // 4. The approval wait: the gated command's wait.request span (the order's only request), from filing to the Approve, counted as waiting on you.
    const requests = spans.filter((s) => s.kind === "wait.request");
    check(requests.length === 1, `one wait.request span, for ${askId}: ${JSON.stringify(spans.filter((s) => /ask|request/u.test(s.kind as string)))}`);
    const approval = requests[0];
    check(dur(approval!) >= APPROVAL_WAIT_MS && dur(approval!) <= answeredAt - filedAt + 1000, `approval wait ${dur(approval!)} ms within [${APPROVAL_WAIT_MS}, ${answeredAt - filedAt + 1000}]`);
    const human = (breakdown.byCategory as Array<Body>).find((c) => c.cat === "human");
    check(human?.ms >= dur(approval!) && breakdown.humanWait.totalMs >= dur(approval!), `human time ${human?.ms} ms and humanWait ${breakdown.humanWait.totalMs} ms count it`);
    ok(`4. ${askId}: wait.request ${(dur(approval!) / 1000).toFixed(1)} s on the requests lane; you: ${(human!.ms / 1000).toFixed(1)} s of agent time`);

    // 5. The CLI prints it.
    const keyFile = path.join(lab.dir, "lab.key");
    fs.writeFileSync(keyFile, `${lab.key}\n`, { mode: 0o600 });
    const printed = spawnSync(...fleetdCommand(["time", w, "--since", since, "--hub", lab.hubUrl, "--key-file", keyFile]), { env: scrubbedEnv(), encoding: "utf8" });
    check(printed.status === 0 && printed.stdout.includes("critical path") && printed.stdout.includes("agent time"), `fleetd time ${w}: exit ${printed.status} ${printed.stdout}${printed.stderr}`);
    ok(`5. fleetd time ${w}:\n${printed.stdout.trimEnd()}`);

    // What it cost.
    const tasks = (await callTool("tasks_list", { projectRef: ref, limit: 100 })).body.tasks as Array<Body>;
    let leadTurns = 0;
    for (let at = scenarioStart; ; ) {
      const page = (await callTool("events_wait", { cursor: at, machineId: MACHINE, types: ENDED, timeoutSec: 0 })).body;
      leadTurns += (page.events as Array<Body>).filter((e) => e.threadId === leadThread).length;
      if (!page.more) break;
      at = page.cursor;
    }
    const turns = leadTurns + tasks.reduce((n, t) => n + (t.attempt as number), 0);
    ok(`time used ${turns} claude turns (${MODEL}, tasks on medium)`);
    check(turns <= 10, `time stays within 10 claude turns (${turns})`);
  } finally {
    app?.close();
    // Only this slot's namespace; never the repo's main, never another slot's.
    resetNamespace();
    // project_remove refuses while the project's sessions are live; then the lab repo project stays for this run only.
    await removeLabRepoProject(lab).catch((error: unknown) => lab.log(`could not remove the lab repo project (expected while its sessions are live): ${String(error)}`));
    fs.rmSync(path.join(CLONE, ".fleetd"), { recursive: true, force: true });
  }
}
