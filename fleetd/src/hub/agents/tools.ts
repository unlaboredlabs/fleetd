// agents_list and agent_work. Both read-only.
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import { offline } from "../api/refusals.ts";
import type { Registry } from "../api/registry.ts";
import { executors } from "../executor/index.ts";
import { fromExecutor } from "../executor/tools.ts";
import { isoMs } from "../store/time.ts";
import { AGENTS_MAX, rows } from "./index.ts";
import { cursorOf, fitPage, parseCursor, stepOf, WORK_PAGE_MAX_BYTES } from "./paging.ts";

export function register(tools: Registry): void {
  tools.add("agents_list", (hub, caller, input) => {
    if (input.projectRef) requireRole(caller, "read", input.projectRef.machineId);
    const [agents, truncated] = rows(hub, caller, input.projectRef, input.endedSince, AGENTS_MAX);
    return {
      agents,
      at: isoMs(hub.clock.now()),
      next: "agent_work with a row's threadRef reads what it did; live { agent: laneId } streams its text.",
      ...(truncated ? { truncated: true } : {}),
    };
  });
  registerWork(tools);
}

export { cursorOf, fitPage, parseCursor, stepOf, WORK_PAGE_MAX_BYTES } from "./paging.ts";

export function registerWork(tools: Registry): void {
  tools.add("agent_work", async (hub, caller, input) => {
    requireRole(caller, "read", input.machineId);
    if (!executors(hub).isConnected(input.machineId)) throw offline(input.machineId);
    let before: [string, string] | undefined;
    if (input.before !== undefined) {
      before = parseCursor(input.before);
      if (!before) {
        throw new ToolError(
          "invalid",
          "That cursor is not one agent_work gave.",
          "Pass the `before` of an earlier agent_work answer, or leave it out for the newest steps.",
        );
      }
    }
    const limit = Math.max(1, input.limit ?? 20);
    let work;
    try {
      work = await executors(hub).views.work({ machineId: input.machineId, threadId: input.threadId }, before, limit);
    } catch (error) {
      throw fromExecutor(error);
    }
    const steps = work.rows.flatMap(([id, row]) => {
      const step = stepOf(id, row);
      return step ? [step] : [];
    });
    const [page, cut] = fitPage(steps, WORK_PAGE_MAX_BYTES);
    const more = work.more || cut;
    const oldest = page[0];
    return { steps: page, ...(oldest && more ? { before: cursorOf(oldest) } : {}), running: work.running };
  });
}
