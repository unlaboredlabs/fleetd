// M7 "done when" 1-5 on lab-a against the public lab repo unlaboredlabs/fleetd-lab, in this slot's namespace (CI fails
// iff a file FAIL exists; slot/<n>/main requires the `ci` check and the `fleetd/train` status). The lab clone becomes a
// second project on lab-a, with its policy file kept untracked, so nothing but the train ever lands on the base. Every
// writer opens its PR with the `hold` label: two writers (files under this run's lab/<time>/) open PRs; then two more writers open a
// PR that conflicts with alpha's and one that adds FAIL. Every PR gets one reviewer. Once the
// harness takes the labels off, the train merges alpha and beta in order (the second rebased onto the first's merge), sends the
// conflict back to its author, who resolves it and gets merged, and sends red CI back to its author, never merging
// it. Writers run on medium, the lead and reviewers on high; the harness's `fleetd` calls cost no turns.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Body, MODEL, openWorkstream, fleetdCommand, LAB, type Lab, MECHANICS, nodeSock, requireGhLogin, scrubbedEnv, sessionText, SLOT, userMessages } from "./harness.ts";

const MACHINE = "lab-a";
// One lab repo for every slot; each slot runs the train in parallel in its own branch namespace: its base
// `<namespace>/main` and its task branches `<namespace>/fleetd/…`. FLEETD_LAB_REPO and FLEETD_LAB_NAMESPACE
// override; tests/lab/labRepo.ts sets the repo up and clones it.
export const REPO = process.env.FLEETD_LAB_REPO ?? "unlaboredlabs/fleetd-lab";
export const NAMESPACE = process.env.FLEETD_LAB_NAMESPACE ?? `slot/${SLOT}`;
if (!/^slot\/\d$/u.test(NAMESPACE)) throw new Error(`FLEETD_LAB_NAMESPACE must be slot/<n>, got ${NAMESPACE}`);
export const BASE = `${NAMESPACE}/main`;
export const BRANCH_PREFIX = `${NAMESPACE}/fleetd/`;
/** The tag a namespace's main is reset to after each run. */
const SEED = "seed";
export const CLONE = path.join(LAB, "lab-repo");
const TURN_MS = 240_000;
const CI_MS = 600_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
// Each run writes under its own directory, so a file from an earlier run never conflicts.
const DIR = `lab/${new Date().toISOString().slice(0, 19).replace(/\D/gu, "")}`;
const ALPHA = `${DIR}/alpha.md`;
const BETA = `${DIR}/beta.md`;
// Kept untracked (.git/info/exclude): the hub reads it from the checkout, and nothing but the train lands on main.
// gamma writes alpha's file on purpose, so it conflicts with alpha. CI looks for FAIL at the root.
const POLICY = `
`;

const run = (cmd: string, args: ReadonlyArray<string>, cwd = CLONE) =>
  execFileSync(cmd, args, { cwd, env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const git = (...args: Array<string>) => run("git", args);
// Outside the clone, so `--delete-branch` deletes only the remote branch, never a task's checked-out local one.
const gh = (...args: Array<string>) => run("gh", args, LAB);
const ghJson = <A = Body>(...args: Array<string>): A => JSON.parse(gh(...args)) as A;

/**
 * A run holds its namespace through the branch `lease/<namespace>` on a commit whose message says until when. A branch,
 * not a tag: GitHub moves a branch without force only as a fast-forward, which makes the takeover a compare-and-swap.
 */
const LEASE_REF = `heads/lease/${NAMESPACE}`;
const LEASE_MS = 4 * 60 * 60_000;
let lease: string | undefined;

/**
 * Takes this run's lease on the namespace, once per run, or stops: creating the lease branch is atomic, so a second
 * run on a busy namespace (another worktree, another machine) refuses instead of mixing its PRs into this one's. An
 * expired lease (a run killed before its cleanup) is taken over by compare-and-swap: the new lease commit's parent is
 * the expired one, and the branch moves only as a fast-forward, so of two runs taking over the same lease one wins.
 * Released when the process exits. Not renewed: a run longer than LEASE_MS may lose it.
 */
const leaseNamespace = () => {
  if (lease !== undefined) return;
  const tree = ghJson("api", `repos/${REPO}/commits/${SEED}`).commit.tree.sha as string;
  const commit = (parent?: string) => {
    const message = `lab lease ${NAMESPACE} run ${randomUUID()} until ${new Date(Date.now() + LEASE_MS).toISOString()}`;
    const args = ["api", "-X", "POST", `repos/${REPO}/git/commits`, "-f", `message=${message}`, "-f", `tree=${tree}`];
    if (parent !== undefined) args.push("-f", `parents[]=${parent}`);
    return ghJson(...args).sha as string;
  };
  const api = (...args: Array<string>) => spawnSync("gh", ["api", ...args, "--silent"], { cwd: LAB, env: scrubbedEnv(), encoding: "utf8" });
  const take = (sha: string) => {
    lease = sha;
    process.once("exit", releaseNamespace);
  };
  const fresh = commit();
  const created = api("-X", "POST", `repos/${REPO}/git/refs`, "-f", `ref=refs/${LEASE_REF}`, "-f", `sha=${fresh}`);
  if (created.status === 0) return take(fresh);
  if (!/already exists|HTTP 422/u.test(created.stderr)) throw new Error(`leasing ${NAMESPACE}: ${created.stderr.trim()}`);
  const held = ghJson("api", `repos/${REPO}/git/ref/${LEASE_REF}`).object.sha as string;
  const holder = ghJson("api", `repos/${REPO}/git/commits/${held}`).message as string;
  const busy = () =>
    new Error(`${NAMESPACE} on ${REPO} is in use (${holder}); pick another FLEETD_LAB_SLOT, or if no run holds it: gh api -X DELETE repos/${REPO}/git/refs/${LEASE_REF}`);
  if (!(Date.parse(/ until (\S+)$/u.exec(holder)?.[1] ?? "") < Date.now())) throw busy();
  const next = commit(held);
  const moved = api("-X", "PATCH", `repos/${REPO}/git/refs/${LEASE_REF}`, "-f", `sha=${next}`, "-F", "force=false");
  if (moved.status !== 0) throw busy();
  take(next);
};

/** Drops this run's lease, unless another run has since taken over an expired one. */
const releaseNamespace = () => {
  const held = spawnSync("gh", ["api", `repos/${REPO}/git/ref/${LEASE_REF}`, "--jq", ".object.sha"], { cwd: LAB, env: scrubbedEnv(), encoding: "utf8" });
  if (held.status === 0 && held.stdout.trim() === lease) spawnSync("gh", ["api", "-X", "DELETE", `repos/${REPO}/git/refs/${LEASE_REF}`], { cwd: LAB, env: scrubbedEnv() });
};

/**
 * This slot's namespace back to the seed: its open PRs closed, its branches deleted, and its main reset to the seed
 * tag (created when missing). Never another namespace, never the repo's main. Admins bypass the namespace rulesets.
 */
export const resetNamespace = () => {
  leaseNamespace();
  const ours = (ref: string) => ref.startsWith(`${NAMESPACE}/`);
  for (const pr of ghJson<Array<Body>>("pr", "list", "-R", REPO, "--state", "open", "--limit", "200", "--json", "number,headRefName,baseRefName")) {
    if (ours(pr.headRefName as string) || pr.baseRefName === BASE) gh("pr", "close", String(pr.number), "-R", REPO, "--delete-branch");
  }
  const refs = ghJson<Array<Body>>("api", `repos/${REPO}/git/matching-refs/heads/${NAMESPACE}/?per_page=100`).map((r) => (r.ref as string).slice("refs/heads/".length));
  for (const branch of refs.filter((b) => b !== BASE && ours(b))) {
    // GitHub may delete a merged or closed PR's branch between the listing and here; gone is what we want.
    const out = spawnSync("gh", ["api", "-X", "DELETE", `repos/${REPO}/git/refs/heads/${branch}`], { cwd: LAB, env: scrubbedEnv(), encoding: "utf8" });
    if (out.status !== 0 && !/Reference does not exist|Not Found|HTTP 422/u.test(out.stderr)) throw new Error(`deleting ${branch}: ${out.stderr.trim()}`);
  }
  seedBase(refs.includes(BASE));
};

/** Points the namespace's main at the seed tag: moved when it `exists`, else created. */
const seedBase = (exists: boolean) => {
  const seed = ghJson("api", `repos/${REPO}/commits/${SEED}`).sha as string;
  if (exists) gh("api", "-X", "PATCH", `repos/${REPO}/git/refs/heads/${BASE}`, "-f", `sha=${seed}`, "-F", "force=true", "--silent");
  else gh("api", "-X", "POST", `repos/${REPO}/git/refs`, "-f", `ref=refs/heads/${BASE}`, "-f", `sha=${seed}`, "--silent");
};

/**
 * The lab clone on the namespace's main at origin, without task worktrees or branches from an earlier run, and with the
 * policy file, whose `branchPrefix` keeps task branches in the namespace. origin/HEAD names the base, as the node reads
 * a project's base branch from it.
 */
export const prepareCheckout = (policy = POLICY) => {
  leaseNamespace();
  if (spawnSync("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${BASE}`], { cwd: CLONE, env: scrubbedEnv() }).status !== 0) seedBase(false);
  git("fetch", "-q", "--prune", "origin");
  // An earlier run's machine homes, and the task worktrees in them, are gone; git forgets those first.
  git("worktree", "prune");
  for (const entry of git("worktree", "list", "--porcelain").split("\n\n")) {
    const wt = /^worktree (.+)$/mu.exec(entry)?.[1];
    if (wt !== undefined && entry.includes(`\nbranch refs/heads/${BRANCH_PREFIX}`)) git("worktree", "remove", "--force", wt);
  }
  git("worktree", "prune");
  git("checkout", "-q", "--force", "-B", BASE, `origin/${BASE}`);
  git("remote", "set-head", "origin", BASE);
  for (const branch of git("branch", "--list", `${NAMESPACE}/*`, "--format=%(refname:short)").split("\n").filter((b) => b !== "" && b !== BASE)) git("branch", "-D", branch);
  const exclude = path.join(CLONE, ".git/info/exclude");
  if (!fs.readFileSync(exclude, "utf8").includes(".fleetd/")) fs.appendFileSync(exclude, "\n.fleetd/\n");
  fs.mkdirSync(path.join(CLONE, ".fleetd"), { recursive: true });
  fs.writeFileSync(path.join(CLONE, ".fleetd/policy.yaml"), `${policy}branchPrefix: ${BRANCH_PREFIX}\n`);
};

/** The lab clone is a clone of REPO, else the scenario stops with how to make one. */
export const checkClone = (check: Lab["check"]) => {
  const setup = `node tests/lab/labRepo.ts --repo ${REPO} --clone ${CLONE}`;
  check(fs.existsSync(path.join(CLONE, ".git")), `${CLONE} is a clone of ${REPO} (run ${setup})`);
  const origin = git("remote", "get-url", "origin");
  check(origin.replace(/\.git$/u, "").endsWith(REPO), `${CLONE} is a clone of ${origin}, not ${REPO} (move it aside and run ${setup})`);
};

/** `gh api` path of a file on the namespace's main. */
export const onBase = (file: string) => `repos/${REPO}/contents/${file}?ref=${encodeURIComponent(BASE)}`;

/** Removes lab-a's lab repo project if one is registered, so scenarios that take lab-a's project find repo-a. */
export const removeLabRepoProject = async (lab: Pick<Lab, "callTool">) => {
  const listed = (await lab.callTool("projects_list", { machineId: MACHINE })).body.projects as Array<Body>;
  for (const p of listed.filter((p) => p.workspaceRoot === CLONE)) {
    const removed = await lab.callTool("project_remove", { machineId: MACHINE, projectId: p.projectId });
    if (removed.isError) throw new Error(`project_remove ${p.projectId}: ${JSON.stringify(removed.body)}`);
  }
};

export async function m7Train(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  requireGhLogin();
  checkClone(check);
  resetNamespace();
  prepareCheckout();
  ok(`${CLONE} at origin/${BASE} ${git("rev-parse", "--short", "HEAD")} (the seed); untracked .fleetd/policy.yaml (branches under ${BRANCH_PREFIX}); nothing else in ${NAMESPACE}/ on ${REPO}`);

  const scenarioStart = await lab.cursor();
  try {
    // The lab repo as a second project on lab-a.
    const projectId = await lab.addProject(MACHINE, CLONE, "fleetd-lab");
    const ref = { machineId: MACHINE, projectId };
    ok(`project_add: ${projectId} on ${MACHINE} at ${CLONE}`);

    const fleetd = (...args: Array<string>) => {
      const out = spawnSync(...fleetdCommand(args), {
        cwd: CLONE,
        encoding: "utf8",
        env: { ...scrubbedEnv(), PWD: CLONE, FLEETD_NODE_SOCK: nodeSock(MACHINE) },
      });
      return { code: out.status, stdout: out.stdout, stderr: out.stderr };
    };
    const change = async (changeId: string) => ((await callTool("changes_list", { projectRef: ref, limit: 100 })).body.changes as Array<Body>).find((c) => c.changeId === changeId)!;
    const task = async (taskId: string) => (await callTool("task_get", { taskId })).body.task as Body;

    const started = await callTool("lead_start", ref);
    check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
    const leadThread = started.body.threadId as string;
    await lab.waitEvent("lead start turn", TURN_MS, { cursor: scenarioStart, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });
    ok(`lead ${leadThread} started`);

    // Two workstreams, opened and their briefs registered from the shell as the lead would.
    const workstream = async (text: string, brief: Body) => {
      const w = openWorkstream(check, fleetd, text);
      const frozen = fleetd("brief", "create", "--workstream", w, "--json", JSON.stringify({ pointers: [], constraints: [], ...brief }));
      check(frozen.code === 0, `brief create ${w}: ${JSON.stringify(frozen)}`);
      return w;
    };
    // One done-when line per PR, so each reviewer judges its PR against its own line.
    const wm = await workstream("Add alpha.md and beta.md in two PRs.", {
      goal: `two independent PRs: one adds ${ALPHA}, the other adds ${BETA}`,
      why: "the M7 lab scenario",
      doneWhen: [`${ALPHA} is on ${BASE}`, `${BETA} is on ${BASE}`],
    });
    const ws = await workstream("Train edge cases.", {
      goal: `one PR that adds the line gamma to ${ALPHA}, and one that adds FAIL and so must never merge`,
      why: "the M7 lab scenario",
      doneWhen: [`${ALPHA} on ${BASE} holds the line gamma`, `no FAIL file ever reaches ${BASE}`],
    });
    ok(`${wm} and ${ws} running with their briefs`);

    // 5a. The writers open their PRs held, so the train takes none before all four are ready.
    gh("label", "create", "hold", "-R", REPO, "--force", "--description", "fleetd's train holds this PR");
    ok(`5. the label hold exists on ${REPO}`);

    const spawn = (w: string, title: string, prompt: string) => {
      const out = fleetd("task", "spawn", "--workstream", w, "--title", title, "--profile", MECHANICS, "--prompt", prompt);
      const taskId = /^Spawned (T\d+)/mu.exec(out.stdout)?.[1];
      check(out.code === 0 && taskId, `task spawn ${title}: ${JSON.stringify(out)}`);
      lab.log(`spawned ${taskId} (${title})`);
      return taskId!;
    };
    const writer = (file: string, line: string, after = "") =>
      `Create the file ${file} (from the repo root) containing exactly one line: ${line}. Commit it with the message "add ${file}". Then push your branch and open the pull request as your rules say, with the title "add ${file}" and the label hold (\`--label hold\`). Reply with the PR URL.${after}`;
    const queued = async (taskId: string, from: number) => {
      const end = await lab.waitEvent(`${taskId} ends`, TURN_MS, { cursor: from, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === taskId });
      check(end.event.type === "task.completed", `${taskId} completed: ${end.event.summary}`);
      const prUrl = (await task(taskId)).result?.prUrl as string | undefined;
      check(prUrl?.startsWith(`https://github.com/${REPO}/pull/`), `${taskId}'s result names its PR: ${JSON.stringify((await task(taskId)).result)}`);
      const pr = ghJson("pr", "view", prUrl!, "--json", "headRefName,baseRefName");
      check(pr.baseRefName === BASE && (pr.headRefName as string).startsWith(BRANCH_PREFIX), `${prUrl} is ${pr.headRefName} into ${pr.baseRefName}, in ${NAMESPACE}`);
      const q = await lab.waitEvent(`${taskId}'s PR enqueued`, 60_000, { cursor: from, types: ["change.queued"], match: (e) => prUrl!.endsWith(`/pull/${e.data?.prNumber}`) });
      return { taskId, prUrl: prUrl!, changeId: q.event.data.changeId as string };
    };

    // 1. Two writers.
    let cursor = await lab.cursor();
    const a = spawn(wm, "add alpha", writer(ALPHA, "alpha"));
    const b = spawn(wm, "add beta", writer(BETA, "beta"));
    const ca = await queued(a, cursor);
    const cb = await queued(b, cursor);
    ok(`1. ${a} opened ${ca.prUrl} (${ca.changeId}) and ${b} opened ${cb.prUrl} (${cb.changeId}), each auto-enqueued`);

    // 2 and 3. After both, so they come later in train order: a PR conflicting with alpha.md, and one that adds FAIL.
    cursor = await lab.cursor();
    const c = spawn(ws, "add gamma line", writer(
      ALPHA,
      "gamma",
      ` If you are later told this PR conflicts: run \`git fetch origin\` and \`git rebase origin/${BASE}\`; make ${ALPHA} exactly two lines, \`alpha\` then \`gamma\`; \`git add ${ALPHA}\`; \`GIT_EDITOR=true git rebase --continue\`; \`git push --force-with-lease\`; then reply with one word: resolved.`,
    ));
    const d = spawn(ws, "add FAIL", writer("FAIL", "red", " This PR is meant to fail CI. When a later message says CI failed, that is expected: change nothing, push nothing, and reply with exactly one word: acknowledged."));
    const cc = await queued(c, cursor);
    const cd = await queued(d, cursor);
    ok(`${c} opened ${cc.prUrl} (${cc.changeId}, conflicts with ${ALPHA}) and ${d} opened ${cd.prUrl} (${cd.changeId}, adds FAIL)`);

    // 1. Each PR gets one reviewer that returns blocking: 0; nothing merges while held.
    for (const m of [ca, cb, cc, cd]) {
      await lab.waitEvent(`${m.changeId} ready`, TURN_MS * 2, { cursor: scenarioStart, types: ["change.ready"], match: (e) => e.data?.changeId === m.changeId });
      const ready = await change(m.changeId);
      const reviewers = ((await callTool("tasks_list", { projectRef: ref, limit: 100 })).body.tasks as Array<Body>).filter((t) => t.kind === "review" && t.pr === m.prUrl);
      check(reviewers.length === 1 && ready.reviews.length === 1 && ready.reviews[0].taskId === reviewers[0]!.taskId && ready.reviews[0].blocking === 0, `${m.changeId} reviews: ${JSON.stringify({ reviews: ready.reviews, reviewers })}`);
      ok(`1. ${m.changeId} ready: reviewer ${reviewers[0]!.taskId} (spawned by the hub) returned blocking 0 at ${ready.reviews[0].prHeadSha.slice(0, 12)}`);
    }
    const held = await Promise.all([ca, cb, cc, cd].map((x) => change(x.changeId)));
    check(held.every((c) => c.state === "ready" && String(c.lastError ?? "").startsWith("held:")), `the train holds all four: ${JSON.stringify(held)}`);
    const early = await callTool("events_wait", { cursor: scenarioStart, types: ["pr.merged"], timeoutSec: 0 });
    check(early.body.events.length === 0, `nothing merged while held: ${JSON.stringify(early.body.events)}`);
    ok(`5. all four ready and held: ${held.map((c) => `${c.changeId} at ${c.position}`).join(", ")}; no pr.merged`);
    const at = (x: { readonly changeId: string }) => held.find((c) => c.changeId === x.changeId)!.position as number;
    const [first, second] = [ca, cb].sort((x, y) => at(x) - at(y));
    const secondHeadBefore = (await change(second!.changeId)).headSha as string;

    // 5b. Taking the labels off lets the train go on, on its next pass.
    cursor = await lab.cursor();
    for (const x of [ca, cb, cc, cd]) gh("pr", "edit", x.prUrl, "--remove-label", "hold");
    ok("5. the hold labels are off");

    // 1. Merged in train order; the second rebased onto the first's merge, each with fleetd/train on its head.
    const mergedOf = async (x: { readonly changeId: string }, ms: number) =>
      (await lab.waitEvent(`pr.merged for ${x.changeId}`, ms, { cursor, types: ["pr.merged"], match: (e) => e.data?.changeId === x.changeId })).event;
    const m1 = await mergedOf(first!, CI_MS);
    const m2 = await mergedOf(second!, CI_MS);
    check(m1.seq < m2.seq, `pr.merged in train order: ${m1.seq} < ${m2.seq}`);
    const merged2 = await change(second!.changeId);
    const parents = ghJson("api", `repos/${REPO}/commits/${merged2.headSha}`).parents.map((p: Body) => p.sha);
    // Either the second was rebased onto the first's merge, or the train merged both as one batch (one squash, tested
    // together on the batch's head).
    const batched = m2.data.mergedSha === m1.data.mergedSha;
    check(batched || (merged2.headSha !== secondHeadBefore && parents.includes(m1.data.mergedSha)), `${second!.changeId} was rebased onto ${m1.data.mergedSha} or batched with ${first!.changeId}: head ${merged2.headSha} (was ${secondHeadBefore}), parents ${parents}, merged as ${m2.data.mergedSha}`);
    // The train's pass gates every merge: on the batch PR's head when they landed together, else on each member's head.
    const heads: Array<string> = [];
    if (batched) {
      const batch = ghJson<Array<Body>>("pr", "list", "-R", REPO, "--state", "merged", "--head", `${BRANCH_PREFIX}train/batch`, "--json", "number,headRefOid,mergeCommit")
        .find((p) => p.mergeCommit?.oid === m1.data.mergedSha);
      check(batch, `the batch PR merged as ${m1.data.mergedSha} on ${BRANCH_PREFIX}train/batch`);
      heads.push(batch!.headRefOid as string);
    } else {
      for (const m of [m1, m2]) heads.push((await change(m.data.changeId)).headSha as string);
    }
    for (const head of heads) {
      const statuses = ghJson<Array<Body>>("api", `repos/${REPO}/commits/${head}/statuses`);
      check(statuses.some((s) => s.context === "fleetd/train" && s.state === "success"), `fleetd/train on ${head}: ${JSON.stringify(statuses)}`);
    }
    ok(`1. pr.merged ${first!.changeId} (#${m1.data.prNumber} as ${m1.data.mergedSha.slice(0, 12)}) then ${second!.changeId} (#${m2.data.prNumber}); ${batched ? "merged together as one batch" : `${second!.changeId} rebased to ${merged2.headSha.slice(0, 12)} on top of ${m1.data.mergedSha.slice(0, 12)}`}`);

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
    // The one "fix your PR" message (hub/prompts/fixed.rs fix_your_pr), with the reason and what to do.
    await told(c, ["Fix your PR", "the merge train could not rebase it", ALPHA, "rebase onto origin/"]);
    ok(`2. ${c} got the task message naming ${ALPHA}`);
    await told(d, ["Fix your PR", "the merge train did not merge it", "ci (failure)"]);
    ok(`3. ${d} was woken with the failing check name: ci (failure)`);

    // 2. The author resolved and pushed; the train merges the new head.
    const m3 = await mergedOf(cc, CI_MS + TURN_MS);
    const mainAlpha = gh("api", onBase(ALPHA), "-H", "Accept: application/vnd.github.raw");
    ok(`2. ${c} resolved the conflict; pr.merged ${cc.changeId} (#${m3.data.prNumber}); ${ALPHA} on ${BASE}: ${JSON.stringify(mainAlpha)}`);

    // 3. Once the author has acknowledged, the red PR is closed; it was never merged.
    await lab.waitEvent(`${d} ends its second turn`, TURN_MS, { cursor: red.cursor, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === d });
    gh("pr", "close", cd.prUrl, "--delete-branch");
    const redPr = ghJson("pr", "view", cd.prUrl, "--json", "state,mergedAt");
    check(redPr.state === "CLOSED" && redPr.mergedAt === null, `${cd.prUrl} never merged: ${JSON.stringify(redPr)}`);
    const unmerged = await callTool("events_wait", { cursor: scenarioStart, types: ["pr.merged"], timeoutSec: 0 });
    check(!(unmerged.body.events as Array<Body>).some((e) => e.data?.changeId === cd.changeId), "no pr.merged for the red PR");
    ok(`3. ${cd.changeId} stayed ${(await change(cd.changeId)).state}; ${cd.prUrl} closed unmerged`);

    // What the lead and project_get show.
    // The fixed event line (hub/leads/events.rs): "- PR #12 merged as abc1234: <url> (X1, by T4)".
    const mergedLine = new RegExp(`^- PR #${m1.data.prNumber} merged as [0-9a-f]+: \\S+ \\(${first!.changeId}, `, "mu");
    const wakes = userMessages(MACHINE, leadThread).join("\n");
    check(mergedLine.test(wakes), `the lead was woken with ${first!.changeId}'s merge inline`);
    const outcome = (await callTool("project_get", ref)).body;
    check((outcome.trains as Array<Body> | undefined)?.some((t) => t.repo === REPO), `project_get trains: ${JSON.stringify(outcome.trains)}`);
    ok(`lead woken with "${mergedLine.exec(wakes)?.[0]}…"; project_get trains ${JSON.stringify(outcome.trains)}`);
    const outside = await callTool("events_wait", { cursor: scenarioStart, types: ["pr.merged_outside"], timeoutSec: 0 });
    check(outside.body.events.length === 0, `no merge outside the train: ${JSON.stringify(outside.body.events)}`);

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
    ok(`M7 used ${leadTurns} lead turns + ${taskTurns} task turns (${tasks.map((t) => `${t.taskId} ${t.kind}×${t.attempt}`).join(", ")}) = ${leadTurns + taskTurns} claude turns (${MODEL}, tasks on medium)`);
    check(leadTurns + taskTurns <= 22, `M7 stays within 22 claude turns (${leadTurns + taskTurns})`);
  } finally {
    // Only this slot's namespace, never the repo's main: its PRs, branches and main, the lab project and its policy file.
    resetNamespace();
    await removeLabRepoProject(lab).catch((error: unknown) => lab.log(`could not remove the lab repo project: ${String(error)}`));
    fs.rmSync(path.join(CLONE, ".fleetd"), { recursive: true, force: true });
  }
}
