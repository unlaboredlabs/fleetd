// What a fresh lead session reads of the chat before it, with no hub behind it, so fleetd cloud's lead start reads the
// same: the recent chat (each message's id, order and what it replies to, the person's and the lead's words whole up to
// a budget, system and approval lines one short line each, a fleetd-block as its kind and caption), which of the
// person's messages no answer follows, and the last line of a session started again with no wake behind it.
import type { ChatItem, ChatMessage } from "../../shared/contracts.ts";
import { blockWords } from "../chat/find_rules.ts";
import { clip, oneLine } from "./text.ts";
import { short, told, type Zone } from "./zone_text.ts";

/** The most lines a recap holds, newest kept. */
export const RECAP_LINES = 40;
/** Its lines' characters, all told: past it the oldest lines go, the one at the edge cut. */
export const RECAP_CHARS = 12_000;
/** A person's or the lead's message is kept whole up to this; an agent's to AGENT_CHARS, a system line to LINE_CHARS. */
const WHOLE_CHARS = 4_000;
const AGENT_CHARS = 500;
const LINE_CHARS = 200;
/** The most of a file's name a recap line carries. */
const NAME_CHARS = 80;
/** A line cut at the budget's edge is kept only with this much of it left. */
const CUT_MIN = 200;

/**
 * The last line of a session started again with no wake behind it (a profile switch, Restart lead): its recent chat
 * ends on turn-shaped lines, which invite a model to write the next one itself. It speaks for the chat alone: the state
 * and the orders waiting above it still stand.
 */
export const STARTED_AGAIN =
  "This is your session starting again: the chat messages above were already seen and handled. The state and any orders waiting above still stand: act on them, on a wake or on a person's new message, and never write a message for them.";

/** STARTED_AGAIN when the session before stopped with the person's latest messages still unanswered (D680). */
export const STARTED_AGAIN_UNANSWERED =
  "This is your session starting again, and the one before it stopped before it answered the person: their messages marked unanswered above still wait for your answer, so answer them now. The other chat messages above were already seen and handled. The state and any orders waiting above still stand: act on them, and never write a message for the person.";

/** A lead message that answers the person: its own words from a completed turn, not a card and not one still streaming. */
const answers = (m: ChatMessage) => m.author === "lead" && m.item === undefined && m.state !== "streaming" && m.text.trim() !== "";

/**
 * The ids of the person's messages no lead answer follows, of `messages` newest first. A lead message lands only from a
 * completed turn (a stopped or failed one posts none), so these are what the person wrote since the lead last answered.
 */
export function unanswered(messages: readonly ChatMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (answers(m)) break;
    if (m.author === "human") out.add(m.messageId);
  }
  return out;
}

/** A fleetd-block as the recap says it: `[kind: caption]`, an ask with its options. */
function blockLine(json: string): string {
  let b: { kind?: unknown; options?: unknown };
  try {
    b = JSON.parse(json) as typeof b;
  } catch {
    return "[block]";
  }
  const kind = typeof b.kind === "string" ? b.kind : "block";
  const words = oneLine(blockWords(json), LINE_CHARS);
  const options = Array.isArray(b.options) ? b.options.filter((o): o is string => typeof o === "string") : [];
  const more = options.length === 0 ? "" : ` (options: ${options.map((o) => oneLine(o, 60)).join(" / ")})`;
  return `[${kind}${words === "" ? "" : `: ${words}`}${more}]`;
}

/** The text with each fleetd-block fence as its one-line summary. */
const blocksSummed = (text: string) =>
  text.replace(/^ {0,3}(`{3,}|~{3,})[ \t]*fleetd-block[^\n]*\n([\s\S]*?)(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gmu, (_all, _fence: string, json: string) => blockLine(json));

/** A card in the chat as one line: an approval and how it went, a secret asked for. */
function itemLine(item: ChatItem): string {
  if (item.kind === "secret_request") return `asked for the secret ${oneLine(item.name, NAME_CHARS)}: ${item.state}${item.by ? ` by ${item.by}` : ""}`;
  if (item.kind !== "command_approval") return `a ${String((item as { kind?: unknown }).kind ?? "card")} card`;
  const what = item.gated
    ? `\`${oneLine(item.gated.argv.join(" "), 120)}\` (${oneLine(item.gated.reason, 120)})`
    : item.purchase
      ? "a purchase"
      : item.permission
        ? "a tool step"
        : "a command";
  const exit = item.exitCode === undefined ? "" : `, exit ${item.exitCode}`;
  return `approval for ${what}: ${item.state}${item.by ? ` by ${item.by}` : ""}${exit}`;
}

/** Who wrote it, as the lead reads it; undefined for an author this hub doesn't know. */
function whoOf(m: ChatMessage): string | undefined {
  if (m.item !== undefined || m.author === "system") return "System";
  if (m.author === "human") return "Human";
  if (m.author === "lead") return "You";
  if (m.author !== "agent") return undefined;
  if (m.lead === undefined) return `Agent ${m.by ?? ""}`.trim();
  return m.lead.to !== undefined ? `You, to the lead of ${m.lead.to}` : `The lead of ${m.by ?? ""}`.trim();
}

/** The message's line, its words cut to its kind's share; undefined when it says nothing. */
function lineOf(m: ChatMessage, zone: Zone, open: ReadonlySet<string>): string | undefined {
  const who = whoOf(m);
  if (who === undefined) return undefined;
  // Its files by id and name only: the lead saves one with attachment_read, or names its id to an agent.
  const files = (m.attachments ?? []).map((f) => `${f.attachmentId} "${oneLine(f.name, NAME_CHARS)}"`);
  const body =
    m.item !== undefined
      ? itemLine(m.item)
      : m.author === "system"
        ? oneLine(m.text, LINE_CHARS)
        : clip(blocksSummed(m.text.trim()), m.author === "agent" ? AGENT_CHARS : WHOLE_CHARS);
  const said = [body, files.length === 0 ? "" : `[attached: ${files.join(", ")}]`].filter(Boolean).join(" ");
  if (!said) return undefined;
  const ms = Date.parse(m.createdAt);
  const orders = [...new Set([m.about, ...(m.parts ?? []).map((p) => p.about)].flatMap((a) => (a ? [a.workstreamId] : [])))];
  const reply = m.replyTo === undefined ? undefined : `replying to ${m.replyTo.messageId}${m.replyTo.part > 0 ? ` bubble ${m.replyTo.part + 1}` : ""}`;
  const meta = [Number.isFinite(ms) ? short(zone, ms) : undefined, m.messageId, orders.join(", ") || undefined, reply, open.has(m.messageId) ? "unanswered" : undefined];
  return `${who} (${meta.filter(Boolean).join("; ")}): ${said}`;
}

/**
 * The recent chat for a fresh lead session, from `messages` newest first (none held for the lead): the newest
 * RECAP_LINES lines within RECAP_CHARS, oldest first. `unanswered` (`unanswered()`) marks the person's messages still
 * waiting for an answer. Undefined when nothing was said.
 */
export function recap(messages: readonly ChatMessage[], zone: Zone, opts: { unanswered?: ReadonlySet<string> } = {}): string | undefined {
  const open = opts.unanswered ?? new Set<string>();
  const lines: string[] = [];
  let left = RECAP_CHARS;
  for (const m of messages) {
    if (lines.length >= RECAP_LINES) break;
    const line = lineOf(m, zone, open);
    if (line === undefined) continue;
    if (line.length > left) {
      if (left >= CUT_MIN) lines.push(clip(line, left));
      break;
    }
    lines.push(line);
    left -= line.length + 1;
  }
  if (lines.length === 0) return undefined;
  lines.reverse();
  return `## Recent chat\nYour session started fresh; the chat before this is not in it. Times are in ${told(zone)}. Each line says who (when; the message's id; its order; the message it replies to): what was said, a fleetd-block as [kind: caption].\n${lines.join("\n")}`;
}

/** The end of a session started again with no wake behind it: its recap, then STARTED_AGAIN, or the unanswered one. */
export function startedAgain(recapText: string | undefined, open: ReadonlySet<string>): string {
  const last = recapText !== undefined && open.size > 0 ? STARTED_AGAIN_UNANSWERED : STARTED_AGAIN;
  return recapText === undefined ? last : `${recapText}\n\n${last}`;
}
