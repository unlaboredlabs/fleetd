// What a project's bot shows (shared/bot.ts botStateOf), from what the app already knows: the project list's row (the
// lead waits on you, agents at work) and what the lead does now. The sidebar adds its own marks (why it wants you, a
// block, unread), the chat's title that its turn just ended.
import { useEffect, useState } from "react";
import { botStateOf, type BotIn, type BotState } from "../../../shared/bot";
import { useData } from "../../src/data/react";
import { selectProjectList } from "../../src/data/selectors";
import { leadDoing } from "../chat/activity";

/** The bot of the project `key` ("machineId/projectId"), with what the caller knows over the row's own. */
export const useBotState = (key: string, own: Partial<BotIn> = {}): BotState => {
  const row = useData((s) => selectProjectList(s)?.find((r) => r.key === key));
  const doing = useData((s) => leadDoing(s, key));
  return botStateOf({ needs: own.needs ?? row?.needsYou ?? false, blocked: own.blocked ?? false, running: own.running ?? row?.running ?? 0, doing: own.doing ?? doing, done: own.done ?? false });
};

/** How long a bot stays done after its lead's turn ends, while its chat is open. */
export const JUST_DONE_MS = 8000;

/** The lead's turn ended under JUST_DONE_MS ago (`until`, hub epoch ms; `skew`, the hub's clock less ours). */
export const useJustDone = (until: number | undefined, skew: number): boolean => {
  const end = until === undefined ? 0 : until - skew + JUST_DONE_MS;
  const [, bump] = useState(0);
  useEffect(() => {
    const left = end - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => bump((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [end]);
  // The timer above renders again once it ends, so the clock read here is never stale for long.
  // eslint-disable-next-line react-hooks/purity
  return end > Date.now();
};
