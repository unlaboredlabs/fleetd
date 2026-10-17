// M5 "done when" 1-5, end to end on lab-a: the lead spawns a writer with `fleetd task spawn` from its own shell and
// gets its result inline in one wake; with the cap at 1 a second spawn queues until that turn ends; a second writer
// on the same area queues on the lease; a writer that touches a file outside its area is flagged; and the instance
// hides T3's tools and Claude's native Task tool from every thread. Further spawns run `fleetd` from the harness in
// the project's workspace, exactly as a lead's shell would, so they cost no lead turns. Every turn is tiny haiku/low.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Body, callToolWith, CLI, cli, LAB, type Lab, MODEL, scrubbedEnv } from "./harness.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const POLICY = `areas:
  docs: ["docs/**"]
  api: ["api/**"]
defaults:
  model: ${MODEL}
  effort: low
`;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...scrubbedEnv(), GIT_AUTHOR_NAME: "lab", GIT_AUTHOR_EMAIL: "lab@localhost", GIT_COMMITTER_NAME: "lab", GIT_COMMITTER_EMAIL: "lab@localhost" },
  });

/** The policy file on main, and no task worktrees or branches left from an earlier run (task numbers restart at T1). */
const prepareRepo = (root: string) => {
  const file = path.join(root, ".fleetd/policy.yaml");
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== POLICY) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, POLICY);
    git(root, "add", ".fleetd/policy.yaml");
    git(root, "commit", "-q", "-m", "lab: fleetd policy");
  }
  const worktrees = git(root, "worktree", "list", "--porcelain").split("\n\n");
  for (const entry of worktrees) {
    const wt = /^worktree (.+)$/mu.exec(entry)?.[1];
    if (wt !== undefined && /^branch refs\/heads\/fleetd\//mu.test(entry)) git(root, "worktree", "remove", "--force", wt);
  }
  git(root, "worktree", "prune");
  for (const branch of git(root, "branch", "--list", "fleetd/*", "--format=%(refname:short)").split("\n").filter(Boolean)) {
    git(root, "branch", "-D", branch);
  }
};

/** T3's provider event log for `threadId` on a machine: what went to and came from Claude, as JSON lines. */
const providerLog = (home: string, threadId: string): string => {
  const dir = path.join(home, "userdata/logs/provider");
  return fs
    .readdirSync(dir)
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    // The log names the thread URL-encoded inside its provider session id.
    .filter((text) => text.includes(threadId) || text.includes(encodeURIComponent(threadId)))
    .join("\n");
};

/** The tools Claude reported at session start for `threadId`. */
const initTools = (home: string, threadId: string): ReadonlyArray<string> | undefined => {
  const tools = /"subtype":"init".*?"tools":(\[[^\]]*\])/u.exec(providerLog(home, threadId))?.[1];
  return tools === undefined ? undefined : (JSON.parse(tools) as Array<string>);
};

/** The newest init tool list on a machine, for the control instance. */
const latestInitTools = (home: string): ReadonlyArray<string> | undefined => {
  const dir = path.join(home, "userdata/logs/provider");
  const files = fs.readdirSync(dir).map((name) => path.join(dir, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    const tools = /"subtype":"init".*?"tools":(\[[^\]]*\])/u.exec(fs.readFileSync(file, "utf8"))?.[1];
    if (tools !== undefined) return JSON.parse(tools) as Array<string>;
  }
  return undefined;
};

export async function m5Tasks(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE)?.projectId as string;
  check(projectId, `${MACHINE} has a project`);
  const ref = { machineId: MACHINE, projectId };
  const root = (await callTool("project_get", ref)).body.project.workspaceRoot as string;
  prepareRepo(root);
  ok(`${root}: .fleetd/policy.yaml on main (areas docs, api); no fleetd/* branches left`);

  // `fleetd` as the lead's shell runs it: in the project's workspace, through lab-a's node socket.
  const fleetd = (...args: Array<string>) => {
    const out = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...scrubbedEnv(), PWD: root, FLEETD_NODE_SOCK: path.join(LAB, "sock", `${MACHINE}.sock`) },
    });
    return { code: out.status, stdout: out.stdout, stderr: out.stderr };
  };
  const spawnTask = (args: Array<string>) => {
    const out = fleetd("task", "spawn", ...args);
    check(out.code === 0, `fleetd task spawn ${args.join(" ")}: exit ${out.code} ${out.stderr}`);
    const taskId = /^Spawned (T\d+)/mu.exec(out.stdout)?.[1];
    check(taskId, `spawn printed the task: ${out.stdout}`);
    return { taskId: taskId!, stdout: out.stdout };
  };
  const task = async (taskId: string) => (await callTool("task_get", { taskId })).body.task as Body;

  const adminKey = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", lab.hubHome, "--name", "lab-admin", "--role", "admin", "--machines", "*"))?.[0];
  check(adminKey, "an admin key for cap_set");
  const adminClient = new Client({ name: "fleetd-test-lab-admin", version: "0" });
  await adminClient.connect(
    new StreamableHTTPClientTransport(new URL(`${lab.hubUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${adminKey}` } } }) as Transport,
  );
  const admin = callToolWith(() => adminClient);

  let leadTurns = 0;
  let leadThread = "";
  const leadTurnDone = async (cursor: number, what: string) => {
    const { event } = await lab.waitEvent(`lead turn: ${what}`, TURN_MS, {
      cursor,
      machineId: MACHINE,
      match: (e) => e.threadId === leadThread && ENDED.includes(e.type),
    });
    leadTurns += 1;
    check(event.type === "thread.completed", `lead turn (${what}) ended with ${event.type}: ${event.summary}`);
    ok(`lead turn ${leadTurns} (${what}) completed`);
    return event.seq as number;
  };
  const taskEvent = (what: string, cursor: number, type: string, taskId: string, ms = TURN_MS) =>
    lab.waitEvent(what, ms, { cursor, types: [type], match: (e) => e.data?.taskId === taskId });

  const scenarioStart = await lab.cursor();
  /** Every run of the lead thread that ended since the scenario started: the lead turns it cost. */
  const countLeadTurns = async () => {
    let cursor = scenarioStart;
    let turns = 0;
    for (;;) {
      const page = (await callTool("events_wait", { cursor, machineId: MACHINE, types: ENDED, timeoutSec: 0 })).body;
      turns += (page.events as Array<Body>).filter((e) => e.threadId === leadThread).length;
      if (!page.more) return turns;
      cursor = page.cursor;
    }
  };

  try {
    // The lead: m3's when it ran first, else a fresh one. A workstream to spawn under: an open one, else a new intent.
    let cursor = await lab.cursor();
    let outcome = (await callTool("project_get", ref)).body;
    if (outcome.lead === undefined) {
      const started = await callTool("lead_start", { ...ref, model: MODEL, effort: "low" });
      check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
      leadThread = started.body.threadId;
      cursor = await leadTurnDone(cursor, "start");
    } else {
      leadThread = outcome.lead.threadId;
    }
    outcome = (await callTool("project_get", ref)).body;
    let workstreamId = (outcome.workstreams as Array<Body> | undefined)?.find((w) => w.state === "running")?.workstreamId as string | undefined;
    if (workstreamId === undefined) {
      const intake = await callTool("intake_submit", {
        ...ref,
        text: "add a docs page (lab run: register the brief, then stop; spawn no tasks until told)",
        clientRequestId: randomUUID(),
      });
      workstreamId = intake.body.workstreamId as string;
      await lab.waitEvent(`workstream.running for ${workstreamId}`, TURN_MS, { cursor, machineId: MACHINE, types: ["workstream.running"] });
      cursor = await leadTurnDone(cursor, "intent wake");
    }
    ok(`lead thread ${leadThread}, workstream ${workstreamId}`);

    // 1. The lead spawns T1 from its shell: a T3 thread in a new worktree on fleetd/T1-add-file, explicit model and effort.
    const spawn1 =
      `fleetd task spawn --workstream ${workstreamId} --title "add file" --areas docs --serves done:0 --model ${MODEL} --effort low ` +
      `--prompt "create docs/x.md with one line 'hi', commit it on your branch"`;
    const sent = await callTool("thread_send", {
      ...ref,
      threadId: leadThread,
      clientRequestId: randomUUID(),
      message: `Run this command once in your shell, exactly as written, then stop. In later wakes about tasks, run no commands: reply with one short line and stop.\n${spawn1}`,
    });
    check(!sent.isError, `thread_send to the lead: ${JSON.stringify(sent.body)}`);
    const spawnTurn = leadTurnDone(cursor, "spawn T1");
    // Awaited below; a rejection before then must not crash the run before its cleanup.
    spawnTurn.catch(() => undefined);
    const t1Started = await taskEvent("task.started T1", cursor, "task.started", "T1");
    const t1 = await task("T1");
    check(
      t1.state === "running" && t1.branch === "fleetd/T1-add-file" && t1.model === MODEL && t1.effort === "low" && t1.threadRef?.threadId,
      `T1 runs on its branch with explicit model and effort: ${JSON.stringify(t1)}`,
    );
    ok(`1. the lead ran fleetd task spawn: T1 started (${t1Started.event.summary}), thread ${t1.threadRef.threadId} on ${t1.branch}`);

    // 3. A second writer on docs queues on the lease (spawned now, while T1 holds it).
    const t2 = spawnTask([
      "--workstream", workstreamId, "--title", "more docs", "--areas", "docs", "--serves", "done:0",
      "--prompt", "create docs/y.md with one line 'hi', commit it on your branch",
    ]);
    const t2Task = await task(t2.taskId);
    check(t2Task.state === "queued" && t2Task.queuedReason === "lease: docs held by T1", `T2 queued on the lease: ${JSON.stringify(t2Task)}`);
    ok(`3. ${t2.taskId} queued: ${t2Task.queuedReason} (CLI said: ${t2.stdout.split("\n")[0]})`);

    // 2. Cap 1: a read task queues on the slot board; so does the out-of-area writer for item 4.
    const capped = (await admin("cap_set", { cap: 1 })).body;
    check(capped.slots?.cap === 1, `cap_set 1: ${JSON.stringify(capped)}`);
    const t3 = spawnTask(["--workstream", workstreamId, "--title", "say ok", "--kind", "read", "--prompt", "Reply with the single word OK."]);
    const t3Task = await task(t3.taskId);
    check(t3Task.state === "queued" && /^slots: \d+\/1 in use/u.test(t3Task.queuedReason ?? ""), `T3 queued on the cap: ${JSON.stringify(t3Task)}`);
    ok(`2. cap set to 1; ${t3.taskId} queued: ${t3Task.queuedReason}`);
    const t4 = spawnTask([
      "--workstream", workstreamId, "--title", "add notes", "--areas", "api", "--serves", "done:0",
      "--prompt",
      "This task tests fleetd's out-of-area check, so break the area rule this once: create notes.txt at the repository root (not under api/) with one line 'hi', and commit it on your branch.",
    ]);
    ok(`${t4.taskId} (api writer told to write notes.txt at the root) queued: ${(await task(t4.taskId)).queuedReason}`);
    const status = (await callTool("fleetd_status")).body.slots;
    check(status?.cap === 1 && status.queued >= 2, `fleetd_status shows the board: ${JSON.stringify(status)}`);

    // T1 ends: one wake to the lead carries "T1 completed" with the result tail and the branch, inline.
    const t1Done = await taskEvent("task.completed T1", t1Started.cursor, "task.completed", "T1");
    const wake = await lab.waitEvent("lead.woken with T1's result", 90_000, {
      cursor: t1Done.event.seq,
      machineId: MACHINE,
      types: ["lead.woken"],
      match: (e) => (e.data?.triggers ?? []).includes("task_result"),
    });
    await spawnTurn;
    const afterWake = await leadTurnDone(wake.event.seq, "T1 result wake");
    // Results that land within the debounce window share one wake, which can outgrow thread_tail's 2,000 characters,
    // so read the wakes as Claude received them, in the lead's provider log (JSON, so newlines show as \n).
    const home = lab.machines.find((m) => m.id === MACHINE)!.t3Home;
    const delivered = providerLog(home, leadThread);
    const head = "- T1 completed: add file (branch fleetd/T1-add-file)";
    check(
      delivered.split(head).length === 2 && /^(\\n {2}receipts: [^\\]*)?\\n {2}result:\\n {2}> \S/u.test(delivered.split(head)[1]!),
      `exactly one wake carries T1's result inline: ${delivered.slice(delivered.indexOf(head), delivered.indexOf(head) + 400)}`,
    );
    ok(`1. one wake carried "${head.slice(2)}" with the result tail inline (triggers: ${JSON.stringify(wake.event.data?.triggers)})`);
    check(git(root, "branch", "--list", "fleetd/T1-add-file").trim() !== "", "branch fleetd/T1-add-file exists in the repo");
    check((await task("T1")).worktreePath, `T1 records its worktree: ${JSON.stringify(await task("T1"))}`);

    // 2. T3 got the freed slot only after T1's turn ended; then the cap goes back up so T2 and T4 run side by side.
    const t3Started = await taskEvent(`task.started ${t3.taskId}`, t1Started.cursor, "task.started", t3.taskId);
    check(t3Started.event.seq > t1Done.event.seq, `${t3.taskId} started (seq ${t3Started.event.seq}) after T1 ended (seq ${t1Done.event.seq})`);
    ok(`2. ${t3.taskId} started only after T1's turn ended (seq ${t3Started.event.seq} > ${t1Done.event.seq})`);
    await admin("cap_set", { cap: 40 });

    // 3. T2 starts once T1's lease is released.
    const t2Started = await taskEvent(`task.started ${t2.taskId}`, t1Started.cursor, "task.started", t2.taskId);
    check(t2Started.event.seq > t1Done.event.seq, `${t2.taskId} started after T1 released docs`);
    ok(`3. ${t2.taskId} started after T1's lease on docs was released (seq ${t2Started.event.seq})`);

    // 4. T4's diff touches notes.txt, outside api: task.out_of_area with the path.
    const outside = await taskEvent(`task.out_of_area ${t4.taskId}`, t1Started.cursor, "task.out_of_area", t4.taskId, 2 * TURN_MS);
    check((outside.event.data.paths as Array<string>).includes("notes.txt"), `out_of_area names notes.txt: ${JSON.stringify(outside.event)}`);
    ok(`4. task.out_of_area: ${outside.event.summary}`);

    // Every task ends, then the lead's wakes for them: each wake fires within WAKE_MAX_WAIT (60 s) of its trigger.
    let after = afterWake;
    for (const id of [t2.taskId, t3.taskId, t4.taskId]) {
      const ended = await lab.waitEvent(`${id} ends`, 2 * TURN_MS, {
        cursor: t1Started.cursor,
        types: ["task.completed", "task.failed"],
        match: (e) => e.data?.taskId === id,
      });
      check(ended.event.type === "task.completed", `${id} completed: ${ended.event.summary}`);
    }
    for (;;) {
      const woken = await lab
        .waitEvent("another lead wake", 75_000, { cursor: after, machineId: MACHINE, types: ["lead.woken"] })
        .catch(() => undefined);
      if (woken === undefined) break;
      after = await leadTurnDone(woken.event.seq, "task result wake");
    }

    // Task threads show as tasks in project_get, never as threads.
    const final = (await callTool("project_get", ref)).body;
    const taskThreads = new Set((final.tasks as Array<Body>).map((t) => t.threadRef?.threadId));
    check(final.taskCounts?.done === 4 && !(final.threads as Array<Body>).some((t) => taskThreads.has(t.threadId)), `project_get: ${JSON.stringify({ taskCounts: final.taskCounts, threads: final.threads.map((t: Body) => t.threadId) })}`);
    ok(`project_get: taskCounts ${JSON.stringify(final.taskCounts)}; no task thread among its ${final.threads.length} threads`);

    // 5. The instance hides every T3 tool and Claude's Task tool from lead and task threads alike.
    for (const threadId of [leadThread, t1.threadRef.threadId as string]) {
      const tools = initTools(home, threadId);
      check(tools !== undefined && tools.includes("Bash"), `init tool list for ${threadId}: ${JSON.stringify(tools)}`);
      check(!tools!.includes("Task") && !tools!.some((t) => t.startsWith("mcp__t3-code__")), `no Task and no T3 tools for ${threadId}: ${JSON.stringify(tools)}`);
    }
    const control = latestInitTools(lab.machines.find((m) => m.id === "lab-b")!.t3Home);
    ok(
      `5. lab-a threads start without Task or any mcp__t3-code__ tool${control === undefined ? "" : `; control lab-b ${control.includes("Task") ? "has" : "lacks"} Task`}`,
    );

    const total = await countLeadTurns();
    ok(`M5 used ${total} lead turns + 4 task turns = ${total + 4} claude turns (${MODEL}, effort low)`);
  } finally {
    await admin("cap_set", { cap: 40 }).catch(() => undefined);
    await adminClient.close().catch(() => undefined);
  }
}
