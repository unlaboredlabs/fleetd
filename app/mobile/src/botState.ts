// What a project's bot shows on the phone, by the desktop's rule (shared/bot.ts botStateOf): it needs you (its lead
// waits for your reply, or a secret or an approval is open for it), its agents or lead work (the lead thinking or
// planning alone: thinking), it has a new reply for you (done: a list row's unread, or a turn that just ended), else
// idle. Pure, so it is unit-tested.
import { botStateOf, doingWords, type BotState } from "./desktop";
import { mine, waitsOnMe } from "./lists";
import { keyOf, type Key, type State } from "./store";
import { leadActivityOf } from "./turn";

export const botOf = (s: Pick<State, "chatStates" | "requests" | "leadActivity" | "running"> & Partial<Pick<State, "me">>, key: Key, done = false): BotState => {
  const chat = s.chatStates[key];
  const needs = waitsOnMe(chat, s.me) || (s.requests?.some((r) => r.state === "open" && keyOf(r.projectRef) === key && mine(r, s.me)) ?? false);
  const activity = leadActivityOf(s, key);
  const doing = chat?.leadWorking !== true ? undefined : activity === undefined ? "working" : doingWords(activity);
  return botStateOf({ needs, blocked: false, running: s.running[key] ?? 0, doing, done });
};
