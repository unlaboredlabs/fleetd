// The usage layer over the real hub: who owns a thread, which Claude account
// it runs on, the write queue's "continue", and the machine's login from its runner. `usage(hub)` is the seam.
import type { LoginKind, TaskId } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { accountKey, ClaudeAccountStore } from "../claude_accounts/index.ts";
import { executors, READ_TIMEOUT_MS } from "../executor/index.ts";
import { leads } from "../leads/index.ts";
import { queuePorts } from "../leads/seams.ts";
import { prompts } from "../prompts/store.ts";
import { events } from "../store/events.ts";
import { ENDED_STATES, TaskRecords } from "../tasks/records.ts";
import { type Reading, Usage } from "./service.ts";
import type { Owner, ThreadKey } from "./state.ts";

/** `RunnerInfo.loginKind`: "subscription", "api_key", "token" (a gateway with its own base URL) or "none". */
export function loginKindOf(runnerLoginKind: string | undefined): LoginKind {
  switch (runnerLoginKind) {
    case "subscription":
      return "subscription";
    case "api_key":
      return "api_key";
    case "token":
      return "custom_base_url";
    default:
      return "unknown";
  }
}

/** setTimeout's longest wait; a longer one sleeps again. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Resolves after `ms`, or never once the hub stops. */
function hubSleep(hub: Hub, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const signal = hub.shutdown.signal;
    if (signal.aborted) return;
    const step = Math.min(ms, MAX_TIMER_MS);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      if (ms > step) void hubSleep(hub, ms - step).then(resolve);
      else resolve();
    }, step);
    const stop = () => clearTimeout(timer);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** The thread is a lead's current one. */
function isLeadThread(hub: Hub, machineId: string, threadId: string): boolean {
  try {
    return leads(hub)
      .records.leadsList()
      .some((l) => l.projectRef.machineId === machineId && l.threadId === threadId);
  } catch (error) {
    console.warn("usage: listing leads failed:", error);
    return false;
  }
}

function ownerOf(hub: Hub, thread: ThreadKey): Owner | undefined {
  try {
    const stored = TaskRecords.byThread(hub.db.conn, thread);
    if (stored) return { kind: stored.task.kind, taskId: stored.task.taskId };
  } catch (error) {
    console.warn("usage: reading a thread's task failed:", error);
  }
  return isLeadThread(hub, thread.machineId, thread.threadId) ? { kind: "lead" } : undefined;
}

function accountOf(hub: Hub, thread: ThreadKey): string | undefined {
  try {
    const account = new ClaudeAccountStore(hub.db).threadAccount(thread.machineId, thread.threadId);
    return account && accountKey(account);
  } catch (error) {
    console.warn("usage: reading a thread's Claude account failed:", error);
    return undefined;
  }
}

/** The hub's usage layer: `usage(hub).gate(machineId)`. Its loops (loops.ts) replay and follow the log. */
export const usage = (hub: Hub): Usage =>
  hub.area(
    "usage",
    (h) =>
      new Usage({
        events: events(h),
        clock: h.clock,
        sleep: (ms) => hubSleep(h, ms),
        ownerOf: (thread) => ownerOf(h, thread),
        accountOf: (thread) => accountOf(h, thread),
        stillParked: (p) => {
          if (p.kind === "lead") return isLeadThread(h, p.thread.machineId, p.thread.threadId);
          if (p.taskId === undefined) return false;
          try {
            const stored = TaskRecords.get(h.db.conn, p.taskId as TaskId);
            return stored !== undefined && !ENDED_STATES.includes(stored.task.state);
          } catch (error) {
            console.warn("usage: reading a task failed:", error);
            return false;
          }
        },
        sendContinue: async (thread, id) => {
          const message = prompts(h.db).forThread(thread.machineId, thread.threadId).render("usage.continue", {});
          await queuePorts(h).send(thread, message, id);
        },
      }),
  );

/** The machine's login, from its runner; an error (with the executor's message) when the machine is offline. */
export async function readLogin(hub: Hub, machineId: string): Promise<Reading> {
  try {
    const out = await executors(hub).call(machineId, "read", { op: "runner_info" }, READ_TIMEOUT_MS);
    if (out.kind !== "runner_info") return { error: "the node sent no runner info" };
    return { login: loginKindOf(out.loginKind) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
