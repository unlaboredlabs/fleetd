// M2 lab scenarios 2 (stall, nudge, fail) and 6 (missed completion while the hub is down), against the
// disposable lab only. Run by the lab harness (`npm run lab -- stall missed`).
// Both run in the project's lead. Costs: scenario 2 two or three mechanics turns (plus the lead's first if it has
// none), scenario 6 two (the lead's first turn and the message's).
import { randomUUID } from "node:crypto";
import { type Lab, leadRun, NUDGE, sessionText, sleep } from "./harness.ts";

type Body = Record<string, any>;

/** What a scenario needs from the harness: the MCP calls (operate and person keys), events, and the hub's process. */
export type LabContext = Pick<
  Lab,
  "callTool" | "humanCall" | "check" | "waitEvent" | "cursor" | "idleThread" | "stopHub" | "startHub" | "log"
>;

/** Short watchdog thresholds for scenario 2: 20 s outside a tool, tool timeout (10 s) + 20 s inside. */
export const STALL_HUB_ENV = {
  FLEETD_STALL_OUTSIDE_SEC: "20",
  FLEETD_STALL_TOOL_TIMEOUT_SEC: "10",
  FLEETD_STALL_INSIDE_GRACE_SEC: "20",
  FLEETD_WATCHDOG_EVERY_SEC: "2",
} as const;

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

/**
 * Scenario 2. A thread runs `sleep 900` inside a tool under short thresholds. The watchdog emits
 * thread.stalled (inside a tool), interrupts, sends one "continue"; the continuation sleeps again and
 * stalls, and the watchdog emits thread.failed{reason:"stalled"} with no second nudge.
 */
export async function stallNudgeFail(ctx: LabContext, machineId = "lab-a") {
  // The lead's own turns run under the normal thresholds: only the message's run is the stall under test.
  const { threadId, projectId } = await ctx.idleThread(machineId);
  await ctx.startHub(STALL_HUB_ENV);
  const { cursor } = await ready(ctx, machineId);
  const events = eventsFrom(ctx, cursor);
  const sent = await ctx.humanCall("chat_send", {
    projectRef: { machineId, projectId },
    // Unset, so the watchdog holds the call to FLEETD_STALL_TOOL_TIMEOUT_SEC; a stated timeout (claude likes 600000 for a
    // long sleep) would be honoured, and the stall would take ten minutes.
    text:
      "Use the Bash tool to run exactly `sleep 900` in the foreground (not in the background), leaving the tool's timeout " +
      "parameter unset, and wait for it. " +
      "If you are interrupted or asked to continue, run `sleep 900` in the foreground again. Do nothing else.",
    clientRequestId: randomUUID(),
  });
  check(!sent.isError && sent.body.leadWaiting === undefined, `chat_send: ${JSON.stringify(sent.body)}`);
  ctx.log(`ok  lead ${machineId}/${threadId} sent "sleep 900"`);
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
  // The hub's nudge is a fixed asset file now, so it arrives with the file's trailing newline; the words are exact.
  const nudges = (tail.items as Array<Body>).filter((i) => i.role === "user" && String(i.text).trimEnd() === NUDGE);
  check(nudges.length === 1, `exactly one nudge in the thread: ${nudges.length}`);
  ctx.log(`ok  thread_tail: one "continue" nudge`);
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
  const { projectId } = await ready(ctx, machineId);
  const { threadId, cursor } = await leadRun(
    ctx,
    machineId,
    projectId,
    "Use the Bash tool to run exactly `sleep 20` in the foreground, then reply with the single word DONE.",
  );
  const events = eventsFrom(ctx, cursor);
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
