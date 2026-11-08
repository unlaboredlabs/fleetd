// Pure view of one thread for thread_tail, actions_list and agent_work (crates/fleetd/src/hub/executor/thread_view.rs),
// built from the node's bounded thread snapshot (the newest window of the session) plus the live events after it.
import type { ItemStatus, PendingPermission, RunInfo, ThreadEvent, ThreadItem, ThreadMessage } from "../../shared/sessions.ts";
import { jsPrefix, keepTail } from "../../shared/text.ts";
import { parseMs } from "../store/time.ts";
import { failureClass, normalizeIso } from "./shell_mapper.ts";

export type ThreadView = {
  messages: Map<string, ThreadMessage>;
  items: Map<string, ThreadItem>;
  runs: Map<string, RunInfo>;
  /** False until the first snapshot arrives. */
  ready: boolean;
};

export const newView = (): ThreadView => ({ messages: new Map(), items: new Map(), runs: new Map(), ready: false });

/** The hub's ActionItem, field for field. */
export type Action = {
  at: string;
  kind: "command" | "file_change" | "tool_call" | "other";
  status: "completed" | "failed" | "running";
  summary: string;
  outputTail?: string;
  exitCode?: number;
  failed: boolean;
};

/** The hub's TailItem: a message or an action. */
export type TailRow = { kind: "message"; at: string; role: string; text: string } | { kind: "action"; at: string; action: Action };

/** Set while a command or tool call of the run is open. */
export type OpenTool = { statedTimeoutMs?: number; unstated: boolean };

/** Mutates `view` with one thread event. A snapshot replaces it. Deltas and usage are for app subscribers only. */
export function applyThreadEvent(view: ThreadView, event: ThreadEvent): void {
  switch (event.type) {
    case "snapshot":
      view.messages = new Map(event.messages.map((m) => [m.id, m]));
      view.items = new Map(event.items.map((i) => [i.id, i]));
      view.runs = new Map(event.runs.map((r) => [r.id, r]));
      view.ready = true;
      return;
    case "message": {
      const { type: _type, ...m } = event;
      view.messages.set(m.id, m);
      return;
    }
    case "item": {
      const { type: _type, ...i } = event;
      view.items.set(i.id, i);
      return;
    }
    case "run": {
      const { type: _type, ...r } = event;
      view.runs.set(r.id, r);
      return;
    }
    default:
      return;
  }
}

export function latestAssistantText(view: ThreadView): string | undefined {
  let best: ThreadMessage | undefined;
  for (const m of view.messages.values()) {
    if (m.role !== "assistant" || m.text.trim() === "") continue;
    // Rust's `Option` order: an unparsable time is before every parsable one.
    const at = parseMs(m.createdAt) ?? Number.NEGATIVE_INFINITY;
    const bestAt = best ? (parseMs(best.createdAt) ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
    if (!best || at >= bestAt) best = m;
  }
  return best?.text;
}

const itemStatus = (s: ItemStatus): Action["status"] => (s === "completed" ? "completed" : s === "running" ? "running" : "failed");

/** The node's own retry of a run, as actions_list shows it (the lab asserts this text). */
export function nodeRetrySummary(attempt: number, of: number, delayMs: number, cls: string): string {
  const delay = delayMs % 1000 === 0 ? `${delayMs / 1000} s` : `${delayMs} ms`;
  return `node retry ${attempt}/${of} in ${delay}: ${cls}`;
}

/** The action an item records, or undefined for permission prompts and compactions. */
export function toAction(item: ThreadItem): Action | undefined {
  const at = normalizeIso(item.completedAt ?? item.startedAt);
  const status = itemStatus(item.status);
  const base = (kind: Action["kind"], summary: string, output: string | undefined, exitCode: number | undefined): Action => ({
    at,
    kind,
    status,
    summary: jsPrefix(summary, 200),
    ...(output !== undefined && output !== "" ? { outputTail: keepTail(output, 1024) } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    failed: status === "failed" || (exitCode !== undefined && exitCode !== 0),
  });
  const title = (fallback: string) => (item.title.trim() === "" ? fallback : item.title);
  const k = item.kind;
  switch (k.type) {
    case "command":
      return base("command", k.command, k.output, k.exitCode);
    case "file_change":
      return base("file_change", k.path, undefined, undefined);
    case "tool":
      return base("tool_call", title(k.toolName), k.output, undefined);
    case "api_retry": {
      const s = k.errorStatus !== undefined ? ` ${k.errorStatus}` : "";
      return base("other", `API retry ${k.attempt}/${k.maxRetries}:${s} ${k.error}`, undefined, undefined);
    }
    case "node_retry":
      return base("other", nodeRetrySummary(k.attempt, k.of, k.delayMs, failureClass(k.reason.class)), undefined, undefined);
    case "error":
      return { ...base("other", `${failureClass(k.failure.class)}: ${k.failure.message}`, undefined, undefined), status: "failed", failed: true };
    default:
      return undefined;
  }
}

/** Rust's stable sort, newest first by `at`. */
const newestFirst = <T>(xs: T[], at: (x: T) => string) => xs.sort((a, b) => (at(b) < at(a) ? -1 : at(b) > at(a) ? 1 : 0));
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Items whose output the bounded snapshot cut; fetch them in full with `read_item`. */
export function omittedOutputs(view: ThreadView, ids: string[]): string[] {
  return ids.filter((id) => {
    const k = view.items.get(id)?.kind;
    return (k?.type === "command" || k?.type === "tool") && k.outputOmitted === true;
  });
}

/** Newest-first actions with their item ids. */
export function actionsOf(view: ThreadView, limit: number, failedOnly: boolean): [string, Action][] {
  const out: [string, Action][] = [];
  for (const item of view.items.values()) {
    const a = toAction(item);
    if (a && (!failedOnly || a.failed)) out.push([item.id, a]);
  }
  // Order equal timestamps by id so output is stable.
  out.sort((a, b) => cmpStr(a[0], b[0]));
  newestFirst(out, ([, a]) => a.at);
  return out.slice(0, limit);
}

/** What a tool call or command read: its call and its whole output as the view holds it. */
export function readOf(item: ThreadItem): [string, string] | undefined {
  const k = item.kind;
  let call: string;
  let output: string | undefined;
  if (k.type === "tool") {
    call = `${k.toolName} ${JSON.stringify(k.input)}`;
    output = k.output;
  } else if (k.type === "command") {
    call = k.command;
    output = k.output;
  } else return undefined;
  return output !== undefined && output !== "" ? [jsPrefix(call, 500), output] : undefined;
}

/** Newest-first tail rows with their ids, and whether any text was trimmed to its limit. */
export function tailOf(view: ThreadView, n: number, kinds: string[] | undefined): [[string, TailRow][], boolean] {
  const want = (k: string) => kinds === undefined || kinds.length === 0 || kinds.includes(k);
  let truncated = false;
  const rows: [string, TailRow][] = [];
  if (want("message")) {
    const messages = [...view.messages.values()].sort((a, b) => cmpStr(a.id, b.id));
    for (const m of messages) {
      if (m.text.trim() === "") continue;
      if (m.text.length > 2000) truncated = true;
      rows.push([m.id, { kind: "message", at: normalizeIso(m.createdAt), role: m.role, text: keepTail(m.text, 2000) }]);
    }
  }
  if (want("action")) for (const [id, action] of actionsOf(view, Number.MAX_SAFE_INTEGER, false)) rows.push([id, { kind: "action", at: action.at, action }]);
  newestFirst(rows, ([, r]) => r.at);
  return [rows.slice(0, n), truncated];
}

/** Every message and action, newest first by `(at, id)`, strictly before `before` when given; and whether more remain. */
export function workPage(view: ThreadView, before: [string, string] | undefined, limit: number): [[string, TailRow][], boolean] {
  let [rows] = tailOf(view, Number.MAX_SAFE_INTEGER, undefined);
  rows.sort(([aId, a], [bId, b]) => cmpStr(b.at, a.at) || cmpStr(bId, aId));
  if (before) rows = rows.filter(([id, r]) => r.at < before[0] || (r.at === before[0] && id < before[1]));
  return [rows.slice(0, limit), rows.length > limit];
}

const QUESTION_MAX = 1500;

/** What a thread waiting on a human is asking: the tool and what it would do. */
export function pendingQuestionText(pending: PendingPermission): string {
  const summary = pending.summary.trim();
  const text = summary === "" ? `approve a ${pending.toolName} call` : `approve ${pending.toolName}: ${summary}`;
  return text.length > QUESTION_MAX ? `${jsPrefix(text, QUESTION_MAX - 1)}…` : text;
}

/** The open tool calls of `runId`, if any. A command states its own timeout; other tools state none. */
export function openTool(view: ThreadView, runId: string | undefined): OpenTool | undefined {
  let open = false;
  let unstated = false;
  let stated: number | undefined;
  for (const item of view.items.values()) {
    let timeout: number | undefined;
    if (item.kind.type === "command") timeout = item.kind.timeoutMs;
    else if (item.kind.type !== "tool") continue;
    if (item.status !== "running") continue;
    if (runId !== undefined && item.runId !== runId) continue;
    open = true;
    if (timeout === undefined || timeout <= 0) unstated = true;
    else stated = Math.max(stated ?? 0, timeout);
  }
  return open ? { ...(stated !== undefined ? { statedTimeoutMs: stated } : {}), unstated } : undefined;
}
