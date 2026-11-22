// A cloud bot waking in its chat (shared/wake.ts): what the chat knows of it, read from the store. Its lead asleep (the
// chat state's leadAsleep), at work, and what its live lane does now; whether this turn began with a start is held
// here, one record for every chat and bot, so the row in the reply's place, the typing bubble, the island and the bot
// in every list agree.
import { useEffect, useMemo, useState } from "react";
import { leadLaneId } from "../../../shared/turnWords";
import { ColdTurns, wakeOf, type Wake } from "../../../shared/wake";
import { useData } from "../../src/data/react";
import type { DataState, ProjectKey } from "../../src/data/store";

const cold = new ColdTurns();

const refOf = (key: ProjectKey) => {
  const at = key.indexOf("/");
  return { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
};

const activityOf = (s: DataState, key: ProjectKey) => s.live.lanes[leadLaneId(refOf(key))]?.activity?.activity;

/** The wait in `key`'s chat now; `writing`: its lead's reply streams. */
export function useWake(key: ProjectKey, writing = false): Wake | undefined {
  const asleep = useData((s) => s.chatStates[key]?.leadAsleep === true);
  const working = useData((s) => s.fresh && s.chatStates[key]?.leadWorking === true);
  const activity = useData((s) => activityOf(s, key));
  const isCold = cold.see(key, working, activity);
  return useMemo(() => wakeOf({ asleep, working, activity, cold: isCold, writing }), [asleep, working, activity, isCold, writing]);
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
