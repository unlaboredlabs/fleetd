// The lead's turn. While it runs: its open tool call (from its live lane), which the island over the composer says
// (Island.tsx), and when it began. Once it ends: how long it worked, the reply's stamp. Only real state:
// elapsed time, never an estimate, and "working" when the hub says it works but nothing more is known.
import { eventData, isEvent, type HubEvent, type ProjectRef } from "../../../shared/contracts";
import { doingWords } from "../../../shared/turnWords";
import { leadLaneId, selectLeadWorking } from "../../src/data/selectors";
import type { DataState, ProjectKey } from "../../src/data/store";

export { doingWords, sentenceCase, turnLine, workedFor } from "../../../shared/turnWords";

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
  const running = firstWorking(events.findLastIndex(isIdle), events.length);
  return running !== -1 ? { start: running, end: -1 } : lastTurn(events, ref);
};

/** The lead's latest turn that is over, as leadTurn has it, whether or not another runs now. */
export const lastTurn = (events: readonly HubEvent[], ref: ProjectRef): { readonly start: number; readonly end: number } | undefined => {
  const ours = ofProject(ref);
  const isIdle = idleAt(ours);
  const idle = events.findLastIndex(isIdle);
  const before = idle === -1 ? -1 : events.findLastIndex((e, i) => i < idle && isIdle(e));
  const done = before === -1 ? -1 : events.findIndex((e, i) => i > before && i < idle && isEvent(e, "chat.waiting") && ours(e));
  return done === -1 ? undefined : { start: done, end: idle };
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

/**
 * When the lead's latest finished turn began and ended, hub epoch ms: its reply wears how long it took as a stamp
 * ("Worked for 4s"), and keeps it while the next turn runs.
 */
export const leadLastTurnSince = (s: DataState, key: ProjectKey): number | undefined => {
  const turn = lastTurn(s.events, refOf(key));
  const at = turn === undefined ? undefined : s.events[turn.start]?.at;
  return at === undefined ? undefined : Date.parse(at);
};
export const leadLastTurnUntil = (s: DataState, key: ProjectKey): number | undefined => {
  const turn = lastTurn(s.events, refOf(key));
  const at = turn === undefined ? undefined : s.events[turn.end]?.at;
  return at === undefined ? undefined : Date.parse(at);
};

/** The lead's turns that are over, as lastTurn has each, oldest first: hub epoch ms at each end. */
export const leadTurns = (events: readonly HubEvent[], ref: ProjectRef): { readonly since: number; readonly until: number }[] => {
  const ours = ofProject(ref);
  const isIdle = idleAt(ours);
  const out: { since: number; until: number }[] = [];
  let idleSeen = false;
  let start: HubEvent | undefined;
  for (const e of events) {
    if (!isEvent(e, "chat.waiting") || !ours(e)) continue;
    if (isIdle(e)) {
      if (start !== undefined) out.push({ since: Date.parse(start.at), until: Date.parse(e.at) });
      start = undefined;
      idleSeen = true;
    } else if (idleSeen && start === undefined) start = e;
  }
  return out;
};

/** A reply lands a moment after its turn's end. */
const REPLY_SLACK_MS = 2_000;

/**
 * How long the lead worked toward its latest finished turn's reply, ms: that turn, and the turns before it since your
 * message that ended with no reply of their own (a run Claude failed or cut, which the lead carried on by itself), so a
 * reply that took minutes across retries never reads as the seconds of its last run (W791, "Worked for 8s").
 */
export const leadLastTurnWorkedMs = (s: DataState, key: ProjectKey): number | undefined => {
  const turns = leadTurns(s.events, refOf(key));
  const last = turns.at(-1);
  if (last === undefined) return undefined;
  const messages = s.chats[key]?.messages ?? [];
  const asked = messages.findLast((m) => m.author === "human" && Date.parse(m.createdAt) < last.since);
  let ms = last.until - last.since;
  if (asked === undefined) return ms;
  const after = Date.parse(asked.createdAt);
  for (let i = turns.length - 2; i >= 0; i--) {
    const t = turns[i];
    if (t === undefined || t.until <= after) break;
    const replied = messages.some((m) => m.author === "lead" && m.state === "final" && Date.parse(m.createdAt) >= t.since && Date.parse(m.createdAt) <= t.until + REPLY_SLACK_MS);
    if (replied) break;
    ms += t.until - t.since;
  }
  return ms;
};

/** What the lead does this moment ("thinking", "editing `a.ts`"), "working" when nothing more is known; undefined idle. */
export const leadDoing = (s: DataState, key: ProjectKey): string | undefined => {
  if (selectLeadWorking(key)(s) !== true) return undefined;
  const now = s.live.lanes[leadLaneId(refOf(key))]?.activity?.activity;
  return now === undefined ? "working" : doingWords(now);
};
