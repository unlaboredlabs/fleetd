// Max efficiency without compromising (`npm run lab eff`), end to end on lab-a.
// A pushed slice gets a reviewer before the next slice: a writer in this slot's namespace of the lab repo opens two PRs and
// reports each with `report` (kind slice_ready); the first PR's reviewer starts before the second PR reaches the train,
// while the writer still runs. Gates hold: neither PR is ready without its review.
// Costs a few lead turns, one writer and its reviewers.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Body, MECHANICS, openWorkstream, fleetdCommand, type Lab, nodeSock, requireGhLogin, scrubbedEnv } from "./harness.ts";
import { BASE, BRANCH_PREFIX, CLONE, checkClone, NAMESPACE, onBase, prepareCheckout, REPO, removeLabRepoProject, resetNamespace } from "./m7Train.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];

const shell = (root: string) => (...args: Array<string>) => {
  const out = spawnSync(...fleetdCommand(args), {
    cwd: root,
    encoding: "utf8",
    env: { ...scrubbedEnv(), PWD: root, FLEETD_NODE_SOCK: nodeSock(MACHINE) },
  });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
};

/** Every event of `types` since `cursor`, in order. */
const eventsSince = async (lab: Lab, cursor: number, types: ReadonlyArray<string>) => {
  const out: Array<Body> = [];
  for (;;) {
    const page = (await lab.callTool("events_wait", { cursor, machineId: MACHINE, types, timeoutSec: 0 })).body;
    out.push(...(page.events as Array<Body>));
    if (!page.more) return out;
    cursor = page.cursor;
  }
};

export async function efficiency(lab: Lab) {
  await lab.waitLive(MACHINE);
  await sliceReviews(lab);
}

async function sliceReviews(lab: Lab) {
  const { callTool, check, ok } = lab;
  requireGhLogin();
  check(NAMESPACE.startsWith("slot/"), `eff needs CI: run it in a slot/<n> namespace, not ${NAMESPACE}`);
  checkClone(check);
  resetNamespace();
  const dir = `lab/eff-${new Date().toISOString().slice(0, 19).replace(/\D/gu, "")}`;
  prepareCheckout("");
  try {
    const projectId = await lab.addProject(MACHINE, CLONE, "fleetd-lab");
    const ref = { machineId: MACHINE, projectId };
    const fleetd = shell(CLONE);
    let cursor = await lab.cursor();
    const started = await callTool("lead_start", ref);
    check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
    const leadThread = started.body.threadId as string;
    await lab.waitEvent("lead start turn", TURN_MS, { cursor, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });

    const w = openWorkstream(check, fleetd, "Two docs slices.");
    const onMain = (file: string) => ({ type: "cmd", machineId: MACHINE, argv: ["gh", "api", onBase(file), "--silent"], expectExit: 0 });
    const brief = { goal: `two slices: ${dir}/one.md and ${dir}/two.md`, why: "the eff lab scenario", pointers: [], constraints: [], tier: "M", doneWhen: [onMain(`${dir}/one.md`), onMain(`${dir}/two.md`)] };
    const frozen = fleetd("brief", "create", "--workstream", w, "--json", JSON.stringify(brief));
    check(frozen.code === 0, `brief create ${w}: ${JSON.stringify(frozen)}`);

    // One writer, two slices, each reported as soon as its PR is open.
    const slice = (n: string, line: string) =>
      `On a new branch ${BRANCH_PREFIX}eff-${n} from origin/${BASE} (git fetch origin; git checkout -b ${BRANCH_PREFIX}eff-${n} origin/${BASE}), create ${dir}/${n}.md containing exactly the line ${line}, commit it, push the branch, and open a PR with gh pr create --base ${BASE} --head ${BRANCH_PREFIX}eff-${n} --title "eff ${n}" --body "eff ${n}". Then call the report tool with kind "slice_ready" and prUrl set to that PR's URL.`;
    cursor = await lab.cursor();
    const spawned = fleetd(
      "task", "spawn", "--workstream", w, "--title", "two slices", "--profile", MECHANICS,
      "--prompt", `Do these two steps in order. 1. ${slice("one", "one")} 2. ${slice("two", "two")} Reply with both PR URLs.`,
    );
    const writer = /^Spawned (T\d+)/mu.exec(spawned.stdout)?.[1];
    check(spawned.code === 0 && writer, `task spawn: ${JSON.stringify(spawned)}`);
    const ended = await lab.waitEvent(`${writer} ends`, TURN_MS * 2, { cursor, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === writer });

    // The order of what happened: the first slice queued, its reviewer started, then the second slice queued.
    const seen = await eventsSince(lab, cursor, ["change.queued", "task.queued", "task.started"]);
    const queued = seen.filter((e) => e.type === "change.queued" && e.data?.workstreamId === w);
    check(queued.length >= 2, `both slices reached the train: ${JSON.stringify(queued.map((e) => e.summary))}`);
    const [first, second] = queued;
    const firstUrl = `https://github.com/${REPO}/pull/${first!.data.prNumber}`;
    const reviewer = ((await callTool("tasks_list", { projectRef: ref, limit: 50 })).body.tasks as Array<Body>).find((t) => t.kind === "review" && t.pr === firstUrl);
    check(reviewer, `${firstUrl} got a reviewer`);
    const reviewerStart = seen.find((e) => ["task.queued", "task.started"].includes(e.type) && e.data?.taskId === reviewer!.taskId);
    check(reviewerStart && reviewerStart.seq < second!.seq && second!.seq < ended.event.seq, `reviewer ${reviewer!.taskId} (seq ${reviewerStart?.seq}) before slice two (seq ${second!.seq}), both before ${writer} ended (seq ${ended.event.seq})`);
    ok(`B. ${firstUrl} queued (seq ${first!.seq}), reviewer ${reviewer!.taskId} ${reviewerStart!.type} (seq ${reviewerStart!.seq}), slice two queued (seq ${second!.seq}), writer ended (seq ${ended.event.seq})`);

    // Gates hold: a slice is ready only with its review in.
    const changes = (await callTool("changes_list", { projectRef: ref, limit: 50 })).body.changes as Array<Body>;
    for (const c of changes.filter((c) => c.workstreamId === w && ["ready", "rebasing", "ci", "merging", "merged"].includes(c.state))) {
      check((c.reviews as Array<Body>).length >= 1, `${c.changeId} is ${c.state} only with a review: ${JSON.stringify(c.reviews)}`);
    }
    ok("B. no slice got past review without one");
    for (const t of (await callTool("tasks_list", { projectRef: ref, limit: 50 })).body.tasks as Array<Body>) {
      if (["queued", "running", "idle"].includes(t.state)) fleetd("task", "cancel", t.taskId);
    }
  } finally {
    // Only this slot's namespace, never the repo's main.
    resetNamespace();
    await removeLabRepoProject(lab).catch((error: unknown) => lab.log(`could not remove the lab repo project: ${String(error)}`));
    fs.rmSync(path.join(CLONE, ".fleetd"), { recursive: true, force: true });
  }
}
