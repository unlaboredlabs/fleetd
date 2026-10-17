// M2 lab scenarios 2 (stall, nudge, fail) and 6 (missed completion while the hub is down), against the
// disposable lab only. Each scenario takes a LabContext so the `pnpm test:lab` harness can run it; run
// this file directly to run both on their own (`node apps/hub/src/lab/watchdogScenarios.ts [stall|missed]`).
// Costs: scenario 2 two or three tiny claude-haiku-5-5 turns, scenario 6 one.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ORCHESTRATION_V2_WS_METHODS as M, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { connect } from "../executor/T3Connection.ts";
import { NUDGE } from "../watchdog/Watchdog.ts";

type Body = Record<string, any>;

export interface LabMachine {
  readonly id: string;
  readonly t3Home: string;
  readonly t3Url: string;
}

/** What a scenario needs from the harness. */
export interface LabContext {
  readonly machines: ReadonlyArray<LabMachine>;
  /** Calls a tool on the hub's MCP endpoint with the harness's operate key. */
  readonly callTool: (name: string, args?: Record<string, unknown>) => Promise<{ readonly isError: boolean; readonly body: Body }>;
  /** Stops the hub by its PID, leaving nodes and T3 running. */
  readonly stopHub: () => Promise<void>;
  /** (Re)starts the hub on the same home with `env` added, waits for /healthz and reconnects the MCP client. */
  readonly startHub: (env?: Readonly<Record<string, string>>) => Promise<void>;
  /** A short-lived bearer for the lab T3 itself, to watch it while the hub is down. */
  readonly mintT3Bearer: (machine: LabMachine) => string;
  readonly log: (line: string) => void;
}

/** Short watchdog thresholds for scenario 2: 20 s outside a tool, tool timeout (10 s) + 20 s inside. */
export const STALL_HUB_ENV = {
  FLEETD_STALL_OUTSIDE_SEC: "20",
  FLEETD_STALL_TOOL_TIMEOUT_SEC: "10",
  FLEETD_STALL_INSIDE_GRACE_SEC: "20",
  FLEETD_WATCHDOG_EVERY_SEC: "2",
} as const;

const MODEL = "claude-haiku-5-5";

const check = (cond: unknown, what: string): void => {
  if (!cond) throw new Error(`check failed: ${what}`);
};

async function until<A>(what: string, ms: number, probe: () => Promise<A | undefined>): Promise<A> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out after ${ms / 1000}s: ${what}`);
}

/** Follows the hub's events from `cursor`; `next` long-polls for the first event matching `pred`. */
const eventsFrom = (ctx: LabContext, cursor: number) => {
  let at = cursor;
  return {
    next: (what: string, ms: number, pred: (e: Body) => boolean) =>
      until(what, ms, async () => {
        const page = (await ctx.callTool("events_wait", { cursor: at, timeoutSec: 20 })).body;
        for (const e of page.events as Array<Body>) {
          at = e.seq;
          if (pred(e)) return e;
        }
        at = page.cursor;
        return undefined;
      }),
  };
};

/** Waits until `machineId` is online with a project; returns its first project and the event cursor. */
const ready = async (ctx: LabContext, machineId: string) =>
  until(`${machineId} online with a project`, 120_000, async () => {
    const s = (await ctx.callTool("fleetd_status")).body;
    const online = s.machines.some((m: Body) => m.machineId === machineId && m.status === "online");
    const project = s.projects.find((p: Body) => p.machineId === machineId);
    if (online && project) return { projectId: project.projectId as string, cursor: s.cursor as number };
    await ctx.callTool("events_wait", { cursor: s.cursor, timeoutSec: 3 });
    return undefined;
  });

const launch = async (ctx: LabContext, machineId: string, projectId: string, title: string, prompt: string) => {
  const launched = await ctx.callTool("thread_launch", {
    machineId,
    projectId,
    prompt,
    model: MODEL,
    effort: "low",
    title,
    clientRequestId: randomUUID(),
  });
  check(!launched.isError, `thread_launch succeeded: ${JSON.stringify(launched.body)}`);
  return launched.body.threadId as string;
};

/**
 * Scenario 2. A thread runs `sleep 900` inside a tool under short thresholds. The watchdog emits
 * thread.stalled (inside a tool), interrupts, sends one "continue"; the continuation sleeps again and
 * stalls, and the watchdog emits thread.failed{reason:"stalled"} with no second nudge.
 */
export async function stallNudgeFail(ctx: LabContext, machineId = "lab-a") {
  await ctx.startHub(STALL_HUB_ENV);
  const { projectId, cursor } = await ready(ctx, machineId);
  const events = eventsFrom(ctx, cursor);
  const threadId = await launch(
    ctx,
    machineId,
    projectId,
    "fleetd test:lab stall",
    "Use the Bash tool to run exactly `sleep 900` in the foreground (not in the background) and wait for it. " +
      "If you are interrupted or asked to continue, run `sleep 900` in the foreground again. Do nothing else.",
  );
  ctx.log(`ok  thread_launch ${machineId} -> ${threadId} (sleep 900)`);
  const mine = (e: Body) => e.threadId === threadId;

  const stalled = await events.next("thread.stalled", 180_000, (e) => mine(e) && e.type === "thread.stalled");
  check(stalled.data?.inTool === true, `the stall was seen inside the tool: ${JSON.stringify(stalled.data)}`);
  ctx.log(`ok  thread.stalled seq=${stalled.seq} "${stalled.summary}"`);

  const failed = await events.next("thread.failed{reason:stalled}", 240_000, (e) => {
    check(!(mine(e) && e.type === "thread.stalled"), `no second thread.stalled: ${JSON.stringify(e)}`);
    return mine(e) && e.type === "thread.failed";
  });
  check(failed.data?.reason === "stalled", `failed for stalling: ${JSON.stringify(failed.data)}`);
  check(failed.data?.runId !== stalled.data?.runId, "the second stall was on the continuation run");
  ctx.log(`ok  thread.failed seq=${failed.seq} reason=${failed.data.reason} "${failed.summary}"`);

  const tail = (await ctx.callTool("thread_tail", { machineId, threadId, n: 50, kinds: ["message"] })).body;
  const nudges = (tail.items as Array<Body>).filter((i) => i.role === "user" && i.text === NUDGE);
  check(nudges.length === 1, `exactly one nudge in the thread: ${nudges.length}`);
  ctx.log(`ok  thread_tail: one "continue" nudge`);
}

const isDone = (threadId: string) => (t: OrchestrationV2ThreadShell) =>
  t.id === threadId && t.activeRunId === null && t.status === "completed";

/** Watches the lab T3 directly (no hub) until the thread's run has completed. */
const waitT3Completed = (ctx: LabContext, machine: LabMachine, threadId: string, ms: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* connect(machine.t3Url, ctx.mintT3Bearer(machine));
      const done = isDone(threadId);
      const hit = yield* client[M.subscribeShell]({}).pipe(
        Stream.filter((i) =>
          i.kind === "snapshot" ? i.snapshot.threads.some(done) : i.kind === "thread.updated" ? done(i.thread) : false,
        ),
        Stream.runHead,
        Effect.timeout(`${ms} millis`),
      );
      check(Option.isSome(hit), "T3 reported the run completed");
    }).pipe(Effect.scoped),
  );

/**
 * Scenario 6. The hub sees a run start, is stopped, the run completes, the hub starts again: it emits
 * thread.completed for that run with late: true.
 */
export async function missedCompletion(ctx: LabContext, machineId = "lab-a") {
  await ctx.startHub();
  const { projectId, cursor } = await ready(ctx, machineId);
  const events = eventsFrom(ctx, cursor);
  const threadId = await launch(
    ctx,
    machineId,
    projectId,
    "fleetd test:lab missed completion",
    "Use the Bash tool to run exactly `sleep 20` in the foreground, then reply with the single word DONE.",
  );
  const started = await events.next("thread.started", 120_000, (e) => e.threadId === threadId && e.type === "thread.started");
  ctx.log(`ok  thread.started seq=${started.seq}; stopping the hub mid-run`);
  await ctx.stopHub();

  const machine = ctx.machines.find((m) => m.id === machineId)!;
  await waitT3Completed(ctx, machine, threadId, 180_000);
  ctx.log("ok  T3 completed the run while the hub was down");

  await ctx.startHub();
  const late = await events.next("late terminal event", 180_000, (e) => e.threadId === threadId && e.type !== "thread.started");
  check(late.type === "thread.completed", `the missed run is reported as completed: ${JSON.stringify(late)}`);
  check(late.data?.late === true && typeof late.data?.runId === "string", `marked late with its run: ${JSON.stringify(late.data)}`);
  ctx.log(`ok  thread.completed seq=${late.seq} late=${late.data.late} "${late.summary}"`);
}

// ---------------------------------------------------------------------------------------------------
// Standalone runner: the same lab setup testLab.ts uses, with its own hub port and run dir.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const LAB = process.env.FLEETD_LAB ?? path.join(os.homedir(), "src/fleetd-lab");
const T3_SRC = process.env.T3_SRC ?? path.join(LAB, "t3-src");
const CLI = path.join(REPO, "apps/cli/src/bin.ts");

/** Children get HOME, PATH, USER and LANG only (never this session's CLAUDE* variables), plus `extra`. */
const scrubbedEnv = (extra: Readonly<Record<string, string>> = {}) => ({
  ...Object.fromEntries(["HOME", "PATH", "USER", "LANG"].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]]))),
  ...extra,
});

async function standalone() {
  if (path.resolve(LAB).startsWith(path.join(os.homedir(), ".t3"))) throw new Error("refusing: lab dir is inside ~/.t3");
  const hubPort = Number(process.env.FLEETD_LAB_HUB_PORT ?? 4796);
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  const run = path.join(LAB, "e2e-watchdog");
  const hubHome = path.join(run, "hub");
  const machines: Array<LabMachine> = [{ id: "lab-a", t3Home: path.join(LAB, "home-a"), t3Url: "http://127.0.0.1:4711" }];
  const t0 = Date.now();
  const log = (line: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}\n`);
  const children = new Map<string, ChildProcess>();
  const cli = (...args: Array<string>) => execFileSync(process.execPath, [CLI, ...args], { env: scrubbedEnv(), encoding: "utf8" });
  const start = (name: string, args: Array<string>, env: Readonly<Record<string, string>> = {}) => {
    fs.mkdirSync(path.join(run, "logs"), { recursive: true });
    const out = fs.openSync(path.join(run, "logs", `${name}.log`), "a");
    const child = spawn(process.execPath, [CLI, ...args], { env: scrubbedEnv(env), stdio: ["ignore", out, out] });
    children.set(name, child);
    log(`started ${name} pid=${child.pid}`);
  };
  const stop = async (name: string) => {
    const child = children.get(name);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
    log(`stopped ${name} pid=${child.pid}`);
  };
  const lab = (command: "up" | "down", id: string) =>
    execFileSync(process.execPath, [path.join(REPO, "lab/lab.mjs"), command, id], { env: scrubbedEnv(), encoding: "utf8" });

  let client: Client | undefined;
  let key = "";
  const ctx: LabContext = {
    machines,
    log,
    callTool: async (name, args = {}) => {
      const result = await client!.callTool({ name, arguments: args }, undefined, { timeout: 70_000 });
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      return { isError: result.isError === true, body: JSON.parse(text) as Body };
    },
    stopHub: async () => {
      await client?.close().catch(() => undefined);
      client = undefined;
      await stop("hub");
    },
    startHub: async (env = {}) => {
      await ctx.stopHub();
      start("hub", ["hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${hubPort}`], env);
      await until("hub /healthz", 30_000, async () => {
        try {
          return (await fetch(`${hubUrl}/healthz`)).ok ? true : undefined;
        } catch {
          await new Promise((r) => setTimeout(r, 250));
          return undefined;
        }
      });
      if (key === "") {
        key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", hubHome, "--name", "lab", "--role", "operate", "--machines", "*"))![0];
      }
      client = new Client({ name: "fleetd-watchdog-lab", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${hubUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport,
      );
      log(`hub up on ${hubUrl}${Object.keys(env).length > 0 ? ` with ${Object.keys(env).join(", ")}` : ""}`);
    },
    mintT3Bearer: (m) =>
      execFileSync(
        process.execPath,
        [path.join(T3_SRC, "apps/server/src/bin.ts"), "auth", "session", "issue", "--base-dir", m.t3Home, "--ttl", "1h", "--label", "fleetd-lab", "--token-only"],
        { env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      )
        .trim()
        .split("\n")
        .at(-1)!
        .trim(),
  };

  const labStarted: Array<string> = [];
  for (const m of machines) if (!/already running/u.test(lab("up", m.id))) labStarted.push(m.id);
  try {
    fs.rmSync(run, { recursive: true, force: true });
    await ctx.startHub();
    for (const m of machines) {
      const token = /^\S{16,}$/mu.exec(cli("hub", "token", "create", "--home", hubHome, "--machine", m.id))![0];
      start(`node-${m.id}`, [
        "node", "join", "--hub", hubUrl, "--token", token, "--machine", m.id, "--t3-home", m.t3Home, "--t3-url", m.t3Url,
        "--t3-cmd", `${process.execPath} ${path.join(T3_SRC, "apps/server/src/bin.ts")}`, "--home", path.join(run, `node-${m.id}`),
      ]);
    }
    const only = process.argv[2];
    if (only === undefined || only === "stall") await stallNudgeFail(ctx);
    if (only === undefined || only === "missed") await missedCompletion(ctx);
    log("PASS");
  } finally {
    await ctx.stopHub();
    for (const name of [...children.keys()].reverse()) await stop(name);
    for (const id of labStarted) log(lab("down", id).trim());
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  standalone().catch((error: unknown) => {
    process.stdout.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
