// The quiet line under the lead's reply. While its turn runs: how long it has worked, its open tool call (from its live
// lane) and what the turn did so far (from the hub's events). Once the turn ends: how long it worked. Only real state:
// elapsed time, never an estimate, and "working" when the hub says it works but nothing more is known.
import { eventData, isEvent, type Activity, type HubEvent, type ProjectRef } from "../../../shared/contracts";
import { leadLaneId, selectLeadWorking } from "../../src/data/selectors";
import type { DataState, ProjectKey } from "../../src/data/store";

const FLEETD = "mcp__fleetd__";

/** The lead's fleetd calls, by name or prefix, in plain words. */
const FLEETD_WORDS: readonly (readonly [string, string])[] = [
  ["plan_", "planning"],
  ["brief", "writing the brief"],
  ["decisions_record", "noting a decision"],
  ["decisions_search", "looking up decisions"],
  ["task_message", "messaging an agent"],
  ["steer_send", "messaging an agent"],
  ["change_", "moving a PR along"],
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

const ofProject = (ref: ProjectRef) => (e: HubEvent) => e.machineId === ref.machineId && e.projectId === ref.projectId;
const idleAt = (ours: (e: HubEvent) => boolean) => (e: HubEvent) => isEvent(e, "chat.waiting") && ours(e) && eventData(e)?.leadWorking !== true;

/**
 * The lead's latest turn, as indices into the events: it began at the project's first "working" after an "idle" (the
 * hub says "working" again mid-turn: a needs-you change, a person's message, its restart; that is no new turn), and
 * ended at the next "idle" (`end` -1 while it runs). Undefined when its start is no longer among the events, rather
 * than part of a turn.
 */
export const leadTurn = (events: readonly HubEvent[], ref: ProjectRef): { readonly start: number; readonly end: number } | undefined => {
  const ours = ofProject(ref);
  const isIdle = idleAt(ours);
  const firstWorking = (after: number, before: number) =>
    after === -1 ? -1 : events.findIndex((e, i) => i > after && i < before && isEvent(e, "chat.waiting") && ours(e));
  const idle = events.findLastIndex(isIdle);
  const running = firstWorking(idle, events.length);
  if (running !== -1) return { start: running, end: -1 };
  if (idle === -1) return undefined;
  const done = firstWorking(events.findLastIndex((e, i) => i < idle && isIdle(e)), idle);
  return done === -1 ? undefined : { start: done, end: idle };
};

/**
 * What the running turn did so far: the orders it opened and the agents it spawned that started. An agent spawned
 * before the turn (queued from an earlier order) is not counted, and an agent is counted once however often it
 * continues.
 */
export const turnTally = (events: readonly HubEvent[], ref: ProjectRef): string[] => {
  const turn = leadTurn(events, ref);
  const began = turn?.end === -1 ? events[turn.start] : undefined;
  if (turn === undefined || began === undefined) return [];
  const ours = ofProject(ref);
  const since = Date.parse(began.at);
  let orders = 0;
  const agents = new Set<string>();
  for (const e of events.slice(turn.start + 1)) {
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

const refOf = (key: ProjectKey): ProjectRef => {
  const at = key.indexOf("/");
  return { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
};

/** When the lead's latest turn began, hub epoch ms. */
export const leadTurnSince = (s: DataState, key: ProjectKey): number | undefined => {
  const turn = leadTurn(s.events, refOf(key));
  const at = turn === undefined ? undefined : s.events[turn.start]?.at;
  return at === undefined ? undefined : Date.parse(at);
};

/** When the lead's latest turn ended, hub epoch ms; undefined while it runs. */
export const leadTurnUntil = (s: DataState, key: ProjectKey): number | undefined => {
  const turn = leadTurn(s.events, refOf(key));
  const at = turn === undefined || turn.end === -1 ? undefined : s.events[turn.end]?.at;
  return at === undefined ? undefined : Date.parse(at);
};

/** "40s", "3m 40s", "1h 12m": elapsed time only, never an estimate. */
export const workedFor = (ms: number): string => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m ${String(s % 60)}s`;
  return `${String(Math.floor(s / 3600))}h ${String(Math.floor((s % 3600) / 60))}m`;
};

/**
 * The quiet line after the lead's reply. While its turn runs: how long it has worked, counting up, then what it does
 * ("Working for 1m 12s" and "planning · started 3 agents"). Once the turn is over: "Worked for 3m 40s". Undefined when
 * there is nothing to say. The count is apart from the words, so a screen reader isn't told every second.
 */
export const turnLine = (
  turn: { readonly since?: number | undefined; readonly until?: number | undefined },
  doing: string | undefined,
  nowMs: number,
): { readonly count?: string; readonly words?: string } | undefined => {
  const { since, until } = turn;
  if (doing === undefined) return since !== undefined && until !== undefined ? { words: `Worked for ${workedFor(until - since)}` } : undefined;
  if (since === undefined || until !== undefined) return { words: doing };
  const count = `Working for ${workedFor(nowMs - since)}`;
  // "working" is all the hub said: the count says it already.
  return doing === "working" ? { count } : { count, words: doing };
};

/** The line while the project's lead works ("planning · started 3 agents"), else undefined. */
export const leadActivity = (s: DataState, key: ProjectKey): string | undefined => {
  if (selectLeadWorking(key)(s) !== true) return undefined;
  const ref = refOf(key);
  const now = s.live.lanes[leadLaneId(ref)]?.activity?.activity;
  const parts = [...(now === undefined ? [] : [doingWords(now)]), ...turnTally(s.events, ref)];
  return parts.length === 0 ? "working" : parts.join(" · ");
};
