// The merge train on a base CI never runs for: one tier-S writer on lab-a in a noci/<n> namespace of the lab repo
// (FLEETD_LAB_NAMESPACE=noci/<n>; the repo's `ci` workflow ignores PRs into noci/**, and noci/*/main requires only the
// `fleetd/train` status). Its PR gets no workflow run, so once the train's no-CI grace passes it merges on fleetd's own
// checks into noci/<n>/main, and `pr.merged` says so. About 3 turns.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Body, MECHANICS, openWorkstream, fleetdCommand, type Lab, nodeSock, requireGhLogin, scrubbedEnv, SLOT } from "./harness.ts";
import { BASE, checkClone, CLONE, NAMESPACE, onBase, prepareCheckout, REPO, removeLabRepoProject, resetNamespace } from "./m7Train.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const MERGE_MS = 600_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
const FILE = `lab/${new Date().toISOString().slice(0, 19).replace(/\D/gu, "")}/noci.md`;
const POLICY = `areas:
  noci: ["${FILE}"]
`;

const gh = (...args: Array<string>) => {
  const out = spawnSync("gh", args, { cwd: path.dirname(CLONE), env: scrubbedEnv(), encoding: "utf8" });
  if (out.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${out.stderr.trim()}`);
  return out.stdout.trim();
};

export async function noCiTrain(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  requireGhLogin();
  check(NAMESPACE.startsWith("noci/"), `noci runs in a noci/<n> namespace (FLEETD_LAB_NAMESPACE=noci/${SLOT}), not ${NAMESPACE}`);
  checkClone(check);
  resetNamespace();
  prepareCheckout(POLICY);
  const scenarioStart = await lab.cursor();
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

    const w = openWorkstream(check, fleetd, `Add ${FILE}.`);
    const brief = {
      goal: `add ${FILE}`,
      why: "the no-CI train lab scenario",
      pointers: [],
      constraints: [],
      doneWhen: [{ type: "cmd", machineId: MACHINE, argv: ["gh", "api", onBase(FILE), "--silent"], expectExit: 0 }],
      tier: "S",
      estimate: { rawMinutes: 5, gates: [] },
    };
    const frozen = fleetd("brief", "create", "--workstream", w, "--json", JSON.stringify(brief));
    check(frozen.code === 0, `brief create ${w}: ${JSON.stringify(frozen)}`);

    const cursor = await lab.cursor();
    const spawned = fleetd(
      "task", "spawn", "--workstream", w, "--title", "add noci.md", "--areas", "noci", "--profile", MECHANICS,
      "--prompt",
      `Create the file ${FILE} (from the repo root) containing exactly one line: noci. Commit it with the message "add ${FILE}". Then push your branch and open the pull request as your rules say, with the title "add ${FILE}" and the body exactly "Adds the file.". Reply with the PR URL.`,
    );
    const taskId = /^Spawned (T\d+)/mu.exec(spawned.stdout)?.[1];
    check(spawned.code === 0 && taskId, `task spawn: ${JSON.stringify(spawned)}`);
    const end = await lab.waitEvent(`${taskId} ends`, TURN_MS, { cursor, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === taskId });
    check(end.event.type === "task.completed", `${taskId} completed: ${end.event.summary}`);
    const prUrl = ((await callTool("task_get", { taskId })).body.task as Body).result?.prUrl as string | undefined;
    check(prUrl?.startsWith(`https://github.com/${REPO}/pull/`), `${taskId} names its PR: ${prUrl}`);
    const pr = JSON.parse(gh("pr", "view", prUrl!, "--json", "headRefName,baseRefName")) as Body;
    check(pr.baseRefName === BASE && (pr.headRefName as string).startsWith(`${NAMESPACE}/fleetd/`), `${prUrl} is ${pr.headRefName} into ${pr.baseRefName}, in ${NAMESPACE}`);
    ok(`${taskId} opened ${prUrl}: ${pr.headRefName} into ${BASE}`);

    const queued = await lab.waitEvent(`${taskId}'s PR enqueued`, 60_000, { cursor, types: ["change.queued"], match: (e) => prUrl!.endsWith(`/pull/${e.data?.prNumber}`) });
    const changeId = queued.event.data.changeId as string;
    const merged = await lab.waitEvent(`pr.merged for ${changeId}`, MERGE_MS, { cursor, types: ["pr.merged"], match: (e) => e.data?.changeId === changeId });
    check(merged.event.data.ci === `no CI on ${REPO}: used local checks`, `pr.merged says it used local checks: ${JSON.stringify(merged.event.data)}`);
    const change = ((await callTool("changes_list", { projectRef: ref, limit: 100 })).body.changes as Array<Body>).find((c) => c.changeId === changeId)!;
    const runs = JSON.parse(gh("api", `repos/${REPO}/actions/runs?head_sha=${change.headSha}&per_page=1`)).total_count as number;
    check(runs === 0, `no workflow run for ${change.headSha} into ${BASE}: ${runs}`);
    const statuses = JSON.parse(gh("api", `repos/${REPO}/commits/${change.headSha}/statuses`)) as Array<Body>;
    check(statuses.some((s) => s.context === "fleetd/train" && s.state === "success"), `fleetd/train on ${change.headSha}: ${JSON.stringify(statuses)}`);
    const onMain = gh("api", onBase(FILE), "-H", "Accept: application/vnd.github.raw");
    check(onMain === "noci", `${FILE} on ${BASE}: ${JSON.stringify(onMain)}`);
    ok(`${changeId} merged into ${BASE} as ${String(merged.event.data.mergedSha).slice(0, 12)} with no workflow run: "${merged.event.data.ci}"; fleetd/train=success on its head`);
  } finally {
    resetNamespace();
    // project_remove refuses while the project's sessions are live; then the lab repo project stays for this run only.
    await removeLabRepoProject(lab).catch((error: unknown) => lab.log(`could not remove the lab repo project: ${String(error)}`));
    fs.rmSync(path.join(CLONE, ".fleetd"), { recursive: true, force: true });
  }
}
