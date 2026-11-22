// A cloud bot waking on the phone, as the desktop draws it (its shared/wake.ts): asleep with its computer, then its bot
// in the reply's place while the computer starts, until the reply's first words show. Read from the hub's state: the
// chat state's leadAsleep and leadWorking, the lead's live lane, and whether its reply landed; whether this turn began
// with a start and has no reply yet is held here, one record for the app, so the thread's row, the turn line and every
// list's bot agree. Pure, so it is unit-tested.
import { askedAt, ColdTurns, replied, wakeOf, type Wake } from "./desktop";
import type { Key, State } from "./store";
import { leadActivityOf } from "./turn";

const cold = new ColdTurns();

/** The wait in `key`'s chat now; `writing`: its lead's reply streams. Over once its reply lands (`chats`, `sends`). */
export const wakeIn = (s: Pick<State, "chatStates" | "leadActivity"> & Partial<Pick<State, "chats" | "sends">>, key: Key, writing = false): Wake | undefined => {
  const chat = s.chatStates[key];
  const working = chat?.leadWorking === true;
  const activity = leadActivityOf(s, key);
  const landed = replied(s.chats?.[key]?.messages) && (s.sends?.[key]?.length ?? 0) === 0;
  const asked = askedAt(s.chats?.[key]?.messages);
  return wakeOf({ asleep: chat?.leadAsleep === true, working, activity, cold: cold.see(key, working, activity, landed), writing, asked });
};

/** What a bot in a list shows of it (botStateOf's `asleep` and `start`). */
export const botWake = (w: Wake | undefined): { asleep: boolean; start: "waking" | "failed" | undefined } => ({
  asleep: w?.phase === "asleep",
  start: w?.phase === "waking" ? "waking" : w?.phase === "failed" ? "failed" : undefined,
});
