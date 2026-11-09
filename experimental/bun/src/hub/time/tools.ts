// `time_spans`, `time_breakdown` and `time_insights` (crates/fleetd/src/hub/time/tools.rs), read on the hub's read
// workers (reads.ts says why), and `thread_window`, which reads a session's transcript around one item through the
// executor's thread view.
import type { Hub } from "../api/hub.ts";
import { requireRole } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { executors } from "../executor/index.ts";
import { fromExecutor } from "../executor/tools.ts";
import { time } from "./index.ts";
import { answer, type TimeJob } from "./reads.ts";

/** The job's answer from a read worker; on an in-memory database, which has none, read here. */
async function read(hub: Hub, job: TimeJob): Promise<never> {
  const readers = hub.db.readers();
  return (readers ? await readers.time(job) : answer(hub.db.conn, job)) as never;
}

const job = <T extends TimeJob["tool"]>(hub: Hub, caller: Caller, tool: T, input: Extract<TimeJob, { tool: T }>["input"]) =>
  ({ tool, input, caller, now: time(hub).nowMs() }) as TimeJob;

export function register(tools: Registry): void {
  tools.add("thread_window", async (hub, caller, input) => {
    requireRole(caller, "read", input.machineId);
    const r = { machineId: input.machineId, threadId: input.threadId };
    let rows;
    let focus;
    try {
      [rows, focus] = await executors(hub).views.window(r, input.itemId, input.before ?? 10, input.after ?? 10);
    } catch (error) {
      throw fromExecutor(error);
    }
    return {
      ...(focus === undefined ? {} : { focus: Math.max(0, focus) }),
      items: rows.slice(0, 51) as never,
      next: "thread_tail shows the newest entries.",
    };
  });
  tools.add("time_spans", (hub, caller, input) => read(hub, job(hub, caller, "time_spans", input)));
  tools.add("time_breakdown", (hub, caller, input) => read(hub, job(hub, caller, "time_breakdown", input)));
  tools.add("time_insights", (hub, caller, input) => read(hub, job(hub, caller, "time_insights", input)));
}
