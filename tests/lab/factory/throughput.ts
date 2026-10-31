// W9 part 5 on a project that isn't fleetd, the parts on main so far:
// - #407: the person pushes straight to main while the node is stopped, and the machine's checkout has a local main
//   behind origin and no origin/HEAD. Each writer's worktree starts at origin's fresh main, runs the new tests there,
//   and the checkout's files, branches and HEAD stay as they were.
// - #409: no `.fleetd/` anywhere, and spawns work.
// Also shows the shared reads work on it: `fleetd status` lists the project and the lead's digest names the writers.
// TODO(W9 throughput lab): #414 #425 #432 #429 and the fair-share PR: N writers at once up to the machine's auto cap,
// `also_writing` listing only each writer's own files, the base SHA on the spawn line.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Body, check, ok, sleep } from "../harness.ts";
import type { Factory } from "./kit.ts";
import { BASE, checkoutState, git, stateDiff, TEST_COMMAND } from "./project.ts";

export async function throughput(f: Factory) {
  const { project } = f;
  // The machine's checkout as a person leaves it: on main, with work in progress, and no origin/HEAD (an init-and-push
  // repo never has one).
  git(project.root, "remote", "set-head", "origin", "-d");
  fs.writeFileSync(path.join(project.root, "NOTES.txt"), "the person's own notes, not committed\n");
  const rootBefore = checkoutState(project.root);
  const localMain = git(project.root, "rev-parse", BASE);

  // While the node is down, main moves five times from the person's own checkout: three pushes, a merge request merged
  // on the host, and a last push that adds a test, so a writer that runs the tests proves which tree it got.
  await f.stopNode();
  for (let i = 1; i <= 3; i++) project.pushAsHuman(`docs: stock note ${i}`, { [`docs/note-${i}.md`]: `note ${i}\n` });
  const merged = project.mergeOutside({ number: 7, branch: "price-list", title: "docs: price list", files: { "docs/prices.md": "apple 3\n" } });
  check(git(project.bare, "log", "-1", "--format=%B", merged).includes("See merge request acme/inventory!7"), "the merge commit carries the host's merge message");
  check(git(project.bare, "branch", "--list", "price-list") === "", "the merged branch is gone from origin");
  const head = project.pushAsHuman("feat: restock below a threshold", {
    "inventory/restock.py": "def needed(level, threshold=5):\n    return max(0, threshold - level)\n",
    "tests/test_restock.py":
      "import unittest\n\nfrom inventory.restock import needed\n\n\nclass RestockTest(unittest.TestCase):\n    def test_needed(self):\n        self.assertEqual(needed(2), 3)\n",
  });
  const human = f.humanCheckout();
  check(localMain !== head, "the machine's local main is behind origin's");
  await f.startNode();
  ok(`main moved 5 times with the node stopped (3 pushes, merge request !7 merged on the host, a push) to ${head.slice(0, 7)}; the machine's local main is ${localMain.slice(0, 7)}`);

  // Two writers at once, no policy file.
  check(!fs.existsSync(path.join(project.root, ".fleetd")), "the project has no .fleetd/");
  const w = f.workstream("Restock report.");
  const prompt = `Run the project's tests.\nlab-run: ${TEST_COMMAND} 2>&1 | tail -n 3`;
  const spawnedAt = await f.cursor();
  const spawned = [f.spawnWriter(w, "restock tests one", prompt), f.spawnWriter(w, "restock tests two", prompt)];
  ok(`spawn_agent with no policy file: ${spawned.map((t) => `${t.taskId} ${t.state}`).join(", ")}`);
  // The slot board, sampled until both are done: both must count against the cap at the same moment.
  let mostRunning = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      mostRunning = Math.max(mostRunning, await f.running());
      await sleep(100);
    }
  })();
  const done: Array<Body> = [];
  try {
    for (const t of spawned) done.push(await f.waitTask(t.taskId as string, ["idle", "done"]));
  } finally {
    sampling = false;
    await sampler;
  }
  check(mostRunning >= 2, `both writers counted as running at once on the slot board (at most ${mostRunning} seen)`);

  // Each writer's run, from the hub's events: task.started to its thread's end. Both started before either ended.
  const events = await f.eventsSince(spawnedAt, ["task.started", "thread.completed", "thread.failed", "thread.interrupted"]);
  const runs = done.map((t) => {
    const start = events.find((e) => e.type === "task.started" && e.data?.taskId === t.taskId);
    const end = events.find((e) => e.type !== "task.started" && e.threadId === t.threadRef.threadId);
    check(start && end, `${t.taskId}'s start and end are in the events: ${JSON.stringify({ start, end })}`);
    return { taskId: t.taskId as string, start: start!, end: end! };
  });
  const [a, b] = runs as [(typeof runs)[0], (typeof runs)[0]];
  check(a.start.seq < b.end.seq && b.start.seq < a.end.seq, `the two writers' runs overlap: ${JSON.stringify(runs.map((r) => [r.taskId, r.start.seq, r.end.seq]))}`);
  const overlapMs = Math.min(Date.parse(a.end.at), Date.parse(b.end.at)) - Math.max(Date.parse(a.start.at), Date.parse(b.start.at));
  ok(`both writers ran at once: ${runs.map((r) => `${r.taskId} ${r.start.at.slice(11, 23)}–${r.end.at.slice(11, 23)}`).join(", ")} (${(overlapMs / 1000).toFixed(1)} s together); the slot board counted ${mostRunning} running`);

  for (const t of done) {
    const wt = t.worktreePath as string;
    check(wt && fs.existsSync(wt), `${t.taskId} has its worktree: ${JSON.stringify(t)}`);
    // The branch's first commit is the base: the writer committed nothing, so HEAD is where the node branched it.
    const start = git(wt, "rev-parse", "HEAD");
    check(start === head, `${t.taskId}'s worktree starts at origin's fresh main ${head.slice(0, 7)}, not ${start.slice(0, 7)}`);
    check(!fs.existsSync(path.join(wt, ".fleetd")), `${t.taskId}'s worktree has no .fleetd/`);
    const ran = f.messages(t.threadRef.threadId as string);
    check(ran.length > 0, `${t.taskId}'s session was given its brief`);
    // The 4 tests, the person's new one included, pass in its worktree.
    const tests = spawnSync("sh", ["-c", `${TEST_COMMAND} 2>&1`], { cwd: wt, encoding: "utf8" });
    check(/Ran 4 tests[\s\S]*OK/u.test(tests.stdout), `${t.taskId}'s worktree runs the 4 tests and they pass:\n${tests.stdout}`);
    ok(`${t.taskId}: worktree ${path.basename(wt)} at ${start.slice(0, 7)} (origin's main), its tests pass there`);
  }

  const rootDiff = stateDiff(rootBefore, checkoutState(project.root));
  check(rootDiff.length === 0, `the machine's checkout is as the person left it: ${rootDiff.join(", ")}`);
  check(git(project.root, "rev-parse", BASE) === localMain, "its local main didn't move");
  human.unchanged("after two writers started");
  ok(`the machine's checkout: files, branches and HEAD unchanged (local main still ${localMain.slice(0, 7)}); the person's checkout byte for byte`);

  const status = f.status();
  check(/inventory/u.test(status), `fleetd status lists the project:\n${status}`);
  const digest = await f.leadDigest();
  for (const t of done) check(digest.includes(t.taskId as string), `the lead's digest names ${t.taskId}:\n${digest}`);
  ok(`fleetd status lists inventory; the lead's digest names ${done.map((t) => t.taskId).join(" and ")}`);
}
