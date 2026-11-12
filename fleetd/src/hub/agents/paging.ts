// agent_work's pages, with no executor behind them (tools.ts reads the steps): cursors, a step from a view row with
// secrets replaced, and a page cut to its bytes.
import type { WorkStep } from "../../shared/contracts.ts";
import { redact } from "../../shared/redact.ts";
import { clip } from "../api/refusals.ts";
import type { Action, TailRow } from "../executor/thread_view.ts";

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
