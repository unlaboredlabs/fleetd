// The app demo: one order, a fleet. On lab-a against the public testbed unlaboredlabs/fleetd-testbed (as M7), a person
// gives one tier-L order through the app's /app protocol with a human key: three short pages, one writer each. The
// lead (a real haiku turn) freezes the brief and spawns the writers; each PR gets two reviewers and a verifier; the
// train merges them. The harness only observes: it never spawns a task, so everything the recording shows is work the
// fleet did. It also subscribes to the live feed as the app does and checks what came over it: lanes with literal
// activity, tokens and sparklines, inside the feed's bounds.
//
//   FLEETD_LAB_SLOT=7 npm run lab -- demo                      (headless: the harness sends the order over /app)
//   FLEETD_LAB_SLOT=7 FLEETD_DEMO_ORDER=app npm run lab -- demo (recording: the app sends it; see RUN/demo/app.json)
//
// With FLEETD_DEMO_ORDER=app it writes RUN/demo/app.json ({ hubUrl, key, projectId, order }) as soon as the hub has a
// human key, then waits up to 10 minutes for that order to arrive from the app. Either way RUN/demo/timeline.jsonl
// gets one line per milestone with its wall-clock time, for cutting the recording. Costs about 15-25 haiku turns.
//
// FLEETD_DEMO_APP=<fleetd-app binary> also starts the app on the hub with the human key, recording its own window into
// FLEETD_DEMO_RECORD (default RUN/demo/rec; FLEETD_RECORD, macOS) from before the order until the merges; then it stops
// the app by its PID, which finishes the MP4. scripts/demo-mac.sh runs it so on a Mac.
//
// Only this run's PRs are closed afterwards, so a run on another machine against the same testbed is left alone.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Body, cli, HUB_PORT, LAB, type Lab, MODEL, requireGhLogin, scrubbedEnv, sleep } from "./harness.ts";
import { git, prepareCheckout, REPO, removeTestbedProject, TESTBED } from "./m7Train.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const FANOUT_MS = 180_000;
const CI_MS = 600_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
const DIR = `lab/${new Date().toISOString().slice(0, 19).replace(/\D/gu, "")}`;
const PAGES = ["alpha", "beta", "gamma"] as const;
/** On screen before the order goes in, and after the last merge: the board settled, for the cut. */
const APP_HOLD_MS = 6_000;
const POLICY = `areas:
${PAGES.map((p) => `  ${p}: ["${DIR}/${p}.md"]`).join("\n")}
defaults:
  model: ${MODEL}
  effort: low
`;
export const ORDER = `Tier L. Add three short pages, ${DIR}/alpha.md, beta.md and gamma.md, each one paragraph on what fleetd's merge train does. One writer per page, all three in parallel. Give each page its own done-when check and its own PR.`;

/** One /app session: auth, calls, and the live frames it receives. */
const appSession = async (key: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${HUB_PORT}/app`);
  const waiting = new Map<string, { resolve: (v: Body) => void; reject: (e: Error) => void }>();
  const frames: Array<{ at: number; bytes: number; frame: Body }> = [];
  let ready: (() => void) | undefined;
  ws.onmessage = (event) => {
    const text = String(event.data);
    const m = JSON.parse(text) as Body;
    if (m.t === "ready") ready?.();
    if (m.t === "live") frames.push({ at: Date.now(), bytes: Buffer.byteLength(text), frame: m });
    const w = typeof m.id === "string" ? waiting.get(m.id) : undefined;
    if (w === undefined) return;
    waiting.delete(m.id);
    if (m.t === "result") w.resolve(m.output as Body);
    else w.reject(new Error(`${m.code}: ${m.message}`));
  };
  await new Promise<void>((resolve, reject) => {
    ready = resolve;
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", key }));
    ws.onerror = () => reject(new Error("cannot open /app"));
  });
  let nextId = 0;
  const call = (tool: string, input: Record<string, unknown> = {}) =>
    new Promise<Body>((resolve, reject) => {
      const id = `d${++nextId}`;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ t: "call", id, tool, input }));
    });
  const live = (board: boolean, focus?: string) => ws.send(JSON.stringify({ t: "live", board, ...(focus === undefined ? {} : { focus }) }));
  return { call, live, frames, close: () => ws.close() };
};

/** The app on the hub with the human key, recording itself; resolves once the recorder has a window. */
const startApp = async (lab: Lab, bin: string, key: string, out: string) => {
  fs.mkdirSync(out, { recursive: true });
  const logFile = path.join(lab.dir, "app.log");
  const child = spawn(bin, [], {
    env: { ...scrubbedEnv(), FLEETD_HUB_URL: lab.hubUrl, FLEETD_AGENT_KEY: key, FLEETD_RECORD: out },
    stdio: ["ignore", fs.openSync(logFile, "a"), fs.openSync(logFile, "a")],
  });
  lab.log(`started app pid=${child.pid}, recording into ${out}`);
  await lab.until("the app's recorder starts (app.log)", 60_000, async () => {
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    if (/FLEETD_RECORD error=|panicked/u.test(text) || child.exitCode !== null) throw new Error(`the app did not start recording; see ${logFile}`);
    if (text.includes("FLEETD_RECORD start")) return true;
    await sleep(250);
    return undefined;
  });
  return child;
};

/** SIGTERM by the spawn PID: the recorder finishes the MP4, then the app exits. */
const stopApp = async (lab: Lab, child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  await exited;
  clearTimeout(timer);
  lab.log(`stopped app pid=${child.pid} (${child.signalCode ?? `exit ${child.exitCode}`})`);
};

/** This hub's PRs on the testbed: every change it queued or refused since `from`. */
const ownPrs = async (lab: Lab, from: number) => {
  const prs = new Set<number>();
  for (let at = from; ; ) {
    const page = (await lab.callTool("events_wait", { cursor: at, types: ["change.queued", "change.refused"], timeoutSec: 0 })).body;
    for (const e of page.events as Array<Body>) {
      const n = e.data?.prNumber ?? Number(/\/pull\/(\d+)$/u.exec(String(e.data?.prUrl ?? ""))?.[1]);
      if (Number.isInteger(n) && n > 0) prs.add(n);
    }
    if (!page.more) return prs;
    at = page.cursor;
  }
};

/**
 * The node refuses to remove a project while one of its threads runs, and a late task result can wake the lead again,
 * so: interrupt every running or waiting thread of the testbed project, try the removal, and repeat for up to 2 min.
 */
const quiesceAndRemove = async (lab: Lab) => {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const listed = (await lab.callTool("projects_list", { machineId: MACHINE })).body.projects as Array<Body>;
    const project = listed.find((p) => p.workspaceRoot === TESTBED);
    if (project === undefined) return;
    const outcome = (await lab.callTool("project_get", { machineId: MACHINE, projectId: project.projectId })).body;
    // project_get lists the lead's thread; task threads come from their tasks.
    const tasks = (await lab.callTool("tasks_list", { projectRef: { machineId: MACHINE, projectId: project.projectId }, state: "running" })).body.tasks as Array<Body>;
    const active = [
      ...((outcome.threads ?? []) as Array<Body>).filter((t) => t.status === "running" || t.status === "waiting").map((t) => t.threadId as string),
      ...tasks.flatMap((t) => (t.threadRef === undefined ? [] : [t.threadRef.threadId as string])),
    ];
    for (const threadId of active) {
      await lab.callTool("thread_interrupt", { machineId: MACHINE, threadId, clientRequestId: `demo-stop-${threadId}-${Date.now()}` });
    }
    try {
      await removeTestbedProject(lab);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await lab.callTool("events_wait", { cursor: await lab.cursor(), machineId: MACHINE, types: ENDED, timeoutSec: 5 });
    }
  }
};

export async function demoFanout(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  requireGhLogin();
  check(fs.existsSync(path.join(TESTBED, ".git")), `${TESTBED} is a clone of ${REPO} (git clone https://github.com/${REPO} ${TESTBED})`);
  prepareCheckout(POLICY);
  ok(`${TESTBED} at origin/main ${git("rev-parse", "--short", "HEAD")}; untracked policy with areas ${PAGES.join(", ")} under ${DIR}`);
  fs.rmSync(lab.dir, { recursive: true, force: true });
  fs.mkdirSync(lab.dir, { recursive: true });
  const timeline = path.join(lab.dir, "timeline.jsonl");
  const mark = (what: string, data: Body = {}) => {
    fs.appendFileSync(timeline, `${JSON.stringify({ at: new Date().toISOString(), what, ...data })}\n`);
    ok(`${what}${Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : ""}`);
  };

  const scenarioStart = await lab.cursor();
  let app: Awaited<ReturnType<typeof appSession>> | undefined;
  let desktop: ChildProcess | undefined;
  const record = process.env.FLEETD_DEMO_RECORD ?? path.join(lab.dir, "rec");
  try {
    const projectId = await lab.addProject(MACHINE, TESTBED, "fleetd-testbed");
    const ref = { machineId: MACHINE, projectId };
    // The train must be thawed: an earlier M7 run may have left the freeze decision behind.
    const thaw = await callTool("train_freeze", { repo: REPO, frozen: false });
    lab.log(`train_freeze false: ${thaw.isError ? JSON.stringify(thaw.body) : "ok"}`);

    const started = await callTool("lead_start", { ...ref, model: MODEL, effort: "low" });
    check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
    const leadThread = started.body.threadId as string;
    await lab.waitEvent("lead start turn", TURN_MS, { cursor: scenarioStart, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });
    mark("lead ready", { thread: leadThread });

    // The person's key, as the desktop app pairs one.
    const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", lab.hubHome, "--human", "--name", "demo-app"))?.[0];
    check(key, "hub key create --human printed a key");
    app = await appSession(key!);
    app.live(true);
    if (process.env.FLEETD_DEMO_APP) {
      desktop = await startApp(lab, process.env.FLEETD_DEMO_APP, key!, record);
      await sleep(APP_HOLD_MS);
      mark("app recording", { record });
    }
    const fromApp = process.env.FLEETD_DEMO_ORDER === "app";
    const orderCursor = await lab.cursor();
    let workstreamId: string;
    if (fromApp) {
      const handoff = path.join(lab.dir, "app.json");
      fs.writeFileSync(handoff, `${JSON.stringify({ hubUrl: lab.hubUrl, key, machineId: MACHINE, projectId, order: ORDER }, null, 2)}\n`, { mode: 0o600 });
      mark("waiting for the order from the app", { handoff });
      await lab.waitEvent("the app's order", 600_000, { cursor: orderCursor, types: ["workstream.created"], match: (e) => e.projectId === projectId });
      workstreamId = ((await callTool("workstream_list", { ...ref, limit: 1 })).body.workstreams as Array<Body>)[0]!.workstreamId as string;
    } else {
      const placed = await app.call("intake_submit", { ...ref, text: ORDER, template: "feature", clientRequestId: `demo-${Date.now()}` });
      workstreamId = placed.workstreamId as string;
    }
    mark("order sent", { workstreamId });
    app.live(true, workstreamId);

    // The lead's wake (10 s debounce), then its brief and three writers. Only observed.
    await lab.waitEvent("the lead's wake", 60_000, { cursor: orderCursor, types: ["lead.woken"], match: (e) => e.threadId === leadThread });
    mark("lead woken");
    const writers = new Map<string, Body>();
    const startedAt = new Map<string, number>();
    let cursor = orderCursor;
    const fanout = Date.now();
    while (writers.size < 3) {
      const left = FANOUT_MS - (Date.now() - fanout);
      if (left <= 0) throw new Error(`the lead did not fan out within ${FANOUT_MS / 1000} s (${writers.size} of 3 writers started); run the demo again`);
      const next = await lab.waitEvent("a writer starts", left, { cursor, types: ["task.started"], match: (e) => e.data?.workstreamId === workstreamId });
      cursor = next.cursor;
      const task = (await callTool("task_get", { taskId: next.event.data.taskId })).body.task as Body;
      if (task.kind !== "write") continue;
      writers.set(task.taskId as string, task);
      startedAt.set(task.taskId as string, Date.parse(next.event.at as string));
      mark(`writer ${writers.size} started`, { taskId: task.taskId, title: task.title, areas: task.areas });
    }

    const verdict = await lab.waitEvent("the first review verdict", TURN_MS * 3, { cursor: orderCursor, types: ["review.verdict"] });
    mark("first review verdict", { taskId: verdict.event.data.taskId, blocking: verdict.event.data.blocking });

    const order = await app.call("order_get", { workstreamId });
    const roles = new Set([...(order.order.lanes as Array<Body>), ...(order.doneLanes as Array<Body>)].map((l) => l.role as string));
    check(roles.has("implementer") && roles.has("reviewer"), `order_get shows implementer and reviewer lanes: ${[...roles].join(", ")}`);
    mark("order_get", { phase: order.order.phase, detail: order.order.phaseDetail, roles: [...roles], prs: (order.order.prs as Array<Body>).map((p) => `#${p.number} ${p.state} ${p.reviewsDone}/${p.reviewsNeeded}`) });

    // Until three PRs merged or the order is done (a lead may claim done once its doneWhen passes, with a PR still
    // in review): either way the train moved.
    const merged = new Set<number>();
    cursor = orderCursor;
    for (let done = false; merged.size < 3 && !done; ) {
      const next = await lab.waitEvent(`pr.merged ${merged.size + 1} of 3 or ${workstreamId} done`, CI_MS + TURN_MS, {
        cursor,
        types: ["pr.merged", "workstream.done"],
        match: (e) => (e.type === "pr.merged" ? e.data?.repo === REPO : e.data?.workstreamId === workstreamId),
      });
      cursor = next.cursor;
      if (next.event.type === "workstream.done") {
        done = true;
        mark(`${workstreamId} done`, { merged: [...merged] });
      } else {
        merged.add(next.event.data.prNumber as number);
        mark(`PR ${merged.size} of 3 merged`, { pr: next.event.data.prNumber });
      }
    }
    check(merged.size === 3, `the train merged all three pages (${merged.size})`);
    const board = await app.call("orders_board", { projectRef: ref, includeDoneSince: new Date(Date.now() - 3_600_000).toISOString() });
    const trains = board.trains as Array<Body>;
    mark("board", { orders: (board.orders as Array<Body>).map((o) => `${o.workstreamId} ${o.phase} ${o.settled}/${o.total} "${o.title}"`), mergedToday: trains[0]?.mergedToday });
    for (const o of board.orders as Array<Body>) check((o.title as string).length <= 60, `card title is short: "${o.title}"`);
    if (desktop !== undefined) {
      await sleep(APP_HOLD_MS);
      await stopApp(lab, desktop);
      mark("app stopped", { mp4: path.join(record, "fleetd.mp4") });
    }

    // What came over the live feed, against its bounds.
    const frames = app.frames;
    check(frames.length > 0 && frames[0]!.frame.full === true, `live frames arrived, the first one full (${frames.length})`);
    const maxBytes = Math.max(...frames.map((f) => f.bytes));
    check(maxBytes <= 16 * 1024 + 64, `every live frame is at most 16 KB (max ${maxBytes})`);
    const perSecond = new Map<number, number>();
    for (const f of frames) perSecond.set(Math.floor(f.at / 1000), (perSecond.get(Math.floor(f.at / 1000)) ?? 0) + 1);
    const busiest = Math.max(...perSecond.values());
    check(busiest <= 5, `at most 4 live frames a second (busiest second: ${busiest})`);
    const lanes = frames.flatMap((f) => f.frame.lanes as Array<Body>);
    const kinds = new Set(lanes.flatMap((l) => (l.activity === undefined ? [] : [l.activity.activity.kind as string])));
    check(kinds.size > 0, "live lanes carried an activity");
    const withTokens = lanes.filter((l) => l.tokens !== undefined);
    const sparked = lanes.filter((l) => (l.spark?.samples as Array<number> | undefined)?.some((s) => s > 0));
    const texts = frames.reduce((n, f) => n + (f.frame.text as Array<Body>).length, 0);
    const bytes = frames.reduce((n, f) => n + f.bytes, 0);
    const span = (frames.at(-1)!.at - frames[0]!.at) / 1000;
    mark("live feed", { frames: frames.length, kb: Math.round(bytes / 1024), avgBytesPerSec: Math.round(bytes / Math.max(span, 1)), maxFrameBytes: maxBytes, busiestSecond: busiest, activityKinds: [...kinds], lanesWithTokens: withTokens.length, lanesWithWork: sparked.length, textAppends: texts });

    // Per writer lane, from the frames as they came: what it showed, and how soon after the hub saw it.
    fs.writeFileSync(path.join(lab.dir, "live-frames.jsonl"), frames.map((f) => JSON.stringify({ receivedAt: f.at, ...f.frame })).join("\n") + "\n");
    const lags: Array<number> = [];
    for (const [taskId, start] of startedAt) {
      const seen = frames.flatMap((f) => (f.frame.lanes as Array<Body>).filter((l) => l.laneId === taskId).map((l) => ({ at: Date.parse(f.frame.at as string), l })));
      const laneKinds = new Set(seen.flatMap((x) => (x.l.activity === undefined ? [] : [x.l.activity.activity.kind as string])));
      // Each activity once, at the first frame that carried it.
      const shown = new Set<string>();
      for (const x of seen) {
        if (x.l.activity === undefined) continue;
        const key = JSON.stringify(x.l.activity);
        if (shown.has(key)) continue;
        shown.add(key);
        lags.push(x.at - Date.parse(x.l.activity.since as string));
      }
      const first = (p: (l: Body) => boolean) => {
        const hit = seen.find((x) => p(x.l));
        return hit === undefined ? null : hit.at - start;
      };
      const tokenValues = new Set(seen.flatMap((x) => (x.l.tokens === undefined ? [] : [`${x.l.tokens.input}/${x.l.tokens.output}`])));
      const lane = {
        kinds: [...laneKinds],
        firstWorkMs: first((l) => l.activity !== undefined && l.activity.activity.kind !== "thinking"),
        firstTokensMs: first((l) => l.tokens !== undefined),
        liveTokenFrames: seen.filter((x) => x.l.tokens?.live === true).length,
        tokenValues: tokenValues.size,
        firstSparkMs: first((l) => (l.spark?.samples as Array<number> | undefined)?.some((v) => v > 0) === true),
      };
      mark(`lane ${taskId}`, lane);
      check(laneKinds.size > 0 && [...laneKinds].some((k) => k !== "thinking"), `${taskId} showed real work, not only thinking: ${[...laneKinds].join(",")}`);
      check(lane.firstSparkMs !== null, `${taskId}'s sparkline gained a sample`);
      check(lane.liveTokenFrames > 0, `${taskId} streamed live tokens`);
    }
    lags.sort((a, b) => a - b);
    const p = (q: number) => lags[Math.min(lags.length - 1, Math.floor(q * lags.length))];
    mark("activity lag (frame at minus activity since, ms)", { samples: lags.length, p50: p(0.5), p90: p(0.9), max: lags.at(-1) });

    // The turns this cost.
    const tasks = ((await callTool("tasks_list", { projectRef: ref, limit: 100 })).body.tasks as Array<Body>).filter((t) => t.workstreamId === workstreamId);
    const taskTurns = tasks.reduce((n, t) => n + (t.attempt as number), 0);
    let leadTurns = 0;
    for (let at = scenarioStart; ; ) {
      const page = (await callTool("events_wait", { cursor: at, machineId: MACHINE, types: ENDED, timeoutSec: 0 })).body;
      leadTurns += (page.events as Array<Body>).filter((e) => e.threadId === leadThread).length;
      if (!page.more) break;
      at = page.cursor;
    }
    mark("turns", { lead: leadTurns, tasks: taskTurns, byTask: tasks.map((t) => `${t.taskId} ${t.kind}×${t.attempt}`) });
  } finally {
    app?.close();
    if (desktop !== undefined) await stopApp(lab, desktop);
    const ours = await ownPrs(lab, scenarioStart).catch(() => new Set<number>());
    for (const pr of JSON.parse(spawnSync("gh", ["pr", "list", "-R", REPO, "--state", "open", "--json", "number"], { cwd: LAB, env: scrubbedEnv(), encoding: "utf8" }).stdout || "[]") as Array<Body>) {
      if (ours.has(pr.number as number)) spawnSync("gh", ["pr", "close", String(pr.number), "-R", REPO, "--delete-branch"], { cwd: LAB, env: scrubbedEnv(), stdio: "ignore" });
    }
    await quiesceAndRemove(lab).catch((error: unknown) => lab.log(`could not remove the testbed project: ${String(error)}`));
    fs.rmSync(path.join(TESTBED, ".fleetd"), { recursive: true, force: true });
  }
}
