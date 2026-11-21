// One chat's search, on its Info page (D238), as Messages and Telegram search a conversation: the hub looks through the
// whole chat back to its start from its index (chat_find), each word the start of a word in any order and case, "a
// phrase in quotes" word for word, and answers newest first, a page at a time, each hit a line of its words with the
// matched ones marked, the first page with how many there are. Filters narrow it, as tokens beside the words: who wrote
// it (you, another person, the lead, its agents), when (today, the last week or month, this year, or one day), and what
// it holds (a link, a file or image, a pull request, a pin); a filter alone, with no words, lists what it holds (a
// day's messages, the chat's links). What is typed waits a moment before it goes, and an answer to a search no longer
// asked is dropped. Pure, so it is unit-tested.
import type { ChatFindHas, ChatFindHit, ChatFindInput, HubError, PersonRef } from "./desktop";

/** How long typing rests before the search goes to the hub. */
export const FIND_REST_MS = 220;
/** Hits read at a time. */
export const FIND_PAGE = 30;
/** chat_find's longest words. */
export const FIND_MAX = 200;

/** Who wrote it. */
export type FindFrom = { readonly t: "me" } | { readonly t: "person"; readonly person: PersonRef } | { readonly t: "lead" } | { readonly t: "agents" };

/** When: a range back from today, or one day (its local date, "2026-11-03"). */
export type FindWhen = { readonly t: "today" | "yesterday" | "week" | "month" | "year" } | { readonly t: "day"; readonly day: string };

export interface FindQuery {
  /** As typed, one line. */
  readonly words: string;
  readonly from?: FindFrom | undefined;
  readonly when?: FindWhen | undefined;
  /** Every one must hold. */
  readonly has: readonly ChatFindHas[];
}

export const NO_QUERY: FindQuery = { words: "", has: [] };

/** What is typed, as the hub takes it: one line, its spaces folded, at most FIND_MAX characters. */
export const wordsOf = (typed: string): string => typed.replace(/\s+/gu, " ").trim().slice(0, FIND_MAX).trim();

/** Whether there is anything to look for: words (a lone quote isn't) or a filter. */
export const asks = (q: FindQuery): boolean => wordsOf(q.words).replace(/"/gu, "").trim() !== "" || q.from !== undefined || q.when !== undefined || q.has.length > 0;

/** One search's identity: an answer for another is dropped. */
export const queryKey = (q: FindQuery): string =>
  JSON.stringify([wordsOf(q.words), q.from?.t === "person" ? q.from.person.personId : (q.from?.t ?? ""), q.when?.t === "day" ? q.when.day : (q.when?.t ?? ""), [...q.has].sort()]);

const dayStart = (y: number, m: number, d: number): number => new Date(y, m, d).getTime();

/** A local date as "2026-11-03". */
export const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A day ("2026-11-03") from its local start to the next day's, as ISO times. */
export const dayRange = (day: string): { readonly since: string; readonly until: string } => {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return { since: new Date(dayStart(y, m - 1, d)).toISOString(), until: new Date(dayStart(y, m - 1, d + 1)).toISOString() };
};

/** When, in local time on the phone's clock, as chat_find's since (and until, for a day gone). */
export const whenRange = (when: FindWhen, nowMs: number): { readonly since: string; readonly until?: string } => {
  const now = new Date(nowMs);
  const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  switch (when.t) {
    case "today":
      return { since: new Date(dayStart(y, m, d)).toISOString() };
    case "yesterday":
      return { since: new Date(dayStart(y, m, d - 1)).toISOString(), until: new Date(dayStart(y, m, d)).toISOString() };
    case "week":
      return { since: new Date(dayStart(y, m, d - 6)).toISOString() };
    case "month":
      return { since: new Date(dayStart(y, m, d - 29)).toISOString() };
    case "year":
      return { since: new Date(dayStart(y, 0, 1)).toISOString() };
    case "day":
      return dayRange(when.day);
  }
};

/** The query as chat_find takes it, but for the chat, the cursor and the page's length. */
export const findInput = (q: FindQuery, me: string | undefined, nowMs: number): Omit<ChatFindInput, "projectRef" | "before" | "limit"> => {
  const words = wordsOf(q.words);
  const from = q.from;
  const who =
    from === undefined
      ? {}
      : from.t === "lead"
        ? { author: "lead" as const }
        : from.t === "agents"
          ? { author: "agent" as const }
          : from.t === "person"
            ? { personId: from.person.personId }
            : me === undefined
              ? { author: "human" as const }
              : { personId: me };
  return {
    ...(words === "" ? {} : { words }),
    ...who,
    ...(q.when === undefined ? {} : whenRange(q.when, nowMs)),
    ...(q.has.length === 0 ? {} : { has: [...q.has] }),
  };
};

export interface Find {
  /** The search the hits are for (queryKey); "" with nothing asked. */
  readonly key: string;
  readonly hits: readonly ChatFindHit[];
  readonly more: boolean;
  /** How many there are, from the first page; `countMore` when there are more than that. */
  readonly count?: number | undefined;
  readonly countMore?: boolean | undefined;
  /** The hub is still indexing older messages: the hits cover the newer part. */
  readonly indexing?: boolean | undefined;
  /** A page on its way: the first (nothing shown yet for this search) or the next. */
  readonly reading: "first" | "next" | null;
  readonly error?: HubError | undefined;
}

export const NO_FIND: Find = { key: "", hits: [], more: false, reading: null };

export type FindAction =
  /** A new search asked ("" for none); the hits shown for the one before stay until its first page comes. */
  | { readonly t: "asked"; readonly key: string }
  | { readonly t: "next" }
  | { readonly t: "page"; readonly key: string; readonly hits: readonly ChatFindHit[]; readonly more: boolean; readonly next: boolean; readonly count?: number | undefined; readonly countMore?: boolean | undefined; readonly indexing?: boolean | undefined }
  | { readonly t: "failed"; readonly key: string; readonly error: HubError };

export const reduceFind = (f: Find, a: FindAction): Find => {
  switch (a.t) {
    case "asked":
      if (a.key === f.key && f.error === undefined) return f;
      // The hits of the search before stay in view while this one reads: the list never blinks empty as you type.
      return a.key === "" ? NO_FIND : { ...f, key: a.key, more: false, reading: "first", error: undefined };
    case "next":
      return f.reading !== null || !f.more || f.error !== undefined ? f : { ...f, reading: "next" };
    case "page": {
      if (a.key !== f.key) return f;
      if (!a.next) return { key: f.key, hits: a.hits, more: a.more, count: a.count, countMore: a.countMore, indexing: a.indexing, reading: null };
      // One hit once, if a page overlaps the one before it.
      const known = new Set(f.hits.map((h) => h.messageId));
      return { ...f, hits: [...f.hits, ...a.hits.filter((h) => !known.has(h.messageId))], more: a.more, reading: null };
    }
    case "failed":
      return a.key !== f.key ? f : { ...f, reading: null, error: a.error };
  }
};

/** The next page's cursor: the last hit's message, once a page is asked for. */
export const cursorOf = (f: Find): string | undefined => (f.reading === "next" ? f.hits.at(-1)?.messageId : undefined);

/** How many, over the hits: "41 Results", "1,000+ Results"; nothing until the first page says. */
export const countLine = (f: Find): string | undefined => {
  if (f.key === "" || f.reading === "first" || f.error !== undefined) return undefined;
  const n = f.count ?? (f.more ? undefined : f.hits.length);
  if (n === undefined || n === 0) return undefined;
  const words = `${n.toLocaleString("en-US")}${f.countMore === true ? "+" : ""}`;
  return n === 1 && f.countMore !== true ? "1 Result" : `${words} Results`;
};

/** Nothing found for the search: iOS's "No Results" shows in the list's place. */
export const noResults = (f: Find): boolean => f.key !== "" && f.reading === null && f.error === undefined && f.hits.length === 0;

/** A hit's line in pieces, marked or not, from the hub's marks: kept in order and inside the text, whatever came. */
export const markedPieces = (text: string, marks: readonly (readonly [number, number])[]): ReadonlyArray<{ readonly text: string; readonly marked: boolean }> => {
  const out: Array<{ text: string; marked: boolean }> = [];
  let at = 0;
  for (const [from, to] of [...marks].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(at, Math.min(from, text.length));
    const end = Math.min(Math.max(to, start), text.length);
    if (end <= start) continue;
    if (start > at) out.push({ text: text.slice(at, start), marked: false });
    out.push({ text: text.slice(start, end), marked: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false });
  return out;
};

/** Who wrote a hit or a pin, as its row names them: "You", another person, the lead's bot, or the agent. */
export const whoOf = (m: { readonly author: string; readonly by?: string | undefined; readonly person?: PersonRef | undefined }, me: string | undefined, bot: string): string => {
  if (m.author === "human") return m.person === undefined || m.person.personId === me ? "You" : m.person.name;
  if (m.author === "agent") return m.by ?? "Agent";
  return bot;
};

/** The filters' words, as their tokens and menus say them. */
export const HAS_WORDS: Readonly<Record<string, string>> = { link: "Links", image: "Photos", file: "Files", pr: "Pull Requests", pinned: "Pinned" };
export const HAS_ORDER: readonly ChatFindHas[] = ["link", "image", "file", "pr", "pinned"];
export const WHEN_WORDS: Readonly<Record<Exclude<FindWhen["t"], "day">, string>> = { today: "Today", yesterday: "Yesterday", week: "Last 7 Days", month: "Last 30 Days", year: "This Year" };

export const fromWord = (from: FindFrom, bot: string): string => (from.t === "me" ? "You" : from.t === "person" ? from.person.name : from.t === "lead" ? bot : "Agents");

/** A day, as its token says it: "3 Nov 2026", the year left out when it's this one's. */
export const dayWord = (day: string, nowMs: number): string => {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const thisYear = new Date(nowMs).getFullYear() === y;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(thisYear ? {} : { year: "numeric" }) });
};

export const whenWord = (when: FindWhen, nowMs: number): string => (when.t === "day" ? dayWord(when.day, nowMs) : WHEN_WORDS[when.t]);

/** The tokens beside the words: each filter on, which a tap takes off. */
export type FindToken = { readonly t: "from"; readonly label: string } | { readonly t: "when"; readonly label: string } | { readonly t: "has"; readonly has: ChatFindHas; readonly label: string };

export const tokensOf = (q: FindQuery, bot: string, nowMs: number): readonly FindToken[] => [
  ...(q.from === undefined ? [] : [{ t: "from" as const, label: fromWord(q.from, bot) }]),
  ...(q.when === undefined ? [] : [{ t: "when" as const, label: whenWord(q.when, nowMs) }]),
  ...HAS_ORDER.filter((h) => q.has.includes(h)).map((has) => ({ t: "has" as const, has, label: HAS_WORDS[has] ?? has })),
];

export const withoutToken = (q: FindQuery, token: FindToken): FindQuery =>
  token.t === "from" ? { ...q, from: undefined } : token.t === "when" ? { ...q, when: undefined } : { ...q, has: q.has.filter((h) => h !== token.has) };

export const toggleHas = (q: FindQuery, has: ChatFindHas): FindQuery => ({ ...q, has: q.has.includes(has) ? q.has.filter((h) => h !== has) : [...q.has, has] });

/** The people the From menu offers besides you: whoever else wrote in the messages held, each once, by name. */
export const othersOf = (messages: ReadonlyArray<{ readonly person?: PersonRef | undefined }>, me: string | undefined): readonly PersonRef[] => {
  const byId = new Map<string, PersonRef>();
  for (const m of messages) if (m.person !== undefined && m.person.personId !== me) byId.set(m.person.personId, m.person);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
};
