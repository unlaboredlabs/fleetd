// The bot in the reply's place in its chat (shared/wake.ts): what the chat knows of it, read from the store. Its lead
// asleep (the chat state's leadAsleep), at work, and what its live lane does now; whether your newest message has an
// answer, when the lead last stopped (the chat state's leadIdleAt, or a stop seen here: the store's chatTurnEnds), and
// what holds it up (chat_send's leadWaiting, the bot blocked); whether this turn began with a start and its reply hasn't
// landed yet is held here, one record for every chat and bot, so the row in the reply's place, the typing bubble, the
// island and the bot in every list agree.
import { useEffect, useMemo, useState } from "react";
import { leadLaneId } from "../../../shared/turnWords";
import { askedAt, ColdTurns, endedAt, heldWords, replied, START_STALE_MS, waitingFor, wakeOf, type Wake } from "../../../shared/wake";
import { useData, useToolQuery } from "../../src/data/react";
import type { DataState, ProjectKey } from "../../src/data/store";

const cold = new ColdTurns();
/** Status's own query (the chat's data.ts reads the same, so one cached read): whether the bot is blocked, and why. */
const ALL = {} as const;

const refOf = (key: ProjectKey) => {
  const at = key.indexOf("/");
  return { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
};

const activityOf = (s: DataState, key: ProjectKey) => s.live.lanes[leadLaneId(refOf(key))]?.activity?.activity;

/** One of your messages is on its way to the hub (not one it refused). */
const sendingTo = (s: DataState, key: ProjectKey) => (s.chatSends[key] ?? []).some((r) => r.state.t !== "failed");

/** chat_send's word on why the lead doesn't have your newest message, until the lead writes after it. */
const leadWaitingOf = (s: DataState, key: ProjectKey): string | undefined => {
  const chat = s.chats[key];
  const newest = chat?.messages.findLast((m) => m.author === "human" || m.author === "lead");
  return newest?.author === "human" ? chat?.leadWaiting[newest.messageId] : undefined;
};

/** The wait in `key`'s chat now; `writing`: its lead's reply streams. */
export function useWake(key: ProjectKey, writing = false): Wake | undefined {
  const asleep = useData((s) => s.chatStates[key]?.leadAsleep === true);
  const working = useData((s) => s.fresh && s.chatStates[key]?.leadWorking === true);
  const activity = useData((s) => activityOf(s, key));
  // Its reply landed (none of yours still on its way): the wake is over, though the lead may work on.
  const landed = useData((s) => replied(s.chats[key]?.messages) && (s.chatSends[key]?.length ?? 0) === 0);
  const sending = useData((s) => sendingTo(s, key));
  // One of yours on its way was asked just now: its own time comes with the hub's copy.
  const asked = useData((s) => (sending ? undefined : askedAt(s.chats[key]?.messages)));
  // Offline, whether the lead started can't be known: only a start already seen shows.
  const waiting = useData((s) => s.fresh && waitingFor(s.chats[key]?.messages, sending));
  // When the lead last stopped: the hub's word, kept in every state it sends, or a stop seen here.
  const idleAt = useData((s) => s.chatStates[key]?.leadIdleAt);
  const ended = useData((s) => endedAt(s.chatStates[key]?.leadIdleAt, s.chatTurnEnds?.[key]));
  const leadWaiting = useData((s) => leadWaitingOf(s, key));
  const skew = useData((s) => s.live.skewMs ?? 0);
  const row = useToolQuery("status_get", ALL).data?.rows?.find((r) => `${r.projectRef.machineId}/${r.projectRef.projectId}` === key);
  const held = heldWords({ leadWaiting });
  const blocked = heldWords({ blocked: row?.state === "blocked" ? (row.blockedReason ?? "") : undefined });
  // A wait for a start is over once it is stale (START_STALE_MS on the hub's clock): the message it went stale for.
  const [staleAt, setStaleAt] = useState<number>();
  useEffect(() => {
    if (!waiting || working || asked === undefined) return;
    const timer = setTimeout(() => setStaleAt(asked), Math.max(0, asked + START_STALE_MS - (Date.now() + skew)));
    return () => clearTimeout(timer);
  }, [waiting, working, asked, skew]);
  const isCold = cold.see(key, working, activity, landed);
  const stale = asked !== undefined && staleAt === asked;
  return useMemo(
    () => wakeOf({ asleep, working, activity, cold: isCold, writing, asked, waiting, endedAt: ended, idleKnown: idleAt !== undefined, held, blocked, stale }),
    [asleep, working, activity, isCold, writing, asked, waiting, ended, idleAt, held, blocked, stale],
  );
}

/** The hub's clock, ticking each second while `on`: a slow start's count and Try again's countdown. */
export function useHubNow(on: boolean): number {
  const skew = useData((s) => s.live.skewMs ?? 0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now + skew;
}
