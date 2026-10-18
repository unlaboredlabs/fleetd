// M7 "done when" 1-5 on lab-a against the public testbed unlaboredlabs/fleetd-testbed (CI fails iff a file FAIL exists;
// main requires the `ci` check and the `fleetd/train` status). The lab clone becomes a second project on lab-a,
// with its policy file kept untracked, so nothing but the train ever lands on main. With the train frozen by a
// Decision, two M-tier writers (areas alpha, beta, files under this run's lab/<time>/) open PRs and get one reviewer each; then two S-tier writers open a
// PR that conflicts with alpha's and one that adds FAIL. A harness PR without `Source:` is refused at enqueue. Thawed
// with train_freeze, the train merges alpha and beta in order (the second rebased onto the first's merge), sends the
// conflict back to its author, who resolves it and gets merged, and sends red CI back to its author, never merging
// it. Lead, writers and reviewers are haiku at low effort; the harness's `fleetd` calls cost no turns.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Body, fleetdCommand, LAB, type Lab, MODEL, nodeSock, requireGhLogin, scrubbedEnv, sessionText, SLOT } from "./harness.ts";

const MACHINE = "lab-a";
// One testbed repo per lab slot, so slots run the train in parallel: slots 0 and 9 (the demo) share the original,
// slot N uses fleetd-testbed-N. FLEETD_TESTBED overrides; tests/lab/testbed.ts creates a missing one.
export const REPO =
  process.env.FLEETD_TESTBED ?? (SLOT === 0 || SLOT === 9 ? "unlaboredlabs/fleetd-testbed" : `unlaboredlabs/fleetd-testbed-${SLOT}`);
export const TESTBED = path.join(LAB, "testbed");
const TURN_MS = 240_000;
const CI_MS = 600_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
const FREEZE_KEY = `policy.freeze.${REPO.replace("/", ".")}`;
/** Branch prefixes this scenario pushes to the testbed, cleaned up before and after. */
const OURS = ["fleetd/", "lab-m7/"];
// Each run writes under its own directory, since main keeps what earlier runs merged.
const DIR = `lab/${new Date().toISOString().slice(0, 19).replace(/\D/gu, "")}`;
const ALPHA = `${DIR}/alpha.md`;
const BETA = `${DIR}/beta.md`;
// Kept untracked (.git/info/exclude): the hub reads it from the checkout, and nothing but the train lands on main.
// gamma overlaps alpha on purpose, so its writer runs at the same time and conflicts with it. CI looks for FAIL at the root.
const POLICY = `areas:
  alpha: ["${ALPHA}"]
  beta: ["${BETA}"]
  gamma: ["${ALPHA}"]
  ci: ["FAIL"]
defaults:
  model: ${MODEL}
  effort: low
`;

const run = (cmd: string, args: ReadonlyArray<string>, cwd = TESTBED) =>
  execFileSync(cmd, args, { cwd, env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const git = (...args: Array<string>) => run("git", args);
// Outside the clone, so `--delete-branch` deletes only the remote branch, never a task's checked-out local one.
const gh = (...args: Array<string>) => run("gh", args, LAB);
const ghJson = <A = Body>(...args: Array<string>): A => JSON.parse(gh(...args)) as A;

/** Open PRs and remote branches an earlier run of this scenario left on the testbed; never main. */
export const cleanTestbed = () => {
  for (const pr of ghJson<Array<Body>>("pr", "list", "-R", REPO, "--state", "open", "--json", "number,headRefName")) {
    if (OURS.some((p) => (pr.headRefName as string).startsWith(p))) gh("pr", "close", String(pr.number), "-R", REPO, "--delete-branch");
  }
  const branches = ghJson<Array<Body>>("api", `repos/${REPO}/branches?per_page=100`).map((b) => b.name as string);
  for (const branch of branches) {
    if (branch === "main" || !OURS.some((p) => branch.startsWith(p))) continue;
    // GitHub may delete a merged or closed PR's branch between the listing and here; gone is what we want.
    const out = spawnSync("gh", ["api", "-X", "DELETE", `repos/${REPO}/git/refs/heads/${branch}`], { cwd: LAB, env: scrubbedEnv(), encoding: "utf8" });
    if (out.status !== 0 && !/Reference does not exist|Not Found|HTTP 422/u.test(out.stderr)) throw new Error(`deleting ${branch}: ${out.stderr.trim()}`);
  }
};

/** The lab clone at origin/main, without task worktrees or branches from an earlier run, and with the policy file. */
export const prepareCheckout = (policy = POLICY) => {
  git("fetch", "-q", "--prune", "origin");
  // An earlier run's machine homes, and the task worktrees in them, are gone; git forgets those first.
  git("worktree", "prune");
  for (const entry of git("worktree", "list", "--porcelain").split("\n\n")) {
    const wt = /^worktree (.+)$/mu.exec(entry)?.[1];
    if (wt !== undefined && /^branch refs\/heads\/fleetd\//mu.test(entry)) git("worktree", "remove", "--force", wt);
  }
  git("worktree", "prune");
  git("checkout", "-q", "--force", "main");
  git("reset", "-q", "--hard", "origin/main");
  for (const branch of git("branch", "--list", "fleetd/*", "lab-m7/*", "--format=%(refname:short)").split("\n").filter(Boolean)) git("branch", "-D", branch);
  const exclude = path.join(TESTBED, ".git/info/exclude");
  if (!fs.readFileSync(exclude, "utf8").includes(".fleetd/")) fs.appendFileSync(exclude, "\n.fleetd/\n");
  fs.mkdirSync(path.join(TESTBED, ".fleetd"), { recursive: true });
  fs.writeFileSync(path.join(TESTBED, ".fleetd/policy.yaml"), policy);
};

/** Removes lab-a's testbed project if one is registered, so scenarios that take lab-a's project find repo-a. */
export const removeTestbedProject = async (lab: Pick<Lab, "callTool">) => {
  const listed = (await lab.callTool("projects_list", { machineId: MACHINE })).body.projects as Array<Body>;
  for (const p of listed.filter((p) => p.workspaceRoot === TESTBED)) {
    const removed = await lab.callTool("project_remove", { machineId: MACHINE, projectId: p.projectId });
    if (removed.isError) throw new Error(`project_remove ${p.projectId}: ${JSON.stringify(removed.body)}`);
  }
};

export async function m7Train(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  requireGhLogin();
  const setup = `node tests/lab/testbed.ts --repo ${REPO} --clone ${TESTBED}`;
  check(fs.existsSync(path.join(TESTBED, ".git")), `${TESTBED} is a clone of ${REPO} (run ${setup})`);
  const origin = git("remote", "get-url", "origin");
  check(origin.replace(/\.git$/u, "").endsWith(REPO), `${TESTBED} is a clone of ${origin}, not ${REPO} (move it aside and run ${setup})`);
  cleanTestbed();
  prepareCheckout();
  ok(`${TESTBED} at origin/main ${git("rev-parse", "--short", "HEAD")}; untracked .fleetd/policy.yaml (alpha, beta, gamma, ci); no fleetd/* branches on ${REPO}`);

  const scenarioStart = await lab.cursor();
  const opened: Array<number> = [];
  try {
    // The testbed as a second project on lab-a.
    const projectId = await lab.addProject(MACHINE, TESTBED, "fleetd-testbed");
    const ref = { machineId: MACHINE, projectId };
    ok(`project_add: ${projectId} on ${MACHINE} at ${TESTBED}`);

    const fleetd = (...args: Array<string>) => {
      const out = spawnSync(...fleetdCommand(args), {
        cwd: TESTBED,
        encoding: "utf8",
        env: { ...scrubbedEnv(), PWD: TESTBED, FLEETD_NODE_SOCK: nodeSock(MACHINE) },
      });
      return { code: out.status, stdout: out.stdout, stderr: out.stderr };
    };
    const change = async (changeId: string) => ((await callTool("changes_list", { projectRef: ref, limit: 100 })).body.changes as Array<Body>).find((c) => c.changeId === changeId)!;
    const task = async (taskId: string) => (await callTool("task_get", { taskId })).body.task as Body;

    const started = await callTool("lead_start", { ...ref, model: MODEL, effort: "low" });
    check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
    const leadThread = started.body.threadId as string;
    await lab.waitEvent("lead start turn", TURN_MS, { cursor: scenarioStart, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });
    ok(`lead ${leadThread} started`);

    // Two workstreams, briefs registered from the shell as the lead would, before the intent wakes fire.
    const workstream = async (text: string, brief: Body) => {
      const intake = await callTool("intake_submit", { ...ref, text, clientRequestId: randomUUID() });
      check(!intake.isError, `intake_submit: ${JSON.stringify(intake.body)}`);
      const w = intake.body.workstreamId as string;
      const frozen = fleetd("brief", "create", "--workstream", w, "--json", JSON.stringify({ pointers: [], constraints: [], estimate: { rawMinutes: 5, gates: [] }, ...brief }));
      check(frozen.code === 0, `brief create ${w}: ${JSON.stringify(frozen)}`);
      return w;
    };
    const quiet = "Lab run: the harness spawns every task; reply to each wake with one short line, run no commands.";
    // One check per PR, so each reviewer judges its PR against its own check. Node-run checks: a claim costs no turns.
    const onMain = (file: string) => ["gh", "api", `repos/${REPO}/contents/${file}`, "--silent"];
    const cmd = (argv: Array<string>) => ({ type: "cmd", machineId: MACHINE, argv, expectExit: 0 });
    const wm = await workstream(`${quiet} Add alpha.md and beta.md in two PRs.`, {
      goal: `two independent PRs: one adds ${ALPHA}, the other adds ${BETA}`,
      why: "the M7 lab scenario",
      doneWhen: [cmd(onMain(ALPHA)), cmd(onMain(BETA))],
      tier: "M",
    });
    const ws = await workstream(`${quiet} Train edge cases.`, {
      goal: `one PR that adds the line gamma to ${ALPHA}, and one that adds FAIL and so must never merge`,
      why: "the M7 lab scenario",
      doneWhen: [
        cmd(["sh", "-c", `gh api repos/${REPO}/contents/${ALPHA} -H 'Accept: application/vnd.github.raw' | grep -qx gamma`]),
        cmd(["sh", "-c", `! gh api repos/${REPO}/contents/FAIL --silent`]),
      ],
      tier: "S",
    });
    ok(`${wm} (tier M) and ${ws} (tier S) running with frozen briefs`);

    // 5a. A freeze Decision before anything is enqueued.
    const freeze = await callTool("decisions_record", { key: FREEZE_KEY, value: "true", why: "M7 lab: hold until every PR is ready", scope: { kind: "project", projectRef: ref } });
    check(!freeze.isError, `decisions_record: ${JSON.stringify(freeze.body)}`);
    ok(`5. ${freeze.body.decision.decisionId} ${FREEZE_KEY} = true`);

    // 4. A PR without a Source: line is refused at enqueue with the fix text.
    git("checkout", "-q", "-b", "lab-m7/no-source", "origin/main");
    fs.writeFileSync(path.join(TESTBED, "no-source.md"), "no source\n");
    git("add", "no-source.md");
    git("commit", "-q", "-m", "lab: a PR without a Source line");
    git("push", "-q", "origin", "HEAD:refs/heads/lab-m7/no-source");
    git("checkout", "-q", "main");
    const bareUrl = gh("pr", "create", "-R", REPO, "--base", "main", "--head", "lab-m7/no-source", "--title", "lab: no Source line", "--body", "Adds a file.");
    const bareNumber = Number(/\/pull\/(\d+)$/u.exec(bareUrl)?.[1]);
    opened.push(bareNumber);
    const refused = fleetd("change", "enqueue", "--pr", bareUrl, "--workstream", wm);
    check(refused.code === 3 && refused.stderr.includes("has no 'Source:' line") && refused.stderr.includes("Next: add 'Source: done:0' to the PR body"), `enqueue without Source: ${JSON.stringify(refused)}`);
    ok(`4. fleetd change enqueue ${bareUrl} refused (exit 3): ${refused.stderr.trim().replace(/\n/gu, " | ")}`);
    gh("pr", "close", String(bareNumber), "-R", REPO, "--delete-branch");

    const spawn = (w: string, area: string, serves: string, title: string, prompt: string) => {
      const out = fleetd("task", "spawn", "--workstream", w, "--title", title, "--areas", area, "--serves", serves, "--model", MODEL, "--effort", "low", "--prompt", prompt);
      const taskId = /^Spawned (T\d+)/mu.exec(out.stdout)?.[1];
      check(out.code === 0 && taskId, `task spawn ${title}: ${JSON.stringify(out)}`);
      lab.log(`spawned ${taskId} (${title}, area ${area}, serves ${serves})`);
      return taskId!;
    };
    const writer = (file: string, line: string, serves: string, after = "") =>
      `Create the file ${file} (from the repo root) containing exactly one line: ${line}. Commit it with the message "add ${file}". Then push your branch and open the pull request as your rules say, with the title "add ${file}" and the body exactly "Source: ${serves}". Reply with the PR URL.${after}`;
    const queued = async (taskId: string, from: number) => {
      const end = await lab.waitEvent(`${taskId} ends`, TURN_MS, { cursor: from, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === taskId });
      check(end.event.type === "task.completed", `${taskId} completed: ${end.event.summary}`);
      const prUrl = (await task(taskId)).result?.prUrl as string | undefined;
      check(prUrl?.startsWith(`https://github.com/${REPO}/pull/`), `${taskId}'s result names its PR: ${JSON.stringify((await task(taskId)).result)}`);
      const q = await lab.waitEvent(`${taskId}'s PR enqueued`, 60_000, { cursor: from, types: ["change.queued"], match: (e) => prUrl!.endsWith(`/pull/${e.data?.prNumber}`) });
      opened.push(q.event.data.prNumber as number);
      return { taskId, prUrl: prUrl!, changeId: q.event.data.changeId as string };
    };

    // 1. Two M-tier writers in different areas.
    let cursor = await lab.cursor();
    const a = spawn(wm, "alpha", "done:0", "add alpha", writer(ALPHA, "alpha", "done:0"));
    const b = spawn(wm, "beta", "done:1", "add beta", writer(BETA, "beta", "done:1"));
    const ca = await queued(a, cursor);
    const cb = await queued(b, cursor);
    ok(`1. ${a} opened ${ca.prUrl} (${ca.changeId}) and ${b} opened ${cb.prUrl} (${cb.changeId}), each auto-enqueued`);
    const frozenEvent = await lab.waitEvent("train.frozen", 60_000, { cursor: scenarioStart, types: ["train.frozen"] });
    ok(`5. ${frozenEvent.event.type}: ${frozenEvent.event.summary}`);

    // 2 and 3. After both, so they come later in train order: a PR conflicting with alpha.md, and one that adds FAIL.
    cursor = await lab.cursor();
    const c = spawn(ws, "gamma", "done:0", "add gamma line", writer(
      ALPHA,
      "gamma",
      "done:0",
      ` If you are later told this PR conflicts: run \`git fetch origin\` and \`git rebase origin/main\`; make ${ALPHA} exactly two lines, \`alpha\` then \`gamma\`; \`git add ${ALPHA}\`; \`GIT_EDITOR=true git rebase --continue\`; \`git push --force-with-lease\`; then reply with one word: resolved.`,
    ));
    const d = spawn(ws, "ci", "done:1", "add FAIL", writer("FAIL", "red", "done:1", " This PR is meant to fail CI. When a later message says CI failed, that is expected: change nothing, push nothing, and reply with exactly one word: acknowledged."));
    const cc = await queued(c, cursor);
    const cd = await queued(d, cursor);
    ok(`${c} opened ${cc.prUrl} (${cc.changeId}, conflicts with ${ALPHA}) and ${d} opened ${cd.prUrl} (${cd.changeId}, adds FAIL)`);

    // 1. Each M PR gets a reviewer that returns blocking: 0; nothing merges while frozen.
    for (const m of [ca, cb]) {
      await lab.waitEvent(`${m.changeId} ready`, TURN_MS * 2, { cursor: scenarioStart, types: ["change.ready"], match: (e) => e.data?.changeId === m.changeId });
      const ready = await change(m.changeId);
      const reviewers = ((await callTool("tasks_list", { projectRef: ref, limit: 100 })).body.tasks as Array<Body>).filter((t) => t.kind === "review" && t.pr === m.prUrl);
      check(reviewers.length === 1 && ready.reviews.length === 1 && ready.reviews[0].taskId === reviewers[0]!.taskId && ready.reviews[0].blocking === 0, `${m.changeId} reviews: ${JSON.stringify({ reviews: ready.reviews, reviewers })}`);
      ok(`1. ${m.changeId} ready: reviewer ${reviewers[0]!.taskId} (spawned by the hub) returned blocking 0 at ${ready.reviews[0].prHeadSha.slice(0, 12)}`);
    }
    for (const s of [cc, cd]) await lab.waitEvent(`${s.changeId} ready`, 120_000, { cursor: scenarioStart, types: ["change.ready"], match: (e) => e.data?.changeId === s.changeId });
    const held = (await callTool("train_get", { repo: REPO })).body.train;
    check(held.frozen === true && held.head === undefined && held.queue.length === 4, `the frozen train holds all four: ${JSON.stringify(held)}`);
    const early = await callTool("events_wait", { cursor: scenarioStart, types: ["pr.merged"], timeoutSec: 0 });
    check(early.body.events.length === 0, `nothing merged while frozen: ${JSON.stringify(early.body.events)}`);
    ok(`5. train_get while frozen: ${JSON.stringify(held)}; no pr.merged`);
    const queuedOrder = held.queue as Array<string>;
    const [first, second] = [ca, cb].sort((x, y) => queuedOrder.indexOf(x.changeId) - queuedOrder.indexOf(y.changeId));
    const secondHeadBefore = (await change(second!.changeId)).headSha as string;

    // 5b. Retiring the decision resumes the train.
    cursor = await lab.cursor();
    const thaw = await callTool("train_freeze", { repo: REPO, frozen: false });
    check(!thaw.isError && thaw.body.train.frozen === false, `train_freeze false: ${JSON.stringify(thaw.body)}`);
    const resumed = await lab.waitEvent("train.resumed", 60_000, { cursor, types: ["train.resumed"] });
    ok(`5. train_freeze {frozen: false} retired the decision; ${resumed.event.type}: ${resumed.event.summary}`);

    // 1. Merged in train order; the second rebased onto the first's merge, each with fleetd/train on its head.
    const mergedOf = async (x: { readonly changeId: string }, ms: number) =>
      (await lab.waitEvent(`pr.merged for ${x.changeId}`, ms, { cursor, types: ["pr.merged"], match: (e) => e.data?.changeId === x.changeId })).event;
    const m1 = await mergedOf(first!, CI_MS);
    const m2 = await mergedOf(second!, CI_MS);
    check(m1.seq < m2.seq, `pr.merged in train order: ${m1.seq} < ${m2.seq}`);
    const merged2 = await change(second!.changeId);
    const parents = ghJson("api", `repos/${REPO}/commits/${merged2.headSha}`).parents.map((p: Body) => p.sha);
    check(merged2.headSha !== secondHeadBefore && parents.includes(m1.data.mergedSha), `${second!.changeId} was rebased onto ${m1.data.mergedSha}: head ${merged2.headSha} (was ${secondHeadBefore}), parents ${parents}`);
    for (const m of [m1, m2]) {
      const head = (await change(m.data.changeId)).headSha as string;
      const statuses = ghJson<Array<Body>>("api", `repos/${REPO}/commits/${head}/statuses`);
      check(statuses.some((s) => s.context === "fleetd/train" && s.state === "success"), `fleetd/train on ${head}: ${JSON.stringify(statuses)}`);
    }
    ok(`1. pr.merged ${first!.changeId} (#${m1.data.prNumber} as ${m1.data.mergedSha.slice(0, 12)}) then ${second!.changeId} (#${m2.data.prNumber}); ${second!.changeId} was rebased to ${merged2.headSha.slice(0, 12)} on top of ${m1.data.mergedSha.slice(0, 12)}; both heads carry fleetd/train=success`);

    // 2. The conflict goes back to its author with the paths; the train moves on.
    const conflict = await lab.waitEvent(`change.needs_rebase for ${cc.changeId}`, CI_MS, { cursor, types: ["change.needs_rebase"], match: (e) => e.data?.changeId === cc.changeId });
    check((conflict.event.data.paths as Array<string>).includes(ALPHA), `needs_rebase names ${ALPHA}: ${JSON.stringify(conflict.event)}`);
    ok(`2. ${conflict.event.type}: ${conflict.event.summary}`);
    // 3. Red CI goes back to its author with the check name; never merged.
    const red = await lab.waitEvent(`change.ci_failed for ${cd.changeId}`, CI_MS, { cursor, types: ["change.ci_failed"], match: (e) => e.data?.changeId === cd.changeId });
    check((red.event.data.checks as Array<string>).includes("ci"), `ci_failed names the ci check: ${JSON.stringify(red.event)}`);
    ok(`3. ${red.event.type}: ${red.event.summary}`);

    const told = async (taskId: string, needles: ReadonlyArray<string>) => {
      const thread = (await task(taskId)).threadRef.threadId as string;
      await lab.until(`${taskId} gets the train's message`, 120_000, async () => {
        if (needles.every((n) => sessionText(MACHINE, thread).includes(n))) return true;
        await callTool("events_wait", { cursor: await lab.cursor(), timeoutSec: 5 });
        return undefined;
      });
    };
    await told(c, ["The merge train could not rebase your PR", ALPHA]);
    ok(`2. ${c} got the task message naming ${ALPHA}`);
    await told(d, ["The merge train did not merge your PR", "ci (failure)"]);
    ok(`3. ${d} was woken with the failing check name: ci (failure)`);

    // 2. The author resolved and pushed; the train merges the new head.
    const m3 = await mergedOf(cc, CI_MS + TURN_MS);
    const mainAlpha = gh("api", `repos/${REPO}/contents/${ALPHA}`, "-H", "Accept: application/vnd.github.raw");
    ok(`2. ${c} resolved the conflict; pr.merged ${cc.changeId} (#${m3.data.prNumber}); ${ALPHA} on main: ${JSON.stringify(mainAlpha)}`);

    // 3. Once the author has acknowledged, the red PR is closed; it was never merged.
    await lab.waitEvent(`${d} ends its second turn`, TURN_MS, { cursor: red.cursor, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === d });
    gh("pr", "close", cd.prUrl, "--delete-branch");
    const redPr = ghJson("pr", "view", cd.prUrl, "--json", "state,mergedAt");
    check(redPr.state === "CLOSED" && redPr.mergedAt === null, `${cd.prUrl} never merged: ${JSON.stringify(redPr)}`);
    const unmerged = await callTool("events_wait", { cursor: scenarioStart, types: ["pr.merged"], timeoutSec: 0 });
    check(!(unmerged.body.events as Array<Body>).some((e) => e.data?.changeId === cd.changeId), "no pr.merged for the red PR");
    ok(`3. ${cd.changeId} stayed ${(await change(cd.changeId)).state}; ${cd.prUrl} closed unmerged`);

    // What the lead, project_get and the human digest show.
    const leadText = sessionText(MACHINE, leadThread);
    check(leadText.includes(`${first!.changeId} merged by the train`), `the lead was woken with ${first!.changeId}'s merge inline`);
    const outcome = (await callTool("project_get", ref)).body;
    check((outcome.trains as Array<Body> | undefined)?.some((t) => t.repo === REPO && t.frozen === false), `project_get trains: ${JSON.stringify(outcome.trains)}`);
    const digest = (await callTool("digest_get")).body.text as string;
    check(digest.includes(`Merged: ${REPO}#${m1.data.prNumber} (${first!.changeId}`), `the human digest lists the merges: ${digest}`);
    ok(`lead woken with "${first!.changeId} merged by the train …"; project_get trains ${JSON.stringify(outcome.trains)}; digest: ${digest.split("\n").filter((l) => l.startsWith("Merged:")).join(" | ")}`);
    const incidents = (await callTool("incidents_list", { projectRef: ref, class: "policy_bypass" })).body.incidents as Array<Body>;
    check(incidents.length === 0, `no policy_bypass incidents: ${JSON.stringify(incidents)}`);

    // Let the last lead wakes run out, then count every turn this scenario cost.
    for (let after = (await lab.cursor()); ; ) {
      const wake = await lab.waitEvent("a late lead wake", 75_000, { cursor: after, machineId: MACHINE, types: ["lead.woken"], match: (e) => e.threadId === leadThread }).catch(() => undefined);
      if (wake === undefined) break;
      after = (await lab.waitEvent("a lead turn to end", TURN_MS, { cursor: wake.event.seq, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) })).cursor;
    }
    const tasks = (await callTool("tasks_list", { projectRef: ref, limit: 100 })).body.tasks as Array<Body>;
    const taskTurns = tasks.reduce((n, t) => n + (t.attempt as number), 0);
    let leadTurns = 0;
    for (let at = scenarioStart; ; ) {
      const page = (await callTool("events_wait", { cursor: at, machineId: MACHINE, types: ENDED, timeoutSec: 0 })).body;
      leadTurns += (page.events as Array<Body>).filter((e) => e.threadId === leadThread).length;
      if (!page.more) break;
      at = page.cursor;
    }
    ok(`M7 used ${leadTurns} lead turns + ${taskTurns} task turns (${tasks.map((t) => `${t.taskId} ${t.kind}×${t.attempt}`).join(", ")}) = ${leadTurns + taskTurns} claude turns (${MODEL}, effort low)`);
    check(leadTurns + taskTurns <= 20, `M7 stays within 20 claude turns (${leadTurns + taskTurns})`);
  } finally {
    // Never main and never the repo: only this run's PRs and branches, the lab project and its policy file.
    for (const n of opened) spawnSync("gh", ["pr", "close", String(n), "-R", REPO, "--delete-branch"], { cwd: LAB, env: scrubbedEnv(), stdio: "ignore" });
    cleanTestbed();
    await removeTestbedProject(lab).catch((error: unknown) => lab.log(`could not remove the testbed project: ${String(error)}`));
    fs.rmSync(path.join(TESTBED, ".fleetd"), { recursive: true, force: true });
  }
}
