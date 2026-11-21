// The lead chat's tools (nudges.rs): chat_send, chat_history, chat_find, chat_stop,
// project_stop, chat_nudge_clear and chat_about_set; pins.ts serves the pins.
import type { ChatFindHit, ChatMessage, ChatNudgeCleared, ChatStopInput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import { DecodeError, decodeInput } from "../api/decode.ts";
import type { Registry } from "../api/registry.ts";
import { requireHuman } from "../leads/seams.ts";
import { store } from "../store/hub_store.ts";
import { parseMs } from "../store/time.ts";
import { chatStop, ensure, projectStop, send, state } from "./flow.ts";
import { chat } from "./index.ts";
import { FIND_LIMIT, hitText, parseWords, type Term } from "./find_rules.ts";
import { register as registerPins } from "./pins.ts";
import { retag } from "./tags.ts";

export function register(tools: Registry): void {
  registerPins(tools);
  tools.add("chat_send", (hub, caller, input) => send(hub, caller, input));

  tools.add("chat_history", async (hub, caller, input) => {
    const r = input.projectRef;
    requireRole(caller, "read", r.machineId);
    if (store(hub).projectGet(r)) await ensure(hub, r);
    const limit = input.limit ?? 50;
    if (input.around !== undefined) {
      if (input.before !== undefined || input.after !== undefined) {
        throw new ToolError("invalid", "around reads a page of its own: give it without before or after.");
      }
      const seq = chat(hub).seqIn(r, input.around);
      if (seq === undefined) throw new ToolError("not_found", `${input.around} is not a message of this chat.`);
      const before = Math.floor((limit - 1) / 2);
      const page = chat(hub).around(r, seq, before, limit - 1 - before);
      return { messages: page.messages, moreBefore: page.moreBefore, moreAfter: page.moreAfter, state: state(hub, r) };
    }
    const page = chat(hub).page(r, input.before, input.after, limit);
    return { messages: page.messages, moreBefore: page.moreBefore, moreAfter: page.moreAfter, state: state(hub, r) };
  });

  // A person searches the whole chat from the index the lead's chat_search reads (find.ts): its words, phrases and
  // filters, newest first, a page at a time, the first page with a count.
  tools.add("chat_find", (hub, caller, input) => {
    const r = input.projectRef;
    requireRole(caller, "read", r.machineId);
    const terms = parseWords(input.words ?? "");
    const filtered =
      input.author !== undefined || input.personId !== undefined || input.since !== undefined || input.until !== undefined || (input.has ?? []).length > 0;
    // Nothing to look for yet (a field just cleared) finds nothing.
    if (terms.length === 0 && !filtered) return { hits: [], more: false, count: 0 };
    let beforeN: number | undefined;
    if (input.before !== undefined) {
      if (chat(hub).seqIn(r, input.before) === undefined) throw new ToolError("not_found", `${input.before} is not a message of this chat.`);
      beforeN = Number(input.before.slice(1));
    }
    const ms = (t: string | undefined) => (t === undefined ? undefined : parseMs(t));
    const found = chat(hub).find(r, {
      terms,
      author: input.author,
      personId: input.personId,
      sinceMs: ms(input.since),
      untilMs: ms(input.until),
      has: input.has,
      beforeN,
      limit: input.limit ?? FIND_LIMIT,
      count: beforeN === undefined,
    });
    const { messages, ...rest } = found;
    return { hits: messages.map((m) => hitOf(m, terms)), ...rest };
  });

  // A person moves a message to another order, or to none, while the project's chat tags are on.
  tools.add("chat_about_set", (hub, caller, input) => {
    requireHuman(caller, "chat_about_set");
    const r = input.projectRef;
    requireRole(caller, "operate", r.machineId);
    const message = retag(hub, r, input.messageId, input.workstreamId, caller.person?.name ?? caller.name);
    return { message, next: "The lead hears of it with its next wake." };
  });

  tools.add("project_stop", (hub, caller, input) => projectStop(hub, caller, input));

  // The key is checked before the input, so the app's probe with `{}` tells "you may stop" (invalid input) from "you
  // may not" (forbidden).
  tools.addRaw("chat_stop", (hub, caller, raw) => {
    requireHuman(caller, "chat_stop");
    let input: ChatStopInput;
    try {
      input = decodeInput("chat_stop", raw) as ChatStopInput;
    } catch (error) {
      if (error instanceof DecodeError) throw new ToolError("invalid", error.message);
      throw error;
    }
    return chatStop(hub, caller, input);
  });

  // The person has seen a nudge's message, or dismissed it.
  tools.add("chat_nudge_clear", (hub, caller, input) => {
    requireHuman(caller, "chat_nudge_clear");
    const r = input.projectRef;
    requireRole(caller, "operate", r.machineId);
    const message = chat(hub).byId(input.messageId);
    if (!message || message.projectRef.machineId !== r.machineId || message.projectRef.projectId !== r.projectId) {
      throw new ToolError("not_found", `No message ${input.messageId} in this chat.`);
    }
    const how: ChatNudgeCleared = input.dismissed === true ? "dismissed" : "seen";
    if (chat(hub).clearNudge(message, how)) state(hub, r);
    return { ok: true };
  });
}

/** A search hit: one line of the message around its first term, and where each term is in it. */
export function hitOf(m: ChatMessage, terms: Term[]): ChatFindHit {
  const { text, marks } = hitText(m.text, m.attachments, terms);
  return {
    messageId: m.messageId,
    seq: m.seq,
    createdAt: m.createdAt,
    author: m.author,
    ...(m.by !== undefined ? { by: m.by } : {}),
    ...(m.person !== undefined ? { person: m.person } : {}),
    text,
    marks,
  };
}
