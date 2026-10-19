// The chat as rows: day dividers, messages grouped by author (a run from one author within a few minutes shows its
// name and time once), fleetd's own messages folded to one quiet line, event one-liners, inline items, the live
// strip under the lead's newest message, and the top of the history (older pages, or its start).
import type { ChatItem } from "./contract";

export type Row =
  | { readonly kind: "top"; readonly key: "top"; readonly state: "more" | "loading" | "start" }
  | { readonly kind: "day"; readonly key: string; readonly label: string }
  | { readonly kind: "message"; readonly key: string; readonly item: ChatItem; readonly head: boolean }
  | { readonly kind: "system"; readonly key: string; readonly item: ChatItem }
  | { readonly kind: "event"; readonly key: string; readonly item: ChatItem }
  | { readonly kind: "inline"; readonly key: string; readonly item: ChatItem }
  | { readonly kind: "strip"; readonly key: "strip" };

/** Messages from one author this close together read as one turn: the name and time show once. */
const GROUP_MS = 5 * 60_000;

const dayKey = (iso: string, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(Date.parse(iso));

/** "Today", "Yesterday", or "Mon 19 Oct" (with the year when it isn't this year's). */
export function dayLabel(iso: string, nowMs: number, timeZone?: string): string {
  const day = dayKey(iso, timeZone);
  if (day === dayKey(new Date(nowMs).toISOString(), timeZone)) return "Today";
  if (day === dayKey(new Date(nowMs - 86_400_000).toISOString(), timeZone)) return "Yesterday";
  const sameYear = day.slice(0, 4) === dayKey(new Date(nowMs).toISOString(), timeZone).slice(0, 4);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    ...(timeZone ? { timeZone } : {}),
  })
    .format(Date.parse(iso))
    .replace(",", "");
}

export interface RowsInput {
  readonly items: readonly ChatItem[];
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** Show the live strip (the project has agents at work, or the strip has something to say). */
  readonly strip: boolean;
  readonly nowMs: number;
  readonly timeZone?: string;
}

export function chatRows(i: RowsInput): Row[] {
  const out: Row[] = [{ kind: "top", key: "top", state: i.loadingOlder ? "loading" : i.hasOlder ? "more" : "start" }];
  let lastDay: string | undefined;
  let prev: ChatItem | undefined;
  // The strip goes under the lead's newest message, or at the end when the lead hasn't said anything yet.
  let leadLast = -1;
  i.items.forEach((item, n) => {
    if (item.author === "lead" && item.kind === "message") leadLast = n;
  });
  i.items.forEach((item, n) => {
    const day = dayKey(item.at, i.timeZone);
    if (day !== lastDay) {
      out.push({ kind: "day", key: `day:${day}`, label: dayLabel(item.at, i.nowMs, i.timeZone) });
      lastDay = day;
      prev = undefined;
    }
    if (item.kind === "event") out.push({ kind: "event", key: item.id, item });
    else if (item.kind === "secret" || item.kind === "gated") out.push({ kind: "inline", key: item.id, item });
    else if (item.author === "system") out.push({ kind: "system", key: item.id, item });
    else {
      const head =
        prev === undefined || prev.kind !== "message" || prev.author !== item.author || Date.parse(item.at) - Date.parse(prev.at) > GROUP_MS;
      out.push({ kind: "message", key: item.id, item, head });
    }
    prev = item;
    if (i.strip && n === leadLast) out.push({ kind: "strip", key: "strip" });
  });
  if (i.strip && leadLast === -1) out.push({ kind: "strip", key: "strip" });
  return out;
}

/** The row to open at for a message id (a notification's ?message=), or undefined when it isn't loaded. */
export const rowIndexOf = (rows: readonly Row[], messageId: string): number | undefined => {
  const i = rows.findIndex((r) => (r.kind === "message" || r.kind === "system" || r.kind === "event" || r.kind === "inline") && r.item.id === messageId);
  return i === -1 ? undefined : i;
};

const plain = (line: string): string =>
  line
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
    .replace(/^#+\s*/, "")
    .replace(/[*_`]+/g, "")
    .trim();

/** fleetd's own message to the lead, as one quiet line: why it was woken, or its first line. */
export function systemHeadline(text: string): string {
  const why = /^##\s*Why you are woken\s*$/m.exec(text);
  if (why) {
    const reasons = text
      .slice(why.index + why[0].length)
      .split("\n")
      .filter((l) => /^\s*-\s+\S/.test(l));
    const first = reasons[0];
    if (first !== undefined) {
      const line = plain(first).split(/;\s|\.\s/)[0] ?? "";
      const cut = line.length > 120 ? `${line.slice(0, 119)}…` : line;
      return `Woken: ${cut}${reasons.length > 1 ? ` (+${String(reasons.length - 1)} more)` : ""}`;
    }
    return "Woken by fleetd";
  }
  const line = text.split("\n").map(plain).find((l) => l.length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
