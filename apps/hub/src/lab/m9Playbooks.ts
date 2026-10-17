// M9 "done when" on lab-a and the public testbed: (a) an intent with a `fix:` prefix and no project goes through one
// router run (claude -p, haiku, on the hub) to lab-a's project with the bugfix playbook pinned; (b) a bugfix brief
// without a repro check is refused; (c) a research workstream's claim spawns the hub's judge, whose verdict the
// harness reports from the shell with baseline and candidate, and the hub computes STOP from the frozen rule; (d) a
// finish-all workstream on the testbed (no open issues) goes idle with the digest line once its lead, or the harness,
// runs `fleetd inventory`. The harness's `fleetd` calls run in the project's workspace and cost no turns.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { FINISH_ALL_IDLE } from "../playbooks/finishAllRules.ts";
import { type Body, CLI, LAB, type Lab, MODEL, scrubbedEnv } from "./harness.ts";
import { removeTestbedProject, t3, TESTBED } from "./m7Train.ts";

const MACHINE = "lab-a";
const TESTBED_REPO = "unlaboredlabs/fleetd-testbed";
const TURN_MS = 240_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
const QUIET = "Lab run: the harness does the work for this intent; reply to each wake with one short line and run no commands.";

const shell = (cwd: string) => {
  const env = { ...scrubbedEnv(), PWD: cwd, FLEETD_NODE_SOCK: path.join(LAB, "sock", `${MACHINE}.sock`) };
  const run = (...args: Array<string>) => {
    const out = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env });
    return { code: out.status, stdout: out.stdout, stderr: out.stderr };
  };
  /** The same call in the background, for one that waits on something the harness does next. */
  const start = (...args: Array<string>) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  return { run, start };
};

export async function m9Playbooks(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE && p.workspaceRoot !== TESTBED)?.projectId as string;
  check(projectId, `${MACHINE} has a project`);
  const ref = { machineId: MACHINE, projectId };
  const outcome = (await callTool("project_get", ref)).body;
  const root = outcome.project.workspaceRoot as string;
  const { run: fleetd, start: fleetdBg } = shell(root);
  const scenarioStart = await lab.cursor();
  const leadTurnEnds = (thread: string, cursor: number) =>
    lab.waitEvent("a lead turn to end", TURN_MS, { cursor, match: (e) => e.threadId === thread && ENDED.includes(e.type) });

  // The lead: an earlier scenario's, else a fresh one, which also makes haiku/low the project's task default.
  let leadThread: string;
  if (outcome.lead === undefined) {
    const started = await callTool("lead_start", { ...ref, model: MODEL, effort: "low" });
    check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
    leadThread = started.body.threadId;
    await leadTurnEnds(leadThread, scenarioStart);
  } else {
    leadThread = outcome.lead.threadId;
  }
  const leads = [leadThread];

  // (a) No project given: the `fix:` prefix picks bugfix, one router run picks the project.
  const routedText = `fix: the repo-a README has a typo. ${QUIET}`;
  const a = await callTool("intake_submit", { text: routedText, clientRequestId: randomUUID() });
  check(!a.isError && a.body.workstreamId !== undefined, `intake_submit without a project: ${JSON.stringify(a.body)}`);
  const wa = a.body.workstreamId as string;
  check(a.body.echo?.projectRef?.machineId === MACHINE && a.body.echo.projectRef.projectId === projectId && a.body.echo.template === "bugfix", `echo: ${JSON.stringify(a.body.echo)}`);
  const routed = await lab.waitEvent("intake.routed", 10_000, { cursor: scenarioStart, types: ["intake.routed"], match: (e) => e.data?.workstreamId === wa });
  const routerRuns = (routed.event.data.usage as Array<Body> | undefined) ?? [];
  check(routerRuns.length === 1 && routerRuns[0]!.kind === "orchestrator" && routerRuns[0]!.ok === true, `one orchestrator router run: ${JSON.stringify(routerRuns)}`);
  const pinnedA = (await callTool("workstream_get", { workstreamId: wa })).body.workstream.playbook as string;
  check(/^bugfix@[0-9a-f]{40}$/u.test(pinnedA), `${wa} pins bugfix: ${pinnedA}`);
  ok(`(a) ${wa} → ${MACHINE}/${projectId} (bugfix), 1 router run (${routerRuns[0]!.model}, ${routerRuns[0]!.durationMs} ms); echo: ${a.body.echo.reason}; playbook ${pinnedA.slice(0, 19)}…`);

  // (b) A bugfix brief without a test or cmd repro check is refused at freeze.
  const briefBase = { pointers: [], constraints: [], estimate: { rawMinutes: 5, gates: [] } };
  const noRepro = fleetd("brief", "create", "--workstream", wa, "--json", JSON.stringify({ ...briefBase, goal: "fix the README typo", why: "M9 lab", doneWhen: [{ type: "judge", criteria: "the typo is gone" }] }));
  check(noRepro.code === 3 && noRepro.stderr.includes("bugfix needs a failing repro check (type test or cmd)"), `bugfix brief without a repro: ${JSON.stringify(noRepro)}`);
  ok(`(b) brief create ${wa} refused (exit 3): ${noRepro.stderr.trim().split("\n")[0]}`);

  // (c) A research workstream: the brief pre-registers baseline, metric and rule; the judge's numbers decide.
  const r = await callTool("intake_submit", { ...ref, text: `research: would a shorter README read faster? ${QUIET}`, clientRequestId: randomUUID() });
  check(!r.isError && r.body.echo?.template === "research", `research intake: ${JSON.stringify(r.body)}`);
  const wr = r.body.workstreamId as string;
  const research = {
    ...briefBase,
    goal: "find out whether a shorter README reads faster",
    why: "M9 lab",
    doneWhen: [{ type: "judge", criteria: "Lab run: the harness reports both numbers itself. Do not measure or run anything; reply with the single word OK." }],
    tier: "S",
    baseline: "the README as it is",
    metric: "seconds to read the README",
    decisionRule: { better: "lower", goAtLeast: 5, stopBelow: 5 },
    budget: { agentHours: 1 },
  };
  const { baseline: _b, decisionRule: _r, ...unregistered } = research;
  const missing = fleetd("brief", "create", "--workstream", wr, "--json", JSON.stringify(unregistered));
  check(missing.code === 3 && missing.stderr.includes("missing baseline, decisionRule"), `research brief without baseline and rule: ${JSON.stringify(missing)}`);
  const frozen = fleetd("brief", "create", "--workstream", wr, "--json", JSON.stringify(research));
  check(frozen.code === 0, `research brief: ${JSON.stringify(frozen)}`);
  ok(`(c) ${wr} research: a brief without baseline and decisionRule refused (${missing.stderr.trim().split("\n")[0]}); then frozen with rule lower-is-better, GO at 5 s`);

  let cursor = await lab.cursor();
  const claim = fleetdBg("claim", "done", "--workstream", wr);
  const judgeStart = await lab.waitEvent("the judge task starts", 60_000, { cursor, types: ["task.started"], match: (e) => e.data?.workstreamId === wr });
  const judge = (await callTool("task_get", { taskId: judgeStart.event.data.taskId })).body.task as Body;
  check(judge.kind === "review" && judge.pr === undefined && judge.model === MODEL, `the hub's judge task: ${JSON.stringify(judge)}`);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const reported = fleetd("review", "verdict", "--task", judge.taskId, "--sha", head, "--blocking", "0", "--non-blocking", "0", "--summary", "lab: both READMEs read by the harness", "--baseline", "60", "--candidate", "58");
  check(reported.code === 0 && reported.stdout.includes(`${wr} research verdict STOP`), `review verdict with baseline and candidate: ${JSON.stringify(reported)}`);
  const cancelled = fleetd("task", "cancel", judge.taskId, "--reason", "lab: the harness reported the verdict");
  lab.log(`cancelled the judge ${judge.taskId}: exit ${cancelled.code}`);
  const claimed = await claim;
  check(claimed.code === 0 && claimed.stdout.includes("passed"), `the claim passes on the judge's verdict: ${JSON.stringify(claimed)}`);
  const wrNow = (await callTool("workstream_get", { workstreamId: wr })).body.workstream as Body;
  check(wrNow.state === "done" && wrNow.outcome === "stop" && wrNow.verdict?.outcome === "stop" && wrNow.verdict.metricValues.candidate === 58, `${wr}: ${JSON.stringify(wrNow)}`);
  const verdictEvent = await lab.waitEvent("research.verdict", 10_000, { cursor, types: ["research.verdict"], match: (e) => e.data?.workstreamId === wr });
  ok(`(c) judge ${judge.taskId} (spawned by the hub, ${judge.model}) reported baseline 60 / candidate 58 through the CLI; ${verdictEvent.event.summary}; ${wr} done, outcome ${wrNow.outcome}`);

  // (d) Finish-all on the testbed, which has no open issues.
  const open = JSON.parse(spawnSync("gh", ["issue", "list", "-R", TESTBED_REPO, "--state", "open", "--json", "number"], { cwd: LAB, encoding: "utf8", env: scrubbedEnv() }).stdout) as Array<Body>;
  check(open.length === 0, `${TESTBED_REPO} has no open issues: ${JSON.stringify(open)}`);
  let wf: string | undefined;
  let tbRef: { machineId: string; projectId: string } | undefined;
  try {
    // The hub keeps m7's deleted testbed project in its list, so this run's is the one with the new id.
    const testbedIds = async () =>
      ((await callTool("projects_list", { machineId: MACHINE })).body.projects as Array<Body>).filter((p) => p.workspaceRoot === TESTBED).map((p) => p.projectId as string);
    const earlier = new Set(await testbedIds());
    const tbId = randomUUID();
    await t3(lab, "POST", "/api/projects/mutate", { type: "project.create", commandId: randomUUID(), projectId: tbId, title: "fleetd-testbed", workspaceRoot: TESTBED });
    const tb = await lab.until("the hub sees the new testbed project", 60_000, async () => {
      const found = (await testbedIds()).find((id) => !earlier.has(id));
      if (found === undefined) await callTool("events_wait", { cursor: await lab.cursor(), timeoutSec: 3 });
      return found;
    });
    tbRef = { machineId: MACHINE, projectId: tb };
    const f = await callTool("intake_submit", { ...tbRef, text: "finish: everything still open", clientRequestId: randomUUID() });
    check(!f.isError && f.body.echo?.template === "finish-all" && f.body.echo.projectRef.projectId === tb, `finish-all intake: ${JSON.stringify(f.body)}`);
    wf = f.body.workstreamId as string;
    cursor = await lab.cursor();
    const started = await callTool("lead_start", { ...tbRef, model: MODEL, effort: "low" });
    check(!started.isError, `lead_start on the testbed: ${JSON.stringify(started.body)}`);
    leads.push(started.body.threadId);
    await leadTurnEnds(started.body.threadId, cursor);
    let state = (await callTool("workstream_get", { workstreamId: wf })).body.workstream.state as string;
    if (state === "idle") {
      ok(`(d) the testbed lead ran fleetd inventory itself in its first turn; ${wf} is idle`);
    } else {
      const before = state;
      const inventory = shell(TESTBED).run("inventory");
      check(inventory.code === 0 && inventory.stdout.includes(FINISH_ALL_IDLE), `fleetd inventory on the testbed: ${JSON.stringify(inventory)}`);
      state = (await callTool("workstream_get", { workstreamId: wf })).body.workstream.state as string;
      ok(`(d) the lead left ${wf} ${before}; the harness ran fleetd inventory: ${inventory.stdout.trim().replace(/\n/gu, " | ")}`);
    }
    check(state === "idle", `${wf} is idle: ${state}`);
    const digest = (await callTool("digest_get")).body.text as string;
    const line = digest.split("\n").find((l) => l.startsWith(`Idle: ${wf} fleetd-testbed: `));
    check(line?.endsWith(`· ${FINISH_ALL_IDLE}`), `the human digest shows ${wf} idle with "${FINISH_ALL_IDLE}": ${digest}`);
    ok(`(d) digest: ${line}`);
  } finally {
    await removeTestbedProject(lab).catch((error: unknown) => lab.log(`could not remove the testbed project: ${String(error)}`));
  }

  // Let the last lead wakes on lab-a run out, then count every claude turn this scenario cost.
  for (let after = await lab.cursor(); ; ) {
    const wake = await lab.waitEvent("a late lead wake", 30_000, { cursor: after, machineId: MACHINE, types: ["lead.woken"], match: (e) => e.threadId === leadThread }).catch(() => undefined);
    if (wake === undefined) break;
    after = (await leadTurnEnds(leadThread, wake.event.seq)).cursor;
  }
  let leadTurns = 0;
  for (let at = scenarioStart; ; ) {
    const page = (await callTool("events_wait", { cursor: at, machineId: MACHINE, types: ENDED, timeoutSec: 0 })).body;
    leadTurns += (page.events as Array<Body>).filter((e) => leads.includes(e.threadId)).length;
    if (!page.more) break;
    at = page.cursor;
  }
  const ours = [wa, wr, wf];
  const tasks: Array<Body> = [];
  for (const projectRef of tbRef === undefined ? [ref] : [ref, tbRef]) {
    tasks.push(...((await callTool("tasks_list", { projectRef, limit: 100 })).body.tasks as Array<Body>).filter((t) => ours.includes(t.workstreamId)));
  }
  const taskTurns = tasks.reduce((n, t) => n + (t.attempt as number), 0);
  const total = routerRuns.length + leadTurns + taskTurns;
  ok(`M9 used ${routerRuns.length} router run + ${leadTurns} lead turns + ${taskTurns} task turns (${tasks.map((t) => `${t.taskId} ${t.kind}×${t.attempt}`).join(", ")}) = ${total} claude turns (${MODEL})`);
  check(total <= 10, `M9 stays within 10 claude turns (${total})`);
}
