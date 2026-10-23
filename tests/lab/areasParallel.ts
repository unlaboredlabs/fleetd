// Default areas (`npm run lab -- areas`), on lab-a in this slot's namespace of the lab repo, whose seed has
// packages/alpha and packages/beta. The policy file sets no `areas`, so the hub infers `alpha`, `beta` and `all` from
// the repo: project_add shows them as inferred, `fleetd doctor` lists them, and two writers, one per package, run
// at the same time instead of queueing on one area. Costs a lead start turn, its wakes and two writer turns.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Body, fleetdCommand, type Lab, MECHANICS, nodeSock, requireGhLogin, scrubbedEnv } from "./harness.ts";
import { checkClone, CLONE, NAMESPACE, prepareCheckout, removeLabRepoProject, resetNamespace } from "./m7Train.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
// No `areas`: the inferred ones apply.
const POLICY = ``;

export async function areasParallel(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  requireGhLogin();
  checkClone(check);
  resetNamespace();
  prepareCheckout(POLICY);
  check(fs.existsSync(path.join(CLONE, "packages/alpha")) && fs.existsSync(path.join(CLONE, "packages/beta")), `the seed has packages/alpha and packages/beta (run node tests/lab/labRepo.ts)`);
  const scenarioStart = await lab.cursor();
  try {
    const addedFrom = await lab.cursor();
    const projectId = await lab.addProject(MACHINE, CLONE, "fleetd-lab");
    const ref = { machineId: MACHINE, projectId };
    const added = await lab.waitEvent("project.added", 30_000, { cursor: addedFrom, types: ["project.added"], match: (e) => e.projectId === projectId });
    const inspect = added.event.data?.inspect as Body | undefined;
    const areas = inspect?.areas as Array<string> | undefined;
    check(inspect?.areasInferred === true && ["all", "alpha", "beta"].every((a) => areas?.includes(a)), `project_add infers the areas: ${JSON.stringify(inspect)}`);
    ok(`project_add: areas ${areas!.join(", ")} (inferred from the repo)`);
    const doctor = (await callTool("doctor_list", { rerun: true })).body;
    const line = ((doctor.checks ?? []) as Array<Body>).find((c) => c.id === `${MACHINE}/areas`)?.message as string | undefined;
    check(line?.includes("fleetd-lab: ") && line.includes("alpha") && line.includes("(inferred from the repo"), `doctor lists the inferred areas: ${line}`);
    ok(`doctor: ${line}`);

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
    const intake = await callTool("intake_submit", {
      ...ref,
      text: "Lab run: two writers, one per package. The harness spawns them; reply to each wake with one short line, run no commands.",
      clientRequestId: randomUUID(),
    });
    check(!intake.isError, `intake_submit: ${JSON.stringify(intake.body)}`);
    const w = intake.body.workstreamId as string;
    const brief = { goal: "two writers in two areas at once", why: "the default areas lab scenario", pointers: [], constraints: [], doneWhen: [{ type: "cmd", machineId: MACHINE, argv: ["true"], expectExit: 0 }], tier: "S", estimate: { rawMinutes: 5, gates: [] } };
    const frozen = fleetd("brief", "create", "--workstream", w, "--json", JSON.stringify(brief));
    check(frozen.code === 0, `brief create ${w}: ${JSON.stringify(frozen)}`);

    // Each writer stays busy long enough for the other to start, and changes nothing.
    const cursor = await lab.cursor();
    const spawn = (area: string) => {
      const out = fleetd(
        "task", "spawn", "--workstream", w, "--title", `wait in ${area}`, "--areas", area, "--profile", MECHANICS,
        "--prompt", "Run the shell command `sleep 30`, then reply with one word: ok. Change, commit and push nothing.",
      );
      const taskId = /^Spawned (T\d+)/mu.exec(out.stdout)?.[1];
      check(out.code === 0 && taskId, `task spawn in ${area}: ${JSON.stringify(out)}`);
      return taskId!;
    };
    const tasks = [spawn("alpha"), spawn("beta")];
    const startedEvents = await Promise.all(
      tasks.map((t) => lab.waitEvent(`${t} starts`, 120_000, { cursor, types: ["task.started", "task.queued"], match: (e) => e.data?.taskId === t && e.type === "task.started" })),
    );
    const ends = await Promise.all(tasks.map((t) => lab.waitEvent(`${t} ends`, TURN_MS, { cursor, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === t })));
    const lastStart = Math.max(...startedEvents.map((s) => s.event.seq as number));
    const firstEnd = Math.min(...ends.map((e) => e.event.seq as number));
    check(lastStart < firstEnd, `both writers ran at once: last start #${lastStart}, first end #${firstEnd}`);
    const queued = await callTool("events_wait", { cursor, machineId: MACHINE, types: ["task.queued"], timeoutSec: 0 });
    const leaseWaits = (queued.body.events as Array<Body>).filter((e) => tasks.includes(e.data?.taskId) && String(e.data?.queuedReason ?? e.summary).includes("lease"));
    check(leaseWaits.length === 0, `no writer waited on a lease: ${JSON.stringify(leaseWaits)}`);
    ok(`${tasks[0]} (alpha) and ${tasks[1]} (beta) ran at the same time: both started (#${startedEvents.map((s) => s.event.seq).join(", #")}) before either ended (#${firstEnd}); no lease wait`);
  } finally {
    resetNamespace();
    await removeLabRepoProject(lab).catch((error: unknown) => lab.log(`could not remove the lab repo project: ${String(error)}`));
    fs.rmSync(path.join(CLONE, ".fleetd"), { recursive: true, force: true });
    lab.log(`namespace ${NAMESPACE} reset`);
  }
}
