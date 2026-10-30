// Search, as Telegram's: the chats whose name matches, then the messages that say it, newest first, each with the
// words around the match. The hub has no search of its own, so it runs over what the phone holds: each chat's newest
// page (read when search opens, session.ts) and whatever was opened. Pure, so it is unit-tested.
import type { ChatMessage } from "./desktop";
import { previewText } from "./markdown";
import type { Key } from "./store";

export interface MessageHit {
  readonly key: Key;
  readonly messageId: string;
  readonly seq: number;
  readonly at: string;
  readonly author: ChatMessage["author"];
  /** The message's words around the match, on one line. */
  readonly snippet: string;
  /** Where the match is in the snippet: [start, end). */
  readonly match: readonly [number, number];
}

/** Words before the match a snippet keeps, so the match shows near the start of a one-line preview. */
const LEAD = 24;
export const MAX_HITS = 60;

const fold = (s: string): string => s.toLocaleLowerCase();

/** The query's words as typed, trimmed; empty when there is nothing to look for. */
export const queryOf = (typed: string): string => typed.trim().replace(/\s+/gu, " ");

export const matchesName = (name: string, query: string): boolean => query !== "" && fold(name).includes(fold(query));

/**
 * A message's words around `query`, or undefined when it doesn't say it. `blocks`: a lead's or agent's words, whose
 * fleetd-block fences never show as their JSON; a person's are the code they wrote.
 */
export const snippetOf = (text: string, query: string, blocks: boolean): { snippet: string; match: readonly [number, number] } | undefined => {
  if (query === "") return undefined;
  const plain = previewText(text, { blocks });
  const at = fold(plain).indexOf(fold(query));
  if (at < 0) return undefined;
  const cut = at > LEAD ? plain.lastIndexOf(" ", at - LEAD) + 1 || at - LEAD : 0;
  const lead = cut > 0 ? "…" : "";
  const snippet = lead + plain.slice(cut);
  const start = at - cut + lead.length;
  return { snippet, match: [start, start + query.length] };
};

/** Every held message that says `query`, newest first, each once. */
export const searchMessages = (sources: Readonly<Record<Key, readonly ChatMessage[]>>, query: string): readonly MessageHit[] => {
  if (query === "") return [];
  const seen = new Set<string>();
  const hits: MessageHit[] = [];
  for (const [key, messages] of Object.entries(sources)) {
    for (const m of messages) {
      if (seen.has(m.messageId) || m.state === "streaming") continue;
      seen.add(m.messageId);
      const found = snippetOf(m.text, query, m.author !== "human");
      if (found !== undefined) hits.push({ key, messageId: m.messageId, seq: m.seq, at: m.createdAt, author: m.author, ...found });
    }
  }
  return hits.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_HITS);
};
