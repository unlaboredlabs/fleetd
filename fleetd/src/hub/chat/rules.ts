// A chat message as the hub keeps and reads it, without the database (index.ts stores them): the limits, a new
// message's shape, its row's JSON, and when a chat needs the person.
import type {
  ArtifactPublished,
  AttachmentRef,
  ChatAuthor,
  ChatClient,
  ChatDelivery,
  ChatHistorySource,
  ChatItem,
  ChatMessage,
  ChatNudge,
  ChatReplyTo,
  MemoryRefreshed,
  PersonRef,
  RememberedItem,
  SetupChanged,
  SkillSaved,
  VaultImportCard,
  WorktreesKept,
} from "../../shared/contracts.ts";
import { parseMs } from "../store/time.ts";

export const CHAT_TEXT_MAX = 100_000;
export const CHAT_PAGE_MAX = 100;
export const CHAT_OPEN_ITEMS_MAX = 20;
export const CHAT_NUDGES_MAX = 3;
export const CHAT_OPEN_NUDGES_MAX = CHAT_NUDGES_MAX;
export const CHAT_NUDGE_MS = 24 * 60 * 60_000;
export const ATTACHMENTS_MAX = 20;
/** Event data stays under the log's 2 KB; a larger message is read with chat_history. */
export const EVENT_MESSAGE_MAX = 1800;
/** How long a nudge for a reply not yet in the chat waits for it to land. */
export const PENDING_MS = 10 * 60_000;
/** Agent keys' messages a minute (flow.rs `AGENT_PER_MINUTE`). */
export const AGENT_PER_MINUTE = 10;

/**
 * A message to add. `source` names the record it was read from, so reading it again adds nothing; `request` is a
 * human's clientRequestId, so a resend returns the same message.
 */
export type NewMessage = {
  author?: ChatAuthor;
  text?: string;
  attachments?: AttachmentRef[];
  streaming?: boolean;
  request?: string;
  source?: string;
  item?: ChatItem;
  history?: ChatHistorySource;
  remembered?: RememberedItem;
  memoryRefreshed?: MemoryRefreshed;
  worktreesKept?: WorktreesKept;
  skillSaved?: SkillSaved;
  setupChanged?: SetupChanged;
  artifact?: ArtifactPublished;
  vaultImport?: VaultImportCard;
  skills?: string[];
  by?: string;
  person?: PersonRef;
  client?: ChatClient;
  replyTo?: ChatReplyTo;
  delivery?: ChatDelivery;
  /** A human message not yet in the lead's session. */
  held?: boolean;
  /** Defaults to now. */
  createdMs?: number;
  /** Flagged for the person's look as it is added. */
  nudge?: string;
};

/** `s` cut to `max` UTF-16 units, never splitting a surrogate pair (executor/shell_mapper.rs `js_take`). */
export function jsTake(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

export const textOf = (s: string) => jsTake(s, CHAT_TEXT_MAX);

/** The message in the Rust struct's field order, absent fields left out, so rows read the same. */
export function serialize(m: ChatMessage): string {
  const o: Record<string, unknown> = {
    messageId: m.messageId,
    projectRef: m.projectRef,
    seq: m.seq,
    author: m.author,
    text: m.text,
    attachments: m.attachments ?? [],
    createdAt: m.createdAt,
  };
  const rest: (keyof ChatMessage)[] = [
    "updatedAt",
    "state",
    "clientRequestId",
    "delivery",
    "by",
    "person",
    "client",
    "replyTo",
    "item",
    "history",
    "parts",
    "remembered",
    "memoryRefreshed",
    "worktreesKept",
    "skills",
    "skillSaved",
    "setupChanged",
    "artifact",
    "vaultImport",
    "nudge",
  ];
  for (const k of rest) if (m[k] !== undefined && m[k] !== null) o[k] = m[k];
  return JSON.stringify(o);
}

export const parse = (data: string) => JSON.parse(data) as ChatMessage;

/**
 * Whether a lead message asks the human something: a line that ends with a question mark (past any closing
 * markdown), or a numbered item with one.
 */
export function asksQuestion(text: string): boolean {
  return text.split(/\r?\n/).some((raw) => {
    const l = raw.trim();
    const m = /^([^.)]*)[.)]/.exec(l);
    const numbered = !!m && m[1] !== undefined && m[1].length > 0 && m[1].length <= 2 && /^[0-9]+$/.test(m[1]);
    return (numbered && l.includes("?")) || l.replace(/[\s*_`)"]+$/u, "").endsWith("?");
  });
}

export const asksInABlock = (m: ChatMessage) => (m.parts ?? []).some((p) => p.block?.kind === "ask");

export const itemOpen = (item: ChatItem) => (item as { state?: string }).state === "open";

/**
 * The needs-you rule: an inline item waits for an answer, or any lead message since the human last wrote asks
 * something. History and a reply still streaming don't count.
 */
export function needsYou(messages: ChatMessage[]): boolean {
  if (messages.some((m) => m.item !== undefined && itemOpen(m.item))) return true;
  let since = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatMessage;
    if (m.author === "human" && m.history === undefined) {
      since = i + 1;
      break;
    }
  }
  return messages
    .slice(since)
    .some((m) => m.author === "lead" && m.history === undefined && m.state === "final" && (asksQuestion(m.text) || asksInABlock(m)));
}

/** Whether a nudge still waits at `now`: not cleared, and less than a day old. */
export function nudgeWaiting(nudge: ChatNudge, now: number): boolean {
  const at = parseMs(nudge.at);
  return nudge.cleared === undefined && at !== undefined && now - at < CHAT_NUDGE_MS;
}
