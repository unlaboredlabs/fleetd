// The merge train's batches on lab-a, in this slot's namespace of the lab repo, with PRs the harness pushes and
// enqueues itself (no writer agents; the lead only answers wakes). Each PR opens with the `hold` label, so the train
// waits until the part's PRs are reviewed (one hub reviewer each) and green on their own heads; then the harness takes
// the labels off:
// 1. three ready PRs merge as one batch, built on GitHub: one batch PR, one CI run on its head, one squash, and
//    each member closed with a link;
// 2. a red batch sends each member alone: a, b and c are green alone, but c's ci.yml (a PR runs its own workflow)
//    also fails on the file b adds, so together they are red; a and b then merge alone, and c alone is red and never
//    merges.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Body, openWorkstream, type Lab, leadIn, nodeSock, requireGhLogin, scrubbedEnv } from "./harness.ts";
import { BASE, BRANCH_PREFIX, checkClone, CLONE, git, NAMESPACE, prepareCheckout, REPO, removeLabRepoProject, resetNamespace } from "./m7Train.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const CI_MS = 600_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
const DIR = `lab/${new Date().toISOString().slice(0, 19).replace(/\D/gu, "")}`;
const PAIR = `${DIR}/pair`;
const POLICY = `
`;
// The seed's workflow plus one step that fails on the file b adds: c is green alone and red next to b.
const STRICT_CI = `name: ci

on:
  pull_request:
    branches-ignore: ["noci/**"]
  push:
    branches: [main, "slot/*/main"]

permissions:
  contents: read

jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v7
      - name: No FAIL file
        run: test ! -e FAIL
      - name: No pair file
        run: test ! -e ${PAIR}
`;

const gh = (...args: Array<string>) => {
  const out = spawnSync("gh", args, { cwd: path.dirname(CLONE), env: scrubbedEnv(), encoding: "utf8" });
  if (out.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${out.stderr.trim()}`);
  return out.stdout.trim();
};
const ghJson = <A = Body>(...args: Array<string>): A => JSON.parse(gh(...args)) as A;

type Pr = { readonly number: number; readonly url: string; readonly branch: string };

/** Pushes `files` as one commit on `branch` from `from` and opens a PR into `base`. */
const pushPr = (name: string, files: Readonly<Record<string, string>>): Pr => {
  const branch = `${NAMESPACE}/lab-batch/${name}`;
  git("fetch", "-q", "origin");
  git("checkout", "-q", "-B", branch, `origin/${BASE}`);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(CLONE, file)), { recursive: true });
    fs.writeFileSync(path.join(CLONE, file), content);
    git("add", file);
  }
  git("commit", "-q", "-m", `lab: ${name}`);
  git("push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`);
  git("checkout", "-q", BASE);
  const url = gh("pr", "create", "-R", REPO, "--base", BASE, "--head", branch, "--title", `lab: ${name}`, "--body", `lab: ${name}`, "--label", "hold");
  return { number: Number(/\/pull\/(\d+)$/u.exec(url)?.[1]), url, branch };
};

export async function trainBatch(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  requireGhLogin();
  checkClone(check);
  resetNamespace();
  prepareCheckout(POLICY);
  const scenarioStart = await lab.cursor();
  try {
    const projectId = await lab.addProject(MACHINE, CLONE, "fleetd-lab");
    const ref = { machineId: MACHINE, projectId };
    const lead = leadIn(CLONE, { ...scrubbedEnv(), FLEETD_NODE_SOCK: nodeSock(MACHINE) });
    const started = await callTool("lead_start", ref);
    check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
    const leadThread = started.body.threadId as string;
    await lab.waitEvent("lead start turn", TURN_MS, { cursor: scenarioStart, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });
    const w = openWorkstream(check, lead, "PRs through the train's batches. The harness pushes and enqueues every PR itself.", {
      goal: "PRs through the train's batches",
      why: "the train batch lab scenario",
      doneWhen: ["every batched PR is merged"],
    });

    gh("label", "create", "hold", "-R", REPO, "--force", "--description", "fleetd's train holds this PR");
    const release = (prs: ReadonlyArray<Pr>) => {
      for (const pr of prs) gh("pr", "edit", pr.url, "--remove-label", "hold");
    };
    const changeOf = async (pr: Pr) =>
      ((await callTool("changes_list", { projectRef: ref, limit: 100 })).body.changes as Array<Body>).find((c) => c.prNumber === pr.number);
    const enqueue = async (pr: Pr) => {
      const out = lead("change_enqueue", { prUrl: pr.url, workstreamId: w });
      check(out.code === 0, `change enqueue ${pr.url}: ${JSON.stringify(out)}`);
      const change = await changeOf(pr);
      check(change !== undefined, `#${pr.number} is on the train`);
      return change!.changeId as string;
    };
    /** Every event of `types` after `cursor`, up to the hub's head now. */
    const eventsSince = async (from: number, types: Array<string>) => {
      const head = await lab.cursor();
      const out: Array<Body> = [];
      for (let at = from; at < head; ) {
        const page = (await callTool("events_wait", { cursor: at, timeoutSec: 0, types })).body;
        out.push(...(page.events as Array<Body>));
        if ((page.cursor as number) <= at) break;
        at = page.cursor as number;
      }
      return out;
    };
    const head = (pr: Pr) => ghJson<Body>("api", `repos/${REPO}/pulls/${pr.number}`).head.sha as string;
    /** Waits until the PR's own `ci` check is green on its head (or red, when `red`). */
    const ownCi = async (pr: Pr, red = false) => {
      const want = red ? "failure" : "success";
      for (const deadline = Date.now() + CI_MS; Date.now() < deadline; await new Promise((r) => setTimeout(r, 10_000))) {
        const runs = ghJson<Body>("api", `repos/${REPO}/commits/${head(pr)}/check-runs`).check_runs as Array<Body>;
        const ci = runs.find((r) => r.name === "ci");
        if (ci?.status === "completed") {
          check(ci.conclusion === want, `#${pr.number}'s own ci is ${ci.conclusion}, expected ${want}`);
          return;
        }
      }
      check(false, `#${pr.number}'s own ci did not finish within ${CI_MS / 60_000} min`);
    };
    /** Waits until the hub's reviewer passed the Change: every PR merges only on one clean review. */
    const reviewed = (changeId: string) =>
      lab.waitEvent(`${changeId} ready`, TURN_MS * 2, { cursor: scenarioStart, types: ["change.ready"], match: (e) => e.data?.changeId === changeId });
    const merged = (cursor: number, changeId: string) =>
      lab.waitEvent(`pr.merged ${changeId}`, CI_MS * 2, { cursor, types: ["pr.merged"], match: (e) => e.data?.changeId === changeId });
    const batchPrs = () =>
      ghJson<Array<Body>>("pr", "list", "-R", REPO, "--state", "all", "--head", `${BRANCH_PREFIX}train/batch`, "--json", "number,state,body,headRefOid,mergeCommit");

    // 1. Three ready PRs, one batch, one CI run.
    const one = ["a", "b", "c"].map((n) => pushPr(`one-${n}`, { [`${DIR}/one-${n}.md`]: `${n}\n` }));
    const oneIds: Array<string> = [];
    for (const pr of one) oneIds.push(await enqueue(pr));
    for (const pr of one) await ownCi(pr);
    for (const id of oneIds) await reviewed(id);
    let cursor = await lab.cursor();
    release(one);
    const oneMerged = await Promise.all(oneIds.map((id) => merged(cursor, id)));
    const shas = new Set(oneMerged.map((m) => m.event.data.mergedSha as string));
    check(shas.size === 1, `the three merged as one squash: ${[...shas].join(", ")}`);
    // The batch records each member at the head it was built from.
    const marker = `fleetd-batch: ${one.map((p) => `#${p.number}@${head(p)}`).join(" ")}`;
    const batch1 = batchPrs().find((p) => p.state === "MERGED" && (p.body as string).includes(marker));
    check(batch1 !== undefined, `a merged batch PR on ${BRANCH_PREFIX}train/batch names #${one.map((p) => p.number).join(", #")}: ${JSON.stringify(batchPrs())}`);
    const runs = ghJson<Body>("api", `repos/${REPO}/actions/runs?head_sha=${batch1!.headRefOid}`).total_count as number;
    check(runs === 1, `one CI run on the batch's head ${batch1!.headRefOid}: ${runs}`);
    for (const pr of one) {
      const view = ghJson<Body>("pr", "view", pr.url, "--json", "state,comments");
      check(view.state === "CLOSED" && (view.comments as Array<Body>).some((c) => (c.body as string).startsWith(`Landed in #${batch1!.number}`)), `#${pr.number} closed with a link to #${batch1!.number}`);
    }
    ok(`1. #${one.map((p) => p.number).join(", #")} merged as batch #${batch1!.number} (${[...shas][0]!.slice(0, 12)}) after one CI run; each closed with a link`);

    // 2. A red batch: each member goes alone.
    const a = pushPr("two-a", { [`${DIR}/two-a.md`]: "a\n" });
    const b = pushPr("two-b", { [PAIR]: "b\n" });
    const c = pushPr("two-c", { ".github/workflows/ci.yml": STRICT_CI });
    const [aId, bId, cId] = [await enqueue(a), await enqueue(b), await enqueue(c)];
    for (const pr of [a, b, c]) await ownCi(pr);
    for (const id of [aId!, bId!, cId!]) await reviewed(id);
    cursor = await lab.cursor();
    release([a, b, c]);
    const [aMerged, bMerged] = [await merged(cursor, aId!), await merged(cursor, bId!)];
    check(aMerged.event.data.mergedSha !== bMerged.event.data.mergedSha, `a and b merged alone: ${JSON.stringify([aMerged.event.data, bMerged.event.data])}`);
    const failed = await lab.waitEvent(`change.ci_failed ${cId}`, CI_MS * 2, { cursor, types: ["change.ci_failed"], match: (e) => e.data?.changeId === cId });
    const cMoves = (await eventsSince(cursor, ["change.state"])).filter((e) => e.data?.changeId === cId).map((e) => `${e.data.from}>${e.data.to}`);
    check(cMoves.includes("ci>ready") && cMoves.at(-1) === "ci>ci_failed", `c left the red batch (ci>ready), then failed alone: ${cMoves.join(" ")}`);
    check(ghJson<Body>("pr", "view", c.url, "--json", "state").state === "OPEN", `#${c.number} never merged`);
    ok(`2. a red batch of #${a.number}, #${b.number}, #${c.number}: #${a.number} and #${b.number} merged alone, #${c.number} alone failed: ${failed.event.summary}`);
  } finally {
    resetNamespace();
    await removeLabRepoProject(lab).catch((error: unknown) => lab.log(`could not remove the lab repo project: ${String(error)}`));
    fs.rmSync(path.join(CLONE, ".fleetd"), { recursive: true, force: true });
  }
}
