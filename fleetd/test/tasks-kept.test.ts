// What the workspace keeps of a finished agent (hub/tasks/kept_rules.ts, steps_kept.ts): its newest steps, read by
// agent_work once its node is gone, and a writer's changed files and own commits on its result.
import { expect, test } from "bun:test";
import { events } from "../src/hub/store/events.ts";
import { KeptSteps } from "../src/hub/tasks/steps_kept.ts";
import { commitsArgv, commitsOf, filesArgv, filesOf, KEPT_FILES, KEPT_FOR_MS, KEPT_STEPS, keptPage, keptSteps, pathBatches } from "../src/hub/tasks/kept_rules.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import type { Task, ThreadRef, WorkStep } from "../src/shared/contracts.ts";
import { tasksKit, until } from "./tasks-kit.ts";
import { AT, key, kit } from "./work-kit.ts";

const step = (n: number, text = `step ${n}`): WorkStep =>
  ({ kind: "message", id: `m${String(n).padStart(4, "0")}`, at: new Date(Date.parse(AT) + n * 1000).toISOString(), role: "assistant", text }) as WorkStep;
/** Steps 1..n, newest first, as the node's view pages them. */
const newestFirst = (n: number) => Array.from({ length: n }, (_, i) => step(n - i));

test("a numstat reads as files: renames by their new path, binaries as 0 and 0, a cut first line dropped", () => {
  const out = "12\t3\tsrc/app.ts\n-\t-\tlogo.png\n4\t4\tsrc/{old => new}/name.ts\n0\t0\tdocs/a.md => docs/b.md\n";
  expect(filesOf(out, 2000)).toEqual([
    { path: "src/app.ts", additions: 12, deletions: 3 },
    { path: "logo.png", additions: 0, deletions: 0 },
    { path: "src/new/name.ts", additions: 4, deletions: 4 },
    { path: "docs/b.md", additions: 0, deletions: 0 },
  ]);
  // A tail as long as the node keeps may start mid-line: that line goes.
  const long = `${"x".repeat(1990)}\t1\tcut.ts\n5\t1\tkept.ts\n`;
  expect(filesOf(long.slice(-2000), 2000).map((f) => f.path)).toEqual(["kept.ts"]);
});

test("a log reads as commits, newest first; the commands meet the base ref, else its sha", () => {
  expect(commitsOf("a1b2c3d\tAdd the page                     \nffee012\tFix the test\n", 2000)).toEqual([
    { sha: "a1b2c3d", subject: "Add the page" },
    { sha: "ffee012", subject: "Fix the test" },
  ]);
  expect(filesArgv({ ref: "origin/main", sha: "abc" }, ["a.ts"])).toEqual(["git", "diff", "--numstat", "-M", "--merge-base", "origin/main", "--", "a.ts"]);
  expect(filesArgv({ sha: "abc" }, ["a.ts", "b.ts"])).toEqual(["git", "diff", "--numstat", "-M", "abc", "--", "a.ts", "b.ts"]);
  expect(commitsArgv("fleetd/T1-x")).toContain("--exclude=*/fleetd/T1-x");
});

test("a big change's paths go in batches whose numstat fits a command's output, so no file is cut off", () => {
  // This PR's own 33 files took 1,623 characters in one numstat; 120 such paths would lose their first ~80.
  const paths = Array.from({ length: 120 }, (_, i) => `app/desktop/src/renderer/screens/agents/file${String(i).padStart(3, "0")}.tsx`);
  const batches = pathBatches(paths, 1800);
  expect(batches.flat()).toEqual(paths);
  for (const b of batches) {
    // Each line at its widest: a rename's two paths and two six-digit counts.
    const widest = b.map((p) => `999999\t999999\t${p} => ${p}\n`).join("");
    expect(widest.length).toBeLessThan(2000);
  }
  expect(pathBatches(Array.from({ length: KEPT_FILES + 10 }, (_, i) => `f${String(i)}`), 1800).flat()).toHaveLength(KEPT_FILES);
  expect(pathBatches([], 1800)).toEqual([]);
});

test("kept steps are the newest KEPT_STEPS, oldest first, and page back as agent_work pages", () => {
  const kept = keptSteps(newestFirst(KEPT_STEPS + 50));
  expect(kept.length).toBe(KEPT_STEPS);
  expect(kept[0]?.id).toBe("m0051");
  expect(kept.at(-1)?.id).toBe("m0250");
  const [page, older] = keptPage(kept, undefined, 20);
  expect(page.map((s) => s.id)).toEqual(kept.slice(-20).map((s) => s.id));
  expect(older).toBe(true);
  const first = page[0] as WorkStep;
  const [next] = keptPage(kept, [first.at, first.id], 500);
  expect(next.length).toBe(KEPT_STEPS - 20);
  expect(keptPage(kept, [kept[0]!.at, kept[0]!.id], 20)).toEqual([[], false]);
  // A huge step can't push the copy past its bytes.
  expect(keptSteps([step(2, "y".repeat(400_000)), step(1, "z".repeat(400_000))]).length).toBe(1);
});

test("a writer's end keeps its steps, files and commits; agent_work reads them with its node gone", async () => {
  const k = tasksKit();
  void k.t.run();
  const writer = await k.spawn("add the page", "write");
  const thread = writer.threadRef as ThreadRef;
  // A big change: 90 files, whose numstat in one command would run far past the 2,000 characters a node sends back.
  const paths = Array.from({ length: 90 }, (_, i) => `src/screens/settings/part${String(i).padStart(2, "0")}.tsx`);
  k.ports.changesOf = { branch: "fleetd/T1-add-the-page", worktreePath: "/w/T1", paths };
  Object.assign(k.ports, { workSteps: async () => newestFirst(30) });
  const run = k.ports.runCommand;
  k.ports.runCommand = async (m, cwd, argv) => {
    await run(m, cwd, argv);
    if (argv[1] === "diff") {
      const out = argv.slice(argv.indexOf("--") + 1).map((p) => `12\t3\t${p}\n`).join("");
      // The node's own cut: only the last 2,000 characters come back.
      return { exitCode: 0, outputTail: out.slice(-2000) };
    }
    if (argv[1] === "log") return { exitCode: 0, outputTail: "a1b2c3d\tAdd the page\n" };
    return { exitCode: 0, outputTail: "" };
  };
  // What a page reading the task at its end sees: the record as the task.completed event goes out.
  let atEvent: Task | undefined;
  const offEvents = events(k.hub).subscribe((e) => {
    if (e.type === "task.completed" && (e.data as { taskId?: string } | undefined)?.taskId === writer.taskId) atEvent = k.t.get(writer.taskId);
  });
  k.threadRow(thread.threadId, "completed", "Done: the page is up.");
  k.thread("thread.completed", thread.threadId, { runId: "r1", endCause: "completed" });
  await until(() => atEvent !== undefined && KeptSteps.read(k.hub.db.conn, thread) !== undefined);
  offEvents();

  // Every file, none lost to the cut, and the files and commits already there when the end was said.
  const result = atEvent?.result;
  expect(result?.files).toHaveLength(90);
  expect(result?.files?.map((f) => f.path)).toEqual(paths);
  expect(result?.files?.[0]).toEqual({ path: "src/screens/settings/part00.tsx", additions: 12, deletions: 3 });
  expect(result?.commits).toEqual([{ sha: "a1b2c3d", subject: "Add the page" }]);
  expect(k.ports.commands.filter((c) => c.argv[1] === "diff").length).toBeGreaterThan(1);
  expect(k.ports.commands.find((c) => c.argv[1] === "diff")?.cwd).toBe("/w/T1");
  expect(KeptSteps.read(k.hub.db.conn, thread)?.length).toBe(30);

  // No node is linked in this kit: agent_work answers from the copy, a page at a time.
  const page = (await k.ok(key("read"), "agent_work", { ...thread, limit: 20 })) as { steps: WorkStep[]; before?: string; running: boolean };
  expect(page.running).toBe(false);
  expect(page.steps.map((s) => s.id)).toEqual(Array.from({ length: 20 }, (_, i) => step(i + 11).id));
  const rest = (await k.ok(key("read"), "agent_work", { ...thread, before: page.before })) as { steps: WorkStep[]; before?: string };
  expect(rest.steps.length).toBe(10);
  expect(rest.before).toBeUndefined();
  k.hub.shutdown.abort();
});

test("a stopped agent keeps its steps too; kept steps go KEPT_FOR_MS after the end", async () => {
  const k = tasksKit();
  void k.t.run();
  const reader = await k.spawn("read the logs", "read");
  const thread = reader.threadRef as ThreadRef;
  Object.assign(k.ports, { workSteps: async () => newestFirst(3) });
  await k.t.cancel(k.lead, reader.taskId, "Stopped by the human.");
  await until(() => KeptSteps.read(k.hub.db.conn, thread) !== undefined);
  expect((k.t.get(reader.taskId) as Task).result?.files).toBeUndefined();
  expect(KeptSteps.prune(k.hub.db.conn, k.clock.ms + KEPT_FOR_MS - 60_000)).toBe(0);
  expect(KeptSteps.prune(k.hub.db.conn, k.clock.ms + KEPT_FOR_MS + 60_000)).toBe(1);
  expect(KeptSteps.read(k.hub.db.conn, thread)).toBeUndefined();
  k.hub.shutdown.abort();
});

test("a running agent's thread never reads from a copy kept at an earlier end", async () => {
  const k = kit();
  const r = { machineId: "devbox", threadId: "s1" };
  KeptSteps.save(k.hub.db.conn, r, "T1", newestFirst(2), Date.now());
  TaskRecords.create(k.hub.db.conn, {
    taskId: "",
    attempt: 1,
    kind: "write",
    state: "running",
    title: "again",
    prompt: "p",
    createdAt: AT,
    projectRef: { machineId: "devbox", projectId: "app" },
    workstreamId: "W1",
    threadRef: r,
  } as Task);
  expect(await k.refused(key("read"), "agent_work", r)).toBe("machine_offline");
});
