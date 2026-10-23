// What the lead is doing right now, as one quiet line under its reply while its turn runs: its open tool call (from
// its live lane) and what the turn did so far (from the hub's events). Only real state: no line once the turn ends,
// and "working" when the hub says it works but nothing more is known.
import { eventData, isEvent, type Activity, type HubEvent, type ProjectRef } from "../../../shared/contracts";
import { leadLaneId, selectLeadWorking } from "../../src/data/selectors";
import type { DataState, ProjectKey } from "../../src/data/store";

const FLEETD = "mcp__fleetd__";

/** The lead's fleetd calls, by name or prefix, in plain words. */
const FLEETD_WORDS: readonly (readonly [string, string])[] = [
  ["plan_", "planning"],
  ["brief_create", "writing the brief"],
  ["workstream_open", "opening an order"],
  ["decisions_record", "noting a decision"],
  ["decisions_search", "looking up decisions"],
  ["task_message", "messaging an agent"],
  ["steer_send", "messaging an agent"],
  ["status_set", "updating the status"],
  ["change_", "moving a PR along"],
  ["slice_ready", "moving a PR along"],
];

/** A file's name, in backticks: the line sets it as code, the voice of machine text. */
const fileName = (path: string): string => `\`${path.split("/").filter(Boolean).at(-1) ?? path}\``;

/** One activity in the lead's words: what it does, never a raw tool name or command; a file's name as code. */
export const doingWords = (a: Activity): string => {
  switch (a.kind) {
    case "read":
      return a.path !== undefined && a.path !== "" ? `reading ${fileName(a.path)}` : "searching the code";
    case "edit":
      return `editing ${fileName(a.path)}`;
    case "command":
      return "running a command";
    case "writing":
      return "writing";
    case "thinking":
      return "thinking";
    case "compacting":
      return "compacting its context";
    case "retrying":
      return `retrying (${String(a.attempt)} of ${String(a.of)})`;
    case "tool": {
      if (a.name.startsWith(FLEETD)) {
        const op = a.name.slice(FLEETD.length);
        return FLEETD_WORDS.find(([name]) => (name.endsWith("_") ? op.startsWith(name) : op === name))?.[1] ?? "asking fleetd";
      }
      if (a.name === "Task" || a.name === "Agent") return "running a helper";
      if (a.name === "WebFetch" || a.name === "WebSearch") return "reading the web";
      if (a.name === "TodoWrite") return "planning";
      return "working";
    }
  }
};

const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/**
 * What the turn did so far: the orders it opened and the agents it spawned that started. The turn began at the
 * project's first "working" after its last "idle": the hub says "working" again mid-turn (a needs-you change, a
 * person's message, its restart), and that is no new turn. Nothing when that start is no longer among the events,
 * rather than part of the turn. An agent spawned before the turn (queued from an earlier order) is not counted, and an
 * agent is counted once however often it continues.
 */
export const turnTally = (events: readonly HubEvent[], ref: ProjectRef): string[] => {
  const ours = (e: HubEvent) => e.machineId === ref.machineId && e.projectId === ref.projectId;
  const idle = events.findLastIndex((e) => isEvent(e, "chat.waiting") && ours(e) && eventData(e)?.leadWorking !== true);
  // Past the last idle, every "working" is the same turn; its first is where the turn began.
  const start = idle === -1 ? -1 : events.findIndex((e, i) => i > idle && isEvent(e, "chat.waiting") && ours(e));
  const began = events[start];
  if (began === undefined) return [];
  const since = Date.parse(began.at);
  let orders = 0;
  const agents = new Set<string>();
  for (const e of events.slice(start + 1)) {
    if (!ours(e)) continue;
    if (e.type === "workstream.created") orders++;
    else if (isEvent(e, "task.started")) {
      const data = eventData(e);
      if (data?.createdAt !== undefined && Date.parse(data.createdAt) >= since) agents.add(data.taskId);
    }
  }
  return [
    ...(orders > 0 ? [orders === 1 ? "opened an order" : `opened ${String(orders)} orders`] : []),
    ...(agents.size > 0 ? [`started ${count(agents.size, "agent", "agents")}`] : []),
  ];
};

/** The line while the project's lead works ("planning · started 3 agents"), else undefined. */
export const leadActivity = (s: DataState, key: ProjectKey): string | undefined => {
  if (selectLeadWorking(key)(s) !== true) return undefined;
  const at = key.indexOf("/");
  const ref = { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
  const now = s.live.lanes[leadLaneId(ref)]?.activity?.activity;
  const parts = [...(now === undefined ? [] : [doingWords(now)]), ...turnTally(s.events, ref)];
  return parts.length === 0 ? "working" : parts.join(" · ");
};
