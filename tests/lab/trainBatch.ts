// The merge train's batches and stacks on lab-a, in this slot's namespace of the lab repo, with PRs the harness pushes
// and enqueues itself (no writer agents; the lead only answers wakes). Each part freezes the train until its PRs are
// green on their own heads, then thaws it:
// 1. three tier-S PRs with disjoint files merge as one batch: one batch PR, one CI run on its head, one squash, and
//    each member closed with a link;
// 2. a red batch bisects: a, b and c are green alone, but c's ci.yml (a PR runs its own workflow) also fails on the
//    file b adds, so together they are red; the train drops c, merges a and b, and c alone is red and never merges;
// 3. a PR stacked on another is green on it (`fleetd/stack`) before the parent lands, and merges after it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Body, openWorkstream, fleetdCommand, type Lab, nodeSock, requireGhLogin, scrubbedEnv } from "./harness.ts";
import { BASE, BRANCH_PREFIX, checkClone, CLONE, git, NAMESPACE, prepareCheckout, REPO, removeLabRepoProject, resetNamespace } from "./m7Train.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const CI_MS = 600_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
const FREEZE_KEY = `policy.freeze.${REPO.replace("/", ".")}`;
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
const pushPr = (name: string, files: Readonly<Record<string, string>>, base = BASE, from = base): Pr => {
  const branch = `${NAMESPACE}/lab-batch/${name}`;
  git("fetch", "-q", "origin");
  git("checkout", "-q", "-B", branch, `origin/${from}`);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(CLONE, file)), { recursive: true });
    fs.writeFileSync(path.join(CLONE, file), content);
    git("add", file);
  }
  git("commit", "-q", "-m", `lab: ${name}`);
  git("push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`);
  git("checkout", "-q", BASE);
  const url = gh("pr", "create", "-R", REPO, "--base", base, "--head", branch, "--title", `lab: ${name}`, "--body", `lab: ${name}`);
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
    const w = openWorkstream(check, fleetd, "PRs through the train's batches and stacks. The harness pushes and enqueues every PR itself.");
    const brief = {
      goal: "PRs through the train's batches and stacks",
      why: "the train batch lab scenario",
      pointers: [],
      constraints: [],
      // Never passes: a lead that claims the order done would close the PRs still on the train as leftovers.
      doneWhen: [{ type: "cmd", machineId: MACHINE, argv: ["false"], expectExit: 0 }],
      tier: "S",
    };
    const briefed = fleetd("brief", "create", "--workstream", w, "--json", JSON.stringify(brief));
    check(briefed.code === 0, `brief create ${w}: ${JSON.stringify(briefed)}`);

    const freeze = async () => {
      const frozen = await callTool("decisions_record", { key: FREEZE_KEY, value: "true", why: "train batch lab: hold until every PR is green", scope: { kind: "project", projectRef: ref } });
      check(!frozen.isError, `decisions_record: ${JSON.stringify(frozen.body)}`);
    };
    const thaw = async () => {
      const thawed = await callTool("train_freeze", { repo: REPO, frozen: false });
      check(!thawed.isError && thawed.body.train.frozen === false, `train_freeze false: ${JSON.stringify(thawed.body)}`);
    };
    const changeOf = async (pr: Pr) =>
      ((await callTool("changes_list", { projectRef: ref, limit: 100 })).body.changes as Array<Body>).find((c) => c.prNumber === pr.number);
    const enqueue = async (pr: Pr) => {
      const out = fleetd("change", "enqueue", "--pr", pr.url, "--workstream", w);
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
    const merged = (cursor: number, changeId: string) =>
      lab.waitEvent(`pr.merged ${changeId}`, CI_MS * 2, { cursor, types: ["pr.merged"], match: (e) => e.data?.changeId === changeId });
    const batchPrs = () =>
      ghJson<Array<Body>>("pr", "list", "-R", REPO, "--state", "all", "--head", `${BRANCH_PREFIX}train/batch`, "--json", "number,state,body,headRefOid,mergeCommit");

    // 1. Three disjoint PRs, one batch, one CI run.
    await freeze();
    const one = ["a", "b", "c"].map((n) => pushPr(`one-${n}`, { [`${DIR}/one-${n}.md`]: `${n}\n` }));
    const oneIds: Array<string> = [];
    for (const pr of one) oneIds.push(await enqueue(pr));
    for (const pr of one) await ownCi(pr);
    let cursor = await lab.cursor();
    await thaw();
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

    // 2. A red batch bisects.
    await freeze();
    const a = pushPr("two-a", { [`${DIR}/two-a.md`]: "a\n" });
    const b = pushPr("two-b", { [PAIR]: "b\n" });
    const c = pushPr("two-c", { ".github/workflows/ci.yml": STRICT_CI });
    const [aId, bId, cId] = [await enqueue(a), await enqueue(b), await enqueue(c)];
    for (const pr of [a, b, c]) await ownCi(pr);
    cursor = await lab.cursor();
    await thaw();
    const [aMerged, bMerged] = [await merged(cursor, aId!), await merged(cursor, bId!)];
    check(aMerged.event.data.mergedSha === bMerged.event.data.mergedSha, `a and b merged together: ${JSON.stringify([aMerged.event.data, bMerged.event.data])}`);
    const failed = await lab.waitEvent(`change.ci_failed ${cId}`, CI_MS * 2, { cursor, types: ["change.ci_failed"], match: (e) => e.data?.changeId === cId });
    const cMoves = (await eventsSince(cursor, ["change.state"])).filter((e) => e.data?.changeId === cId).map((e) => `${e.data.from}>${e.data.to}`);
    check(cMoves.includes("ci>ready") && cMoves.at(-1) === "ci>ci_failed", `c left the red batch (ci>ready), then failed alone: ${cMoves.join(" ")}`);
    check(ghJson<Body>("pr", "view", c.url, "--json", "state").state === "OPEN", `#${c.number} never merged`);
    ok(`2. a red batch of #${a.number}, #${b.number}, #${c.number} dropped #${c.number}; #${a.number} and #${b.number} merged together, #${c.number} alone failed: ${failed.event.summary}`);

    // 3. A stacked PR is green on its parent before the parent lands.
    await freeze();
    const parent = pushPr("three-parent", { [`${DIR}/parent.md`]: "parent\n" });
    const child = pushPr("three-child", { [`${DIR}/child.md`]: "child\n" }, parent.branch, parent.branch);
    const parentId = await enqueue(parent);
    const childId = await enqueue(child);
    const childHead = head(child);
    let greenAt: string | undefined;
    for (const deadline = Date.now() + CI_MS * 2; greenAt === undefined && Date.now() < deadline; await new Promise((r) => setTimeout(r, 10_000))) {
      const statuses = ghJson<Array<Body>>("api", `repos/${REPO}/commits/${childHead}/statuses`);
      greenAt = statuses.find((s) => s.context === "fleetd/stack" && s.state === "success")?.created_at as string | undefined;
    }
    check(greenAt !== undefined, `fleetd/stack=success on #${child.number}'s head while #${parent.number} waits`);
    check(ghJson<Body>("pr", "view", parent.url, "--json", "state").state === "OPEN", `#${parent.number} has not landed yet`);
    cursor = await lab.cursor();
    await thaw();
    await merged(cursor, parentId);
    await merged(cursor, childId);
    const parentAt = ghJson<Body>("api", `repos/${REPO}/pulls/${parent.number}`).merged_at as string;
    check(Date.parse(greenAt!) < Date.parse(parentAt), `green on its parent at ${greenAt}, before the parent landed at ${parentAt}`);
    ok(`3. #${child.number}, stacked on #${parent.number}, was green on it at ${greenAt}, before #${parent.number} landed at ${parentAt}; both merged into ${BASE}`);
  } finally {
    await callTool("train_freeze", { repo: REPO, frozen: false }).catch(() => undefined);
    resetNamespace();
    await removeLabRepoProject(lab).catch((error: unknown) => lab.log(`could not remove the lab repo project: ${String(error)}`));
    fs.rmSync(path.join(CLONE, ".fleetd"), { recursive: true, force: true });
  }
}
