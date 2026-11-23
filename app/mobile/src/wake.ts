// The bot in the reply's place on the phone, as the desktop draws it (its shared/wake.ts): from your send until the
// reply's first words show, or its lead's turn ends without one, and a cloud bot asleep with its computer, waking there
// while the computer starts. Read from the hub's state: the chat state's leadAsleep and leadWorking, the lead's live
// lane, whether your newest message waits (no reply since, no turn ended since: the store's turnEnded) and why the
// lead doesn't have it (chat_send's leadWaiting); whether this turn began with a start and has no reply yet is held
// here, one record for the app, so the thread's row, the turn line and every list's bot agree. Pure, so it is
// unit-tested.
import { askedAt, ColdTurns, heldWords, replied, START_STALE_MS, waitingFor, wakeOf, type Wake } from "./desktop";
import type { Key, State } from "./store";
import { leadActivityOf } from "./turn";

const cold = new ColdTurns();

/**
 * The wait in `key`'s chat now; `writing`: its lead's reply streams. Over once its reply lands (`chats`, `sends`), or
 * a turn of its lead ends after your message (`turnEnded`). `nowMs`, this device's clock: a wait for a start long past
 * shows nothing.
 */
export const wakeIn = (
  s: Pick<State, "chatStates" | "leadActivity"> & Partial<Pick<State, "chats" | "sends" | "turnEnded" | "skewMs" | "hub">>,
  key: Key,
  writing = false,
  nowMs = Date.now(),
): Wake | undefined => {
  const chat = s.chatStates[key];
  const working = chat?.leadWorking === true;
  const activity = leadActivityOf(s, key);
  const messages = s.chats?.[key]?.messages;
  const landed = replied(messages) && (s.sends?.[key]?.length ?? 0) === 0;
  // One of yours on its way was asked just now: its own time comes with the hub's copy.
  const sending = (s.sends?.[key] ?? []).some((r) => r.state.t !== "failed");
  const asked = sending ? undefined : askedAt(messages);
  // Off the hub, whether the lead started can't be known: only a start already seen shows.
  const waiting = s.hub?.phase === "live" && waitingFor(messages, sending, s.turnEnded?.[key]);
  const newest = messages?.findLast((m) => m.author === "human" || m.author === "lead");
  const leadWaiting = newest?.author === "human" ? s.chats?.[key]?.leadWaiting?.[newest.messageId] : undefined;
  const stale = asked !== undefined && nowMs + (s.skewMs ?? 0) - asked >= START_STALE_MS;
  return wakeOf({ asleep: chat?.leadAsleep === true, working, activity, cold: cold.see(key, working, activity, landed), writing, asked, waiting, held: heldWords({ leadWaiting }), stale });
};

/** What a bot in a list shows of it (botStateOf's `asleep` and `start`). */
export const botWake = (w: Wake | undefined): { asleep: boolean; start: "waking" | "failed" | undefined } => ({
  asleep: w?.phase === "asleep",
  start: w?.phase === "waking" ? "waking" : w?.phase === "failed" ? "failed" : undefined,
});
