// Pure view of one thread for thread_tail / actions_list, built from T3's bounded thread snapshot
// (the newest window of the thread) plus the live events after it. Never pages oldest-first.
import type { ActionItem, TailItem } from "@fleetd/contracts";
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadView {
  readonly messages: Map<string, OrchestrationV2ConversationMessage>;
  readonly items: Map<string, OrchestrationV2TurnItem>;
  readonly runs: Map<string, OrchestrationV2Run>;
  /** False until the first snapshot arrives. */
  ready: boolean;
}

export const emptyView = (): ThreadView => ({ messages: new Map(), items: new Map(), runs: new Map(), ready: false });

const replace = <A extends { readonly id: string }>(target: Map<string, A>, xs: ReadonlyArray<A>) => {
  target.clear();
  for (const x of xs) target.set(x.id, x);
};

/** Mutates `view` with one thread stream item. A snapshot (first frame, or a resume past the replay budget) replaces it. */
export const applyThreadItem = (view: ThreadView, item: OrchestrationV2ThreadStreamItem): void => {
  if (item.kind === "snapshot") {
    replace(view.messages, item.projection.messages);
    replace(view.items, item.projection.turnItems);
    replace(view.runs, item.projection.runs);
    view.ready = true;
    return;
  }
  if (item.kind !== "event") return;
  const event = item.event;
  if (event.type === "message.updated") view.messages.set(event.payload.id, event.payload);
  else if (event.type === "turn-item.updated") view.items.set(event.payload.id, event.payload);
  else if (event.type === "run.created" || event.type === "run.updated") view.runs.set(event.payload.id, event.payload);
};

const iso = (dt: DateTime.DateTime) => DateTime.formatIso(dt);
const keepTail = (text: string, max: number) => (text.length <= max ? text : `…${text.slice(text.length - max + 1)}`);

export const latestAssistantText = (view: ThreadView): string | undefined => {
  let best: OrchestrationV2ConversationMessage | undefined;
  for (const m of view.messages.values()) {
    if (m.role !== "assistant" || m.text.trim() === "") continue;
    if (best === undefined || DateTime.toEpochMillis(m.createdAt) >= DateTime.toEpochMillis(best.createdAt)) best = m;
  }
  return best?.text;
};

const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export const activeRunId = (view: ThreadView): string | undefined => {
  let best: OrchestrationV2Run | undefined;
  for (const r of view.runs.values()) if (ACTIVE_RUN.has(r.status) && (best === undefined || r.ordinal > best.ordinal)) best = r;
  return best?.id;
};

/** Parses the "Exit code N" T3's Claude adapter puts in a failed command's output. */
export const parseExitCode = (output: string | undefined): number | undefined => {
  const m = output === undefined ? null : /\bExit code (\d+)\b/.exec(output);
  return m ? Number(m[1]) : undefined;
};

const itemStatus = (s: OrchestrationV2TurnItem["status"]): ActionItem["status"] =>
  s === "completed" ? "completed" : s === "failed" || s === "cancelled" || s === "interrupted" ? "failed" : "running";

const stringify = (v: unknown) => (v === undefined ? undefined : typeof v === "string" ? v : JSON.stringify(v));

/** The action a turn item records, or undefined for messages, reasoning, plans and bookkeeping. */
export const toAction = (item: OrchestrationV2TurnItem): ActionItem | undefined => {
  const at = iso(item.completedAt ?? item.startedAt ?? item.updatedAt);
  const status = itemStatus(item.status);
  const base = (kind: ActionItem["kind"], summary: string, output?: string, extra?: { exitCode?: number; failed?: boolean }) => {
    const exitCode = extra?.exitCode;
    const failed = status === "failed" || extra?.failed === true || (exitCode !== undefined && exitCode !== 0);
    return {
      at,
      kind,
      status,
      summary: summary.slice(0, 200),
      ...(output !== undefined && output !== "" ? { outputTail: keepTail(output, 1024) } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      failed,
    } satisfies ActionItem;
  };
  switch (item.type) {
    case "command_execution":
      return base("command", item.input, item.output, {
        ...(item.exitCode !== undefined || parseExitCode(item.output) !== undefined
          ? { exitCode: item.exitCode ?? parseExitCode(item.output)! }
          : {}),
        failed: item.outputIndicatesFailure === true,
      });
    case "file_change":
      return base("file_change", item.fileName);
    case "dynamic_tool":
      return base("tool_call", item.toolName ?? item.title ?? "tool", stringify(item.output));
    case "file_search":
      return base("tool_call", `file search: ${item.pattern ?? ""}`);
    case "web_search":
      return base("tool_call", `web search: ${(item.patterns ?? []).join(", ")}`);
    case "subagent":
      return base("tool_call", `subagent: ${item.prompt}`, item.result ?? undefined);
    case "error":
      return { ...base("other", `${item.failure.class}: ${item.failure.message}`), status: "failed", failed: true };
    default:
      return undefined;
  }
};

const newestFirst = <A extends { readonly at: string }>(xs: A[]) => xs.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

/** Command items whose output the bounded snapshot withheld; fetch them in full with getTurnItem. */
export const omittedOutputs = (view: ThreadView, ids: ReadonlyArray<string>) =>
  ids.filter((id) => {
    const item = view.items.get(id);
    return item !== undefined && (item.type === "command_execution" || item.type === "dynamic_tool") && item.outputOmitted === true;
  });

/** Newest-first actions with their item ids. */
export const actionsOf = (view: ThreadView, limit: number, failedOnly = false) =>
  newestFirst(
    [...view.items.values()].flatMap((item) => {
      const action = toAction(item);
      return action && (!failedOnly || action.failed) ? [{ id: item.id, at: action.at, action }] : [];
    }),
  ).slice(0, limit);

/** Newest-first tail items, and whether any text was trimmed to its limit. */
export const tailOf = (view: ThreadView, n: number, kinds?: ReadonlyArray<"message" | "action">) => {
  const want = (k: "message" | "action") => kinds === undefined || kinds.length === 0 || kinds.includes(k);
  let truncated = false;
  const rows: Array<TailItem & { readonly id: string }> = [];
  if (want("message")) {
    for (const m of view.messages.values()) {
      if (m.text.trim() === "") continue;
      if (m.text.length > 2000) truncated = true;
      rows.push({ id: m.id, kind: "message", at: iso(m.createdAt), role: m.role, text: keepTail(m.text, 2000) });
    }
  }
  if (want("action")) for (const a of actionsOf(view, Number.MAX_SAFE_INTEGER)) rows.push({ id: a.id, kind: "action", at: a.at, action: a.action });
  return { rows: newestFirst(rows).slice(0, n), truncated };
};
