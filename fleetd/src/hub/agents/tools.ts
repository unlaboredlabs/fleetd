// agents_list and agent_work. Both read-only.
import type { WorkStep } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { redact } from "../../shared/redact.ts";
import { requireRole } from "../api/grants.ts";
import { clip, offline } from "../api/refusals.ts";
import type { Registry } from "../api/registry.ts";
import { executors } from "../executor/index.ts";
import type { Action, TailRow } from "../executor/thread_view.ts";
import { fromExecutor } from "../executor/tools.ts";
import { isoMs } from "../store/time.ts";
import { AGENTS_MAX, rows } from "./index.ts";

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

const CURSOR_SEP = "|";
/** The most bytes of JSON one agent_work page carries. */
export const WORK_PAGE_MAX_BYTES = 48 * 1024;

/** The `(at, id)` a cursor names; `at` is an ISO stamp, which never holds the separator. */
export function parseCursor(cursor: string): [string, string] | undefined {
  const at = cursor.indexOf(CURSOR_SEP);
  if (at < 0) return undefined;
  const [a, id] = [cursor.slice(0, at), cursor.slice(at + 1)];
  return a !== "" && id !== "" ? [a, id] : undefined;
}

export const cursorOf = (step: WorkStep) => `${step.at}${CURSOR_SEP}${step.id}`;

/** One view row as a step, with secrets replaced. */
export function stepOf(id: string, row: TailRow): WorkStep | undefined {
  if (id === "") return undefined;
  if (row.kind === "message") {
    const role = row.role === "user" ? "user" : row.role === "system" ? "system" : "assistant";
    return { kind: "message", id, at: row.at, role, text: clip(redact(row.text), 2000) } as WorkStep;
  }
  const action: Action = { ...row.action, summary: clip(redact(row.action.summary), 200) };
  if (row.action.outputTail !== undefined) action.outputTail = clip(redact(row.action.outputTail), 1024);
  return { kind: "action", id, at: row.at, action } as WorkStep;
}

/** Steps newest first, cut to `maxBytes` of JSON; the page oldest first, and whether any were cut. */
export function fitPage(newestFirst: WorkStep[], maxBytes: number): [WorkStep[], boolean] {
  let used = 0;
  const page: WorkStep[] = [];
  for (const step of newestFirst) {
    const cost = Buffer.byteLength(JSON.stringify(step)) + 1;
    if (page.length > 0 && used + cost > maxBytes) break;
    used += cost;
    page.push(step);
  }
  return [page.reverse(), page.length < newestFirst.length];
}

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
