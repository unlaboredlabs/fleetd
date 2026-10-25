// The Decisions tab's model, pure so it is tested on its own: the hub's decisions (every state) grouped by key and
// scope, the one in force on top and the ones it replaced or that were revoked folded under it; the words each row
// shows; and the search and filters over them. Decision ids (D12) and order ids (W3) never reach a word here.
import type { Decision, DecisionOrder } from "../../../shared/contracts";

/** Who decided, as the tab says it: the lead, the person reading, or (rarely) an agent's key. */
export type Who = "lead" | "you" | "agent";

export const whoOf = (d: Pick<Decision, "source">): Who => (d.source === "human" ? "you" : d.source === "lead" ? "lead" : "agent");

const WHO_WORD: Readonly<Record<Who, string>> = { lead: "Lead", you: "You", agent: "An agent" };
export const whoWord = (d: Pick<Decision, "source">): string => WHO_WORD[whoOf(d)];

// Short words read better as capitals than as "Api" or "Ci".
const ACRONYMS = new Set(["api", "ci", "cd", "css", "db", "dns", "html", "http", "https", "id", "ip", "json", "jwt", "llm", "pr", "sdk", "sql", "ssh", "sso", "tls", "tz", "ui", "url", "ux"]);

/** A key in plain words: "api.health.path" → "API health path", "policy.quiet_hours" → "Policy quiet hours". */
export const keyWords = (key: string): string => {
  const words = key
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w));
  if (words.length === 0) return key;
  const [first = "", ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
};

/** Where a decision applies: the whole project, or one order by its title. */
export interface Where {
  /** "project", or the order's workstream id: a filter value, never shown. */
  readonly id: string;
  readonly label: string;
}

export const PROJECT_WIDE: Where = { id: "project", label: "Whole project" };

export const whereOf = (d: Pick<Decision, "scope">, titles: ReadonlyMap<string, string>): Where => {
  if (d.scope.kind !== "workstream") return PROJECT_WIDE;
  const title = titles.get(d.scope.workstreamId)?.trim();
  return { id: d.scope.workstreamId, label: title === undefined || title === "" ? "An order" : title };
};

/** One key in one scope: the decision answering it now (or the last one, when revoked), and what came before. */
export interface Thread {
  readonly id: string;
  readonly key: string;
  readonly words: string;
  readonly where: Where;
  /** Active, or for a revoked key its last decision. */
  readonly head: Decision;
  readonly live: boolean;
  /** Superseded and revoked ones, newest first. */
  readonly earlier: readonly Decision[];
}

const threadId = (d: Pick<Decision, "key" | "scope">): string => `${d.key}@${d.scope.kind === "workstream" ? d.scope.workstreamId : d.scope.kind}`;

const atMs = (d: Pick<Decision, "at">): number => Date.parse(d.at) || 0;

/** The decisions as threads: live ones first, then revoked keys, each newest first. */
export const threadsOf = (decisions: readonly Decision[], orders: readonly DecisionOrder[]): Thread[] => {
  const titles = new Map(orders.map((o) => [o.workstreamId, o.title]));
  const byThread = new Map<string, Decision[]>();
  for (const d of decisions) {
    const id = threadId(d);
    byThread.set(id, [...(byThread.get(id) ?? []), d]);
  }
  const threads: Thread[] = [];
  for (const [id, all] of byThread) {
    const sorted = [...all].sort((a, b) => atMs(b) - atMs(a));
    const head = sorted.find((d) => d.state === "active") ?? sorted[0];
    if (head === undefined) continue;
    threads.push({
      id,
      key: head.key,
      words: keyWords(head.key),
      where: whereOf(head, titles),
      head,
      live: head.state === "active",
      earlier: sorted.filter((d) => d !== head),
    });
  }
  return threads.sort((a, b) => Number(b.live) - Number(a.live) || atMs(b.head) - atMs(a.head));
};

export type WhoFilter = "anyone" | "lead" | "you";

export interface Filters {
  readonly query: string;
  readonly who: WhoFilter;
  /** "all", "project", or an order's workstream id. */
  readonly where: string;
}

export const NO_FILTERS: Filters = { query: "", who: "anyone", where: "all" };

export const filtered = (f: Filters): boolean => f.query.trim() !== "" || f.who !== "anyone" || f.where !== "all";

const haystack = (t: Thread): string =>
  [t.words, t.key, t.where.label, ...[t.head, ...t.earlier].flatMap((d) => [d.value, d.why ?? "", d.retired?.why ?? ""])].join("\n").toLowerCase();

/** The threads matching every word of the search, who decided the one on top, and where it applies. */
export const applyFilters = (threads: readonly Thread[], f: Filters): Thread[] => {
  const words = f.query.toLowerCase().split(/\s+/u).filter(Boolean);
  return threads.filter((t) => {
    if (f.who !== "anyone" && whoOf(t.head) !== f.who) return false;
    if (f.where !== "all" && t.where.id !== f.where) return false;
    if (words.length === 0) return true;
    const text = haystack(t);
    return words.every((w) => text.includes(w));
  });
};

/** The places decisions apply, for the scope filter: the project, then each order with one, by title. */
export const placesOf = (threads: readonly Thread[]): Where[] => {
  const orders = new Map<string, Where>();
  for (const t of threads) if (t.where.id !== PROJECT_WIDE.id) orders.set(t.where.id, t.where);
  return [PROJECT_WIDE, ...[...orders.values()].sort((a, b) => a.label.localeCompare(b.label))];
};

/** How many decisions are in force: the tab's count. */
export const liveCount = (decisions: readonly Pick<Decision, "state">[]): number => decisions.filter((d) => d.state === "active").length;

const formats = new Map<string, Intl.DateTimeFormat>();
const format = (options: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat => {
  const key = JSON.stringify([options, timeZone]);
  let f = formats.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(undefined, timeZone === undefined ? options : { ...options, timeZone });
    formats.set(key, f);
  }
  return f;
};

/** When, short: "14:02" today, "Mon 14:02" this week, "19 Oct" before, "19 Oct 2025" another year. */
export const when = (iso: string, nowMs: number, timeZone?: string): string => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const day = (t: number) => format({ year: "numeric", month: "2-digit", day: "2-digit" }, timeZone).format(t);
  const year = (t: number) => format({ year: "numeric" }, timeZone).format(t);
  const hm = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  if (day(ms) === day(nowMs)) return format(hm, timeZone).format(ms);
  if (ms <= nowMs && nowMs - ms < 6 * 86_400_000) return format({ weekday: "short", ...hm }, timeZone).format(ms);
  if (year(ms) === year(nowMs)) return format({ day: "numeric", month: "short" }, timeZone).format(ms);
  return format({ day: "numeric", month: "short", year: "numeric" }, timeZone).format(ms);
};

/** What became of an earlier decision, in a few words: "Replaced", or who revoked it. */
export const fateWord = (d: Decision): string => {
  if (d.state === "superseded") return "Replaced";
  if (d.state === "retired") return d.retired === undefined ? "Withdrawn" : "Revoked by you";
  return "In force";
};

/** The faint line under a value: who decided, where it applies, and how many came before. */
export const metaLine = (t: Thread): string => {
  const parts = [whoWord(t.head), t.where.label];
  if (t.earlier.length > 0) parts.push(t.earlier.length === 1 ? "1 earlier" : `${t.earlier.length} earlier`);
  return parts.join(" · ");
};

/** The overturn form's check before it goes to the hub, in the hub's own bounds (DecisionValue, DecisionWhy). */
export const overturnProblem = (mode: "change" | "revoke", value: string, why: string, current: string): string | undefined => {
  if (mode === "change") {
    if (value.trim() === "") return "Say what it should be instead.";
    if (value.trim() === current.trim()) return "That’s what it is already.";
    if (value.length > 2000) return "Keep it under 2,000 characters.";
  }
  if (why.trim() === "") return "Say why, in a few words: the lead reads it.";
  if (why.length > 2000) return "Keep the why under 2,000 characters.";
  return undefined;
};
