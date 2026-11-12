// The read model of a project's past: its orders, the steers people sent, the
// questions the retired questions tool asked and their answers, and the lead's own messages, read once into the chat
// in time order. Each message names its record (`source`), so reading again adds nothing. Texts carry no internal ids.
import type { ChatAuthor, ChatHistorySource, Workstream } from "../../shared/contracts.ts";
import { parseMs } from "../store/time.ts";
import type { NewMessage } from "./rules.ts";

const entry = (author: ChatAuthor, history: ChatHistorySource, source: string, text: string, atMs: number): NewMessage => ({
  author,
  text,
  source,
  history,
  createdMs: atMs,
});

/** An order: what a person asked, and how it ended. Orders a lead opened itself carry no human words. */
export function order(w: Workstream): NewMessage[] {
  const out: NewMessage[] = [];
  const id = w.workstreamId;
  const created = parseMs(w.createdAt) ?? 0;
  if (w.source.channel !== "lead") out.push(entry("human", "order", `order:${id}`, w.source.text, created));
  const how = w.state === "done" ? "done" : w.state === "stopped" ? "stopped" : undefined;
  if (how) out.push(entry("system", "order_outcome", `outcome:${id}`, `${w.title} is ${how}.`, parseMs(w.updatedAt) ?? created));
  return out;
}

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A person's steer, from its stored JSON; a lead's steer to its task is not the human's. */
export function steer(n: number, data: Json): NewMessage | undefined {
  if ((data.by as Json | undefined)?.kind !== "human") return undefined;
  const text = str(data.text)?.trim();
  if (!text) return undefined;
  return entry("human", "steer", `steer:${n}`, text, parseMs(str(data.queuedAt) ?? "") ?? 0);
}

/** A done-check question reads "Check done:0 of W5 (<the order>): Did …?": the ids go, the question stays. */
function plainQuestion(text: string): string {
  const t = text.trim();
  if (t.startsWith("Check done:")) {
    const i = t.indexOf("): ");
    if (i >= 0) return t.slice(i + 3).trim();
  }
  return t;
}

/** A question of the retired questions tool, and the human's answer when there was one. */
export function question(data: Json): NewMessage[] {
  const id = str(data.askId);
  const text = str(data.text);
  if (id === undefined || !text?.trim()) return [];
  const asked = parseMs(str(data.createdAt) ?? "") ?? 0;
  const out = [entry("lead", "question", `ask:${id}`, plainQuestion(text), asked)];
  const answer = (data.answer as Json | undefined) ?? {};
  const said = [str(answer.raw), str(answer.value)].find((s) => s !== undefined);
  if (said?.trim()) out.push(entry("human", "question", `answer:${id}`, said.trim(), parseMs(str(answer.at) ?? "") ?? asked));
  return out;
}

/** The key of a lead message read off its thread, shared by the live mirror and the history read. */
export const leadSource = (threadId: string, messageId: string) => `lead:${threadId}:${messageId}`;

/** A lead reply that says nothing to the person: a wake with no news ends with exactly this. */
export const QUIET = "(quiet)";

/** The lead's reply has words for the person: not blank, not QUIET. */
export function said(text: string): boolean {
  const t = text.trim();
  return t !== "" && t !== QUIET;
}

export type ThreadMessage = { id: string; role: string; text: string; createdAt: string };

/** The lead's own words from its session, before the chat: its assistant messages. */
export const leadMessages = (threadId: string, messages: ThreadMessage[]): NewMessage[] =>
  messages
    .filter((m) => m.role === "assistant" && said(m.text))
    .map((m) => entry("lead", "lead_message", leadSource(threadId, m.id), m.text.trim(), parseMs(m.createdAt) ?? 0));
