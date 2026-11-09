// The person's minutes from their touches, pure. Each touch is credited the
// least time its act could take, as the interval before it was recorded. Touches less than BRIDGE_MS apart join one
// session, and the minutes are the union of the sessions; the low bound is the union of the credits alone.
import type { HumanSource } from "../../shared/contracts.ts";
import type { TouchRow } from "./store.ts";

export const MINUTE_MS = 60_000;
/** Touches closer than this join one session; the gap between them counts. */
export const BRIDGE_MS = 5 * MINUTE_MS;
/** Typing speed for a message's or an order's floor: about 30 words a minute. */
export const CHARS_PER_MINUTE = 150;
export const TYPED_MIN_MS = MINUTE_MS;
export const ITEM_MS = 30_000;
export const STEER_MS = MINUTE_MS;
export const DECISION_MS = MINUTE_MS;
export const REVIEW_BASE_MS = 3 * MINUTE_MS;
export const REVIEW_PER_100_LINES_MS = MINUTE_MS;
export const REVIEW_MAX_MS = 20 * MINUTE_MS;
export const COMMENT_MS = 30_000;
export const MERGE_BY_HAND_MS = MINUTE_MS;

/** Each touch kind and the chart series it adds to (contracts metrics.rs `touch_kinds!`). */
export const TOUCH_SOURCE: Record<string, HumanSource> = {
  "chat.message": "chat",
  "item.answered": "chat",
  "order.submitted": "chat",
  "host.review": "reviews",
  "host.comment": "reviews",
  "app.use": "app",
  "session.call": "sessions",
  steer: "other",
  decision: "other",
  "merge.by_hand": "other",
  commit: "other",
};
export const HUMAN_SOURCES: HumanSource[] = ["chat", "reviews", "app", "sessions", "other"];

/** The floor of a typed message or order of `chars` characters. */
export const typedMs = (chars: number) => Math.max(Math.trunc((chars * MINUTE_MS) / CHARS_PER_MINUTE), TYPED_MIN_MS);

/** The estimated credit of a review of a PR with `lines` changed (3 minutes when the host didn't say). */
export const reviewMs = (lines?: number) =>
  Math.min(REVIEW_BASE_MS + Math.trunc(Math.max(lines ?? 0, 0) / 100) * REVIEW_PER_100_LINES_MS, REVIEW_MAX_MS);

/** The person's own logins and emails on the git host, lowercased. */
export class Identities {
  private readonly ids = new Set<string>();

  /** A GitHub noreply email (`12345+login@users.noreply.github.com`) names its login too. */
  constructor(ids: Iterable<string>) {
    for (const raw of ids) {
      const id = raw.trim().toLowerCase();
      if (id === "") continue;
      const suffix = "@users.noreply.github.com";
      if (id.endsWith(suffix)) {
        const local = id.slice(0, -suffix.length);
        const plus = local.indexOf("+");
        this.ids.add(plus < 0 ? local : local.slice(plus + 1));
      }
      this.ids.add(id);
    }
  }

  has(who: string): boolean {
    return this.ids.has(who.trim().toLowerCase());
  }
}

const ON_HOST = new Set(["host.review", "host.comment", "merge.by_hand", "commit"]);

/** Whether a touch is the person's own: one read from the git host only when its account is one of theirs. */
export const attributed = (t: TouchRow, ids: Identities) => !ON_HOST.has(t.kind) || (t.keyId !== undefined && ids.has(t.keyId));

/** One touch's interval, cut to a range. */
export type Span = { start: number; end: number; source: HumanSource };

/** A touch's interval: the credit before it was recorded, or an observed interval as it is. */
export function span(t: TouchRow): Span {
  const source = TOUCH_SOURCE[t.kind] ?? "other";
  return t.endMs !== undefined
    ? { start: t.atMs, end: Math.max(t.endMs, t.atMs), source }
    : { start: t.atMs - Math.max(t.creditMs, 0), end: t.atMs, source };
}

/** Spans cut to `[since, until)`; those left empty go. */
export function clip(spans: Iterable<Span>, since: number, until: number): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const start = Math.max(s.start, since);
    const end = Math.min(s.end, until);
    if (end > start) out.push({ start, end, source: s.source });
  }
  return out;
}

/** The time spans add to the union, each credited to the source of the touch that added it. */
export function sessions(spans: Span[], bridgeMs: number): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  let end: number | undefined;
  for (const s of sorted) {
    if (end !== undefined && (s.start - end < bridgeMs || s.start < end)) {
      if (s.end > end) {
        out.push({ start: end, end: s.end, source: s.source });
        end = s.end;
      }
    } else {
      out.push(s);
      end = s.end;
    }
  }
  return out;
}

export const total = (pieces: Span[]) => pieces.reduce((sum, p) => sum + (p.end - p.start), 0);

/** The estimate and the low bound over the same spans. */
export type Minutes = { totalMs: number; lowMs: number };

export const minutes = (spans: Span[]): Minutes => ({
  totalMs: total(sessions(spans, BRIDGE_MS)),
  lowMs: total(sessions(spans, 0)),
});

/** The part of `pieces` inside `[from, to)`. */
export const within = (pieces: Span[], from: number, to: number) =>
  pieces.reduce((sum, p) => sum + Math.max(Math.min(p.end, to) - Math.max(p.start, from), 0), 0);
