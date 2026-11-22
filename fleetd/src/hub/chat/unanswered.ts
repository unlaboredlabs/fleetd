// A person's message whose lead turn ended with nothing for them: no text, or only `(quiet)` (W788). On the cloud a
// lead answering "retry" removed a repo, saved a memory and ended with no reply, and the person had to ask "so ??"
// (2026-11-22). A prompt line already said `(quiet)` never answers a person, so the hub checks it: as a completed turn
// ends, a person's message written since the lead's thread last ended that no lead message follows wakes the lead once
// to answer it; if that turn posts nothing either, a plain line says so in the chat. Never more: one ask per message.
// A turn the person's message didn't come into (a wake: an agent's result, an event, an automation) keeps `(quiet)`
// as silence, since the person's last message is then older than the thread's last end, or answered.
import type { HubEvent, ProjectRef, ThreadRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { leads } from "../leads/index.ts";
import { oneLine } from "../leads/text.ts";
import { events } from "../store/events.ts";
import { parseMs } from "../store/time.ts";
import { chat } from "./index.ts";

/** The chat's line when the lead, asked once, still didn't answer. */
export const NO_REPLY_LINE = "The lead ended its turn without replying to your message. Write again if you still need an answer.";

/** The wake's line: which message has no answer, and that `(quiet)` isn't one. */
export const askLine = (text: string) =>
  `- The person's message "${oneLine(text, 200) || "(files only)"}" has no reply: your turn ended without words for them (only \`(quiet)\`, or no text). \`(quiet)\` never answers a person's own message: answer it now, in a line or two, with what you did or found.`;

/**
 * The message each project's lead was asked to answer, by project. In memory: a restart between the ask and its turn's
 * end leaves that turn as it ends, and asks nothing again, since the message is then older than the thread's last end.
 */
const asked = (hub: Hub) => hub.area("chat_unanswered", () => new Map<string, string>());

/** The lead thread's last end (a completed or stopped turn) before `seq`, in ms. */
function endedBefore(hub: Hub, r: ProjectRef, threadId: string, seq: number): number | undefined {
  const page = events(hub).projectPage(r, seq, ["thread.completed", "thread.interrupted"], false, 200);
  const last = page.events.find((e: HubEvent) => (e.threadId ?? (e.data as { threadId?: unknown } | undefined)?.threadId) === threadId);
  return last ? parseMs(last.at) : undefined;
}

/**
 * At a completed turn of the project's lead (`thread`, ended by event `seq`), its replies landed: the person's last
 * message, when the turn left it with no reply, is asked for once, then said in the chat to have none.
 */
export function unanswered(hub: Hub, r: ProjectRef, thread: ThreadRef, seq: number): void {
  const c = chat(hub);
  const k = `${r.machineId}/${r.projectId}`;
  const m = c.lastHuman(r);
  if (!m || c.isHeld(m) || c.sinceHuman(r).length > 0) {
    asked(hub).delete(k);
    return;
  }
  if (asked(hub).get(k) === m.messageId) {
    asked(hub).delete(k);
    c.add(r, { author: "system", text: NO_REPLY_LINE, source: `unanswered:${m.messageId}` });
    return;
  }
  const before = endedBefore(hub, r, thread.threadId, seq);
  if (before !== undefined && (parseMs(m.createdAt) ?? 0) <= before) return;
  asked(hub).set(k, m.messageId);
  leads(hub).wakes.trigger(r, { kind: "line", line: "unanswered", text: askLine(m.text) });
}
