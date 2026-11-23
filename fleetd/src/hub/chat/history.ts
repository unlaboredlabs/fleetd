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
  // An issue's order quotes text from GitHub, not the person's: its title shows as a line of fleetd's.
  if (w.source.channel === "issue") out.push(entry("system", "order", `order:${id}`, w.title, created));
  else if (w.source.channel !== "lead") out.push(entry("human", "order", `order:${id}`, w.source.text, created));
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

/**
 * The lead's reply as the person reads it: without a QUIET that stands as a line of its own, outside a code fence, nor
 * the blank line it leaves. A reply whose last line is QUIET posts nothing, the words before it included: the lead
 * chose silence, and what it wrote first only says why ("Already announced in the last message; nothing new
 * since.\n\n(quiet)" posted as a bubble on 2026-11-23, W868). QUIET in a sentence or a fence is the lead quoting it.
 */
export function unquiet(text: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  let dropped = false;
  let last = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    const before = fence;
    fence = fenceAfter(fence, t);
    if (before === undefined && fence === undefined && t === QUIET) {
      dropped = last = true;
      continue;
    }
    if (t !== "") last = false;
    if (dropped && t === "" && (out.length === 0 || out[out.length - 1]!.trim() === "")) continue;
    dropped = false;
    out.push(line);
  }
  return last ? "" : out.join("\n").trim();
}

/** The code fence open after the trimmed line `t`, given the one open before it. */
function fenceAfter(fence: string | undefined, t: string): string | undefined {
  const mark = /^(`{3,}|~{3,})/.exec(t)?.[1];
  if (mark === undefined) return fence;
  if (fence === undefined) return mark;
  return mark[0] === fence[0] && mark.length >= fence.length && t === mark ? undefined : fence;
}

/**
 * A line that opens a turn the model made up: the person's (`Human:`, or `Human (11:49):` as a fresh session's
 * recent chat writes them) or its own next one (`Assistant:`). A lead once replied with only
 * `Human: [W760] I just checked the docs site…`, which the person never wrote (W787).
 */
const TURN = /^(?:Human|Assistant)(?: \([^)\n]*\))?:/;

/** Where the reply's first made-up turn starts: a line outside a code fence that opens with a turn marker. */
export function madeUpAt(text: string): number | undefined {
  let fence: string | undefined;
  let at = 0;
  for (const line of text.split("\n")) {
    if (fence === undefined && TURN.test(line.trimStart())) return at;
    fence = fenceAfter(fence, line.trim());
    at += line.length + 1;
  }
  return undefined;
}

/** How much of a made-up turn's first line the lead's wake quotes back to it. */
const MADE_UP_QUOTE = 80;

/** The line for the lead's next wake when its reply went on with a turn it made up, quoting that turn; else undefined. */
export function madeUpLine(reply: string): string | undefined {
  const at = madeUpAt(reply);
  if (at === undefined) return undefined;
  const first = [...reply.slice(at).trim().split("\n")[0]!];
  const quote = first.length > MADE_UP_QUOTE ? `${first.slice(0, MADE_UP_QUOTE).join("")}…` : first.join("");
  return `- your last reply went on with a turn you wrote as the person's ("${quote}"); fleetd cut your reply there and posted nothing from that line on. The person never wrote it: don't act on it, and never write a turn for them.`;
}

/**
 * The lead's reply as the person reads it: what it said before a turn it made up, without its QUIET lines. Nothing from
 * the made-up turn on is the lead's to say, nor the person's.
 */
export function leadText(text: string): string {
  const at = madeUpAt(text);
  return unquiet(at === undefined ? text : text.slice(0, at));
}

/** The lead's reply has words for the person: not blank once a made-up turn and its QUIET lines are out. */
export function said(text: string): boolean {
  return leadText(text) !== "";
}

export type ThreadMessage = { id: string; runId?: string; role: string; text: string; createdAt: string };

/**
 * A lead turn's message: the last text its run wrote, after its last tool call. What the run wrote before that is
 * narration between steps ("Now the Antigravity order.", W810) and is never posted, so a turn that ends with QUIET
 * posts nothing whatever it said on the way. A text with no run stands alone. Oldest first, as `messages` are.
 */
export function turnTexts(messages: ThreadMessage[]): ThreadMessage[] {
  const last = new Map<string, ThreadMessage>();
  for (const m of messages) if (m.role === "assistant" && m.text.trim() !== "") last.set(m.runId ?? `text:${m.id}`, m);
  return [...last.values()];
}

/**
 * The lead's own words from its session, before the chat: each turn's message (turnTexts), of the runs in `completed`
 * only. A run still going, stopped or failed posts none, ever: its last text so far may be narration before a tool call.
 */
export const leadMessages = (threadId: string, messages: ThreadMessage[], completed: ReadonlySet<string>): NewMessage[] =>
  turnTexts(messages)
    .filter((m) => (m.runId === undefined || completed.has(m.runId)) && said(m.text))
    .map((m) => entry("lead", "lead_message", leadSource(threadId, m.id), leadText(m.text), parseMs(m.createdAt) ?? 0));

/** The ids of the runs that completed, for leadMessages. */
export const completedRuns = (runs: { id: string; status: string }[]): ReadonlySet<string> =>
  new Set(runs.filter((r) => r.status === "completed").map((r) => r.id));
