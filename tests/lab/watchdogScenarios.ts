// M2 lab scenarios 2 (stall) and 6 (missed completion while the hub is down), against the
// disposable lab only. Run by the lab harness (`npm run lab -- stall missed`).
// Costs: one tiny claude-opus-5-5 turn each.
import { randomUUID } from "node:crypto";
import { MECHANICS, sessionText, sleep } from "./harness.ts";

type Body = Record<string, any>;

/** What a scenario needs from the harness. */
export interface LabContext {
  /** Calls a tool on the hub's MCP endpoint with the harness's operate key. */
  readonly callTool: (name: string, args?: Record<string, unknown>) => Promise<{ readonly isError: boolean; readonly body: Body }>;
  /** Stops the hub by its PID, leaving the nodes and their sessions running. */
  readonly stopHub: () => Promise<void>;
  /** (Re)starts the hub on the same home with `env` added, waits for /healthz and reconnects the MCP client. */
  readonly startHub: (env?: Readonly<Record<string, string>>) => Promise<void>;
  readonly log: (line: string) => void;
}

/** A short stall threshold for scenario 2: 20 s outside a tool, 20 s + 20 s inside one that states no timeout. */
export const STALL_HUB_ENV = { FLEETD_STALL_SEC: "20" } as const;

const MODEL = "claude-opus-5-5";

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
    profile: MECHANICS,
    title,
    clientRequestId: randomUUID(),
  });
  check(!launched.isError, `thread_launch succeeded: ${JSON.stringify(launched.body)}`);
  return launched.body.threadId as string;
};

/**
 * Scenario 2. A thread runs `sleep 900` inside a tool under a short threshold. The watchdog emits
 * thread.failed{reason:"stalled"} (inside a tool) and interrupts the run, once: the run ends and no other starts.
 */
export async function stallFails(ctx: LabContext, machineId = "lab-a") {
  await ctx.startHub(STALL_HUB_ENV);
  const { projectId, cursor } = await ready(ctx, machineId);
  const events = eventsFrom(ctx, cursor);
  const threadId = await launch(
    ctx,
    machineId,
    projectId,
    "fleetd test:lab stall",
    // Unset, so the watchdog holds the call to FLEETD_STALL_SEC; a stated timeout (claude likes 600000 for a long
    // sleep) would be honoured, and the stall would take ten minutes.
    "Use the Bash tool to run exactly `sleep 900` in the foreground (not in the background), leaving the tool's timeout " +
      "parameter unset, and wait for it. Do nothing else.",
  );
  ctx.log(`ok  thread_launch ${machineId} -> ${threadId} (sleep 900)`);
  const mine = (e: Body) => e.threadId === threadId;

  const failed = await events.next("thread.failed{reason:stalled}", 240_000, (e) => mine(e) && e.type === "thread.failed");
  check(failed.data?.reason === "stalled", `failed for stalling: ${JSON.stringify(failed.data)}`);
  check(failed.data?.inTool === true, `the stall was seen inside the tool: ${JSON.stringify(failed.data)}`);
  ctx.log(`ok  thread.failed seq=${failed.seq} reason=${failed.data.reason} "${failed.summary}"`);

  const ended = await events.next("the stalled run ends", 60_000, (e) => mine(e) && e.type === "thread.interrupted");
  ctx.log(`ok  thread.interrupted seq=${ended.seq}`);
  // Nothing continues it: the lead decides. Two thresholds is long enough for a nudge to have gone out.
  const quiet = Date.now() + 40_000;
  let at = ended.seq as number;
  while (Date.now() < quiet) {
    const page = (await ctx.callTool("events_wait", { cursor: at, timeoutSec: 10 })).body;
    const next = (page.events as Array<Body>).find((e) => mine(e) && e.type === "thread.started");
    check(next === undefined, `no run after the stall: ${JSON.stringify(next)}`);
    at = page.cursor;
  }
  ctx.log("ok  no run after the stall");
}

/**
 * Watches the machine itself (no hub) until the thread's run has ended: the node's transcript of claude's stdout gets
 * the run's `result` line, and claude's own session file the reply.
 */
const waitRunEnded = async (machineId: string, threadId: string, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // The transcript may hold claude's lines as they came or quoted inside a wrapper.
    if (/\\?"type\\?":\s*\\?"result\\?"/u.test(sessionText(machineId, threadId))) return;
    await sleep(500);
  }
  throw new Error(`timed out after ${ms / 1000}s: ${machineId} ended the run of ${threadId}`);
};

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

  await waitRunEnded(machineId, threadId, 180_000);
  ctx.log(`ok  ${machineId} ended the run while the hub was down`);

  await ctx.startHub();
  const late = await events.next("late terminal event", 180_000, (e) => e.threadId === threadId && e.type !== "thread.started");
  check(late.type === "thread.completed", `the missed run is reported as completed: ${JSON.stringify(late)}`);
  check(late.data?.late === true && typeof late.data?.runId === "string", `marked late with its run: ${JSON.stringify(late.data)}`);
  ctx.log(`ok  thread.completed seq=${late.seq} late=${late.data.late} "${late.summary}"`);
}
