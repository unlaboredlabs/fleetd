// M6 "done when" 1-5 on lab-a: done is fleetd's call. A workstream whose only done-when check is a node-run
// `test -f docs/x.md` fails its first claim, and the lead is woken with the exit code and output. The writer that
// fixes it (the lead's own, else the harness's) is merged into the project's checkout as it ends, so the next claim,
// the lead's or the harness's, passes and records actual vs estimate. A tool-less task that says "tests pass" reaches
// the lead as unverified; a writer without --serves and a verdict from a non-review task are refused. The same-SHA
// review rule needs a real PR head from GitHub, so a unit test covers it (tasks/LeadTaskCalls.test.ts) until M7's
// lab repo. The harness's `fleetd` calls run in the project's workspace, as the lead's shell would, so they cost no
// turns; tasks run on medium.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Body, MODEL, openWorkstream, fleetdCommand, type Lab, MECHANICS, nodeSock, scrubbedEnv, sessionText } from "./harness.ts";
import { git, prepareRepo } from "./m5Tasks.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
const FILE = "docs/x.md";

export async function m6Verify(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE)?.projectId as string;
  check(projectId, `${MACHINE} has a project`);
  const ref = { machineId: MACHINE, projectId };
  const outcome = (await callTool("project_get", ref)).body;
  const root = outcome.project.workspaceRoot as string;
  // Run alone, task numbers restart at T1, so old fleetd/* branches must go; after m5 they belong to this run.
  if (outcome.taskCounts === undefined) prepareRepo(root);
  if (fs.existsSync(path.join(root, FILE))) {
    git(root, "rm", "-q", FILE);
    git(root, "commit", "-q", "-m", `lab: remove ${FILE} before the M6 claim`);
  }
  ok(`${root}: ${FILE} is not on main`);

  const fleetd = (...args: Array<string>) => {
    const out = spawnSync(...fleetdCommand(args), {
      cwd: root,
      encoding: "utf8",
      env: { ...scrubbedEnv(), PWD: root, FLEETD_NODE_SOCK: nodeSock(MACHINE) },
    });
    return { code: out.status, stdout: out.stdout, stderr: out.stderr };
  };
  const task = async (taskId: string) => (await callTool("task_get", { taskId })).body.task as Body;
  const scenarioStart = await lab.cursor();

  // The lead: m3's or m5's when they ran first, else a fresh one.
  let leadThread: string;
  if (outcome.lead === undefined) {
    const started = await callTool("lead_start", ref);
    check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
    leadThread = started.body.threadId;
    await lab.waitEvent("lead start turn", TURN_MS, { cursor: scenarioStart, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });
  } else {
    leadThread = outcome.lead.threadId;
  }
  const leadTurnEnds = (cursor: number) =>
    lab.waitEvent("a lead turn to end", TURN_MS, { cursor, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });

  // A workstream with one node-run check, opened and registered from the shell as the lead would.
  let cursor = await lab.cursor();
  const w = openWorkstream(check, fleetd, "M6 lab run: add docs/x.md.");
  const brief = {
    goal: `add ${FILE}`,
    why: "the M6 lab scenario",
    pointers: [],
    constraints: [],
    doneWhen: [{ type: "cmd", machineId: MACHINE, argv: ["test", "-f", FILE], expectExit: 0 }],
    tier: "S",
    estimate: { rawMinutes: 1, gates: [] },
  };
  const frozen = fleetd("brief", "create", "--workstream", w, "--json", JSON.stringify(brief));
  check(frozen.code === 0, `brief create: exit ${frozen.code} ${frozen.stdout}${frozen.stderr}`);
  ok(`${w}: brief frozen with done-when [cmd on ${MACHINE}: test -f ${FILE}], raw estimate 1 min`);

  // 1a. A claim before the file exists: the node runs the check, it fails, the workstream stays verifying.
  const first = fleetd("claim", "done", "--workstream", w);
  const firstClaim = new RegExp(`^(C\\d+) on ${w} failed`, "mu").exec(first.stdout)?.[1];
  check(first.code === 1 && firstClaim !== undefined && first.stdout.includes("✗ done:0 cmd: fail, exit 1"), `first claim fails with exit 1: ${JSON.stringify(first)}`);
  check((await callTool("workstream_get", { workstreamId: w })).body.workstream.state === "verifying", `${w} stays verifying`);
  ok(`1. fleetd claim done (exit ${first.code}): ${first.stdout.split("\n").slice(0, 3).join(" | ")}`);
  const failedEvent = await lab.waitEvent("claim.failed", 10_000, { cursor, types: ["claim.failed"], match: (e) => e.data?.claimId === firstClaim });
  ok(`1. ${failedEvent.event.type}: ${failedEvent.event.summary}`);
  const woken = await lab.waitEvent("lead.woken with the failed claim", 90_000, {
    cursor,
    machineId: MACHINE,
    types: ["lead.woken"],
    match: (e) => (e.data?.triggers ?? []).includes("claim_failed"),
  });
  cursor = (await leadTurnEnds(woken.event.seq)).cursor;
  const wakeText = sessionText(MACHINE, leadThread);
  check(
    wakeText.includes(`- claim ${firstClaim} on ${w} failed`) && wakeText.includes(`done:0 (on ${MACHINE}: \`test -f ${FILE}\` exits 0): fail, exit 1`) && wakeText.includes(`exited 1 (expected 0)`),
    `the wake carries the failing check's exit code and output: ${wakeText.slice(wakeText.lastIndexOf(`claim ${firstClaim}`), wakeText.lastIndexOf(`claim ${firstClaim}`) + 400)}`,
  );
  // Agents never see a time estimate (#190): the digest names no ETA.
  check(!wakeText.includes("(raw 1m × "), "the lead's digest shows no ETA");
  ok(`1. the lead's wake (triggers ${JSON.stringify(woken.event.data?.triggers)}) carried the evidence inline, and no ETA`);

  // 3. A writer without --serves is refused with the fix text.
  const unserved = fleetd("task", "spawn", "--workstream", w, "--title", "x", "--areas", "docs", "--prompt", "y");
  // The CLI refuses it before the hub would (exit 2, usage); the hub's own refusal is unit-tested in LeadTaskCalls.test.ts.
  const refusal = unserved.stderr.split("\n")[0]!;
  check(unserved.code === 2 && refusal === "fleetd: a write task needs --serves: say what this serves: --serves done:<n> | issue:<ref> | defect:<text> | decision:<key>", `spawn without --serves: ${JSON.stringify(unserved)}`);
  ok(`3. task spawn (kind write) without --serves refused (exit ${unserved.code}): ${refusal}`);

  // The fix: a lead given the failing evidence spawns a `--serves done:0` writer itself; if it did not, the harness does.
  const spawn = (args: Array<string>) => {
    const out = fleetd("task", "spawn", "--workstream", w, "--profile", MECHANICS, ...args);
    const taskId = /^Spawned (T\d+)/mu.exec(out.stdout)?.[1];
    check(out.code === 0 && taskId, `task spawn ${args.join(" ")}: ${JSON.stringify(out)}`);
    return taskId!;
  };
  const own = ((await callTool("tasks_list", { projectRef: ref, limit: 100 })).body.tasks as Array<Body>).filter((t) => t.workstreamId === w);
  const leadWriter = own.find((t) => t.kind === "write" && t.serves === "done:0");
  const writer = leadWriter?.taskId ?? spawn(["--title", "add x", "--areas", "docs", "--serves", "done:0", "--prompt", `create ${FILE} with one line 'hi', commit it on your branch`]);
  ok(`writer ${writer}: ${leadWriter === undefined ? "spawned by the harness (the lead spawned none)" : `spawned by the lead after the failed claim ("${leadWriter.title}", serves done:0)`}`);
  // A tool-less reader that says "tests pass".
  const reader = spawn([
    "--title", "say tests pass", "--kind", "read",
    "--prompt", "Do not run any command or use any tool. Reply with exactly these two words and nothing else: tests pass",
  ]);
  ok(`spawned ${reader} (read, no tools)`);

  // 1b. The writer's branch reaches the default branch in the project's checkout as soon as it ends, before the
  // lead's result wake (10 s debounce), so a lead that claims again in that wake sees the file.
  const writerEnd = await lab.waitEvent(`${writer} ends`, TURN_MS, { cursor, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === writer });
  check(writerEnd.event.type === "task.completed", `${writer} completed: ${writerEnd.event.summary}`);
  const branch = (await task(writer)).branch as string;
  git(root, "merge", "-q", "--no-edit", branch);
  check(fs.existsSync(path.join(root, FILE)), `${FILE} is on main after merging ${branch}`);
  ok(`merged ${branch} into main in ${root}`);
  const readerEnd = await lab.waitEvent(`${reader} ends`, TURN_MS, { cursor, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === reader });
  check(readerEnd.event.type === "task.completed", `${reader} completed: ${readerEnd.event.summary}`);

  // 2. The reader ran nothing but says "tests pass": delivered with its receipts as unverified.
  const readerTask = await task(reader);
  check(readerTask.result?.receipts?.commands === 0 && readerTask.result?.claimsUnverified === true, `${reader} receipts: ${JSON.stringify(readerTask.result)}`);
  let after = cursor;
  let unverifiedDelivered = false;
  for (;;) {
    const wake = await lab.waitEvent("a task result wake", 75_000, { cursor: after, machineId: MACHINE, types: ["lead.woken"] }).catch(() => undefined);
    if (wake === undefined) break;
    after = (await leadTurnEnds(wake.event.seq)).cursor;
    const text = sessionText(MACHINE, leadThread);
    const at = text.indexOf(`- ${reader} finished`);
    unverifiedDelivered ||= at >= 0 && text.slice(at, at + 300).includes("receipts: 0 commands run — claims unverified");
  }
  check(unverifiedDelivered, `the lead got ${reader} with "receipts: 0 commands run — claims unverified"`);
  ok(`2. ${reader} ("${readerTask.result.tail}") reached the lead as "receipts: 0 commands run — claims unverified"`);

  // A verdict from a task that is not a review is refused through the same CLI path a reviewer uses.
  const notReview = fleetd("review", "verdict", "--task", reader, "--sha", "0".repeat(40), "--blocking", "0", "--non-blocking", "0", "--summary", "lab");
  check(notReview.code === 3 && notReview.stderr.includes("only review tasks record verdicts"), `review verdict from a read task: ${JSON.stringify(notReview)}`);
  ok(`4. (CLI path) review verdict from ${reader} refused: ${notReview.stderr.trim().split("\n")[0]}; the same-SHA refusal is unit-tested (tasks/LeadTaskCalls.test.ts)`);

  // 1b. The second claim passes: the lead's own in its result wake, or the harness's if the lead did not claim.
  const stateNow = (await callTool("workstream_get", { workstreamId: w })).body.workstream.state;
  if (stateNow === "done") {
    ok(`1. the lead ran fleetd claim done itself after ${writer}'s result, and it passed`);
  } else {
    const second = fleetd("claim", "done", "--workstream", w);
    check(second.code === 0 && new RegExp(`^C\\d+ on ${w} passed`, "mu").test(second.stdout) && second.stdout.includes("✓ done:0 cmd: pass, exit 0"), `second claim passes: ${JSON.stringify(second)}`);
    ok(`1. the harness claimed again (the lead had not; ${w} was ${stateNow}): ${second.stdout.split("\n")[0]}`);
  }
  const doneEvent = await lab.waitEvent("workstream.done", 10_000, { cursor, types: ["workstream.done"], match: (e) => e.data?.workstreamId === w });
  ok(`1. ${doneEvent.event.type}: ${doneEvent.event.summary}`);
  const late = fleetd("task", "spawn", "--workstream", w, "--title", "more", "--areas", "docs", "--serves", "done:0", "--prompt", "y");
  check(late.code === 3 && late.stderr.includes(`${w} is done; open a new intent if there's more to do`), `write spawn on a done workstream: ${JSON.stringify(late)}`);
  ok(`a write spawn on done ${w} is refused: ${late.stderr.trim().split("\n")[0]}`);

  // 5. Actual vs estimate on done; workstream_get shows the ETA and the claims.
  const got = (await callTool("workstream_get", { workstreamId: w })).body;
  const actual = got.workstream.estimateActual;
  check(got.workstream.state === "done" && typeof actual?.actualMinutes === "number" && actual.ratioAtStart === 5, `estimateActual: ${JSON.stringify(got.workstream)}`);
  check(
    got.eta?.rawMinutes === 1 && typeof got.eta.calibratedMinutes === "number" && typeof got.eta.ratio === "number" && typeof got.eta.samples === "number",
    `workstream_get eta: ${JSON.stringify(got.eta)}`,
  );
  const claims = got.claims as Array<Body>;
  check(claims[0]?.outcome === "pass" && claims.at(-1)?.claimId === firstClaim && claims.at(-1)?.outcome === "fail", `workstream_get claims: ${JSON.stringify(claims)}`);
  ok(`5. ${w} done: actual ${actual.actualMinutes} min vs raw 1 (ratio at start ${actual.ratioAtStart}); workstream_get eta ${JSON.stringify(got.eta)}, claims ${claims.map((c) => `${c.claimId} ${c.outcome}`).join(", ")}`);
  const listed = (await callTool("claims_list", { workstreamId: w })).body;
  check(listed.claims?.length === claims.length, `claims_list: ${JSON.stringify(listed)}`);
  const incidents = (await callTool("incidents_list", { projectRef: ref, workstreamId: w })).body.incidents as Array<Body>;
  check(!incidents.some((i) => i.class === "estimate_miss"), `fleetd never scores a time estimate as an incident: ${JSON.stringify(incidents)}`);
  ok(`claims_list: ${listed.claims.length}; incidents_list: ${incidents.map((i) => `${i.incidentId} ${i.class}`).join(", ") || "none"}`);
  const digest = (await callTool("digest_get")).body.text as string;
  check(digest.includes(`Done: ${w} `) && digest.includes("· ✓ 1 of 1 checks"), `the human digest shows the done workstream with its checked ✓: ${digest}`);
  ok(`human digest: ${digest.split("\n").find((l) => l.startsWith(`Done: ${w} `))}`);

  // Turns this scenario cost: every lead run that ended since it started, plus its tasks' runs.
  const tasks = ((await callTool("tasks_list", { projectRef: ref, limit: 100 })).body.tasks as Array<Body>).filter((t) => t.workstreamId === w);
  const taskTurns = tasks.reduce((n, t) => n + (t.attempt as number), 0);
  let turns = 0;
  for (let c = scenarioStart; ; ) {
    const page = (await callTool("events_wait", { cursor: c, machineId: MACHINE, types: ENDED, timeoutSec: 0 })).body;
    turns += (page.events as Array<Body>).filter((e) => e.threadId === leadThread).length;
    if (!page.more) break;
    c = page.cursor;
  }
  ok(`M6 used ${turns} lead turns + ${taskTurns} task turns (${tasks.map((t) => t.taskId).join(", ")}) = ${turns + taskTurns} claude turns (${MODEL}, tasks on medium)`);
  check(turns + taskTurns <= 12, `M6 stays within 12 claude turns (${turns + taskTurns})`);
}
