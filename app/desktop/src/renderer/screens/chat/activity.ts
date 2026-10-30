// The quiet line under the lead's reply. While its turn runs: how long it has worked, its open tool call (from its live
// lane) and what the turn did so far (from the hub's events). Once the turn ends: how long it worked. Only real state:
// elapsed time, never an estimate, and "working" when the hub says it works but nothing more is known.
import { eventData, isEvent, type HubEvent, type ProjectRef } from "../../../shared/contracts";
import { doingWords } from "../../../shared/turnWords";
import { leadLaneId, selectLeadWorking } from "../../src/data/selectors";
import type { DataState, ProjectKey } from "../../src/data/store";

export { doingWords, sentenceCase, turnLine, workedFor } from "../../../shared/turnWords";

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
    ...(orders > 0 ? [orders === 1 ? "planned a piece of work" : `planned ${String(orders)} pieces of work`] : []),
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

/** What the lead does this moment ("thinking", "editing `a.ts`"), "working" when nothing more is known; undefined idle. */
export const leadDoing = (s: DataState, key: ProjectKey): string | undefined => {
  if (selectLeadWorking(key)(s) !== true) return undefined;
  const now = s.live.lanes[leadLaneId(refOf(key))]?.activity?.activity;
  return now === undefined ? "working" : doingWords(now);
};

/** What the running turn did so far, joined ("planned a piece of work · started 2 agents"); "" for nothing yet. */
export const leadDid = (s: DataState, key: ProjectKey): string => (selectLeadWorking(key)(s) === true ? turnTally(s.events, refOf(key)).join(" · ") : "");

/** The line while the project's lead works ("planning · started 3 agents"), else undefined. */
export const leadActivity = (s: DataState, key: ProjectKey): string | undefined => {
  if (selectLeadWorking(key)(s) !== true) return undefined;
  const ref = refOf(key);
  const now = s.live.lanes[leadLaneId(ref)]?.activity?.activity;
  const parts = [...(now === undefined ? [] : [doingWords(now)]), ...turnTally(s.events, ref)];
  return parts.length === 0 ? "working" : parts.join(" · ");
};
