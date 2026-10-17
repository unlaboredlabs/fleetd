// What earns a Web Push, and when it may go out. Pure, so the rules are tested without a clock or a network.
import type { Ask, AskId } from "@fleetd/contracts";

/** One thing only the human can unblock. `line` is what the phone shows: one line, no secret values. */
export interface LoudItem {
  readonly line: string;
  /** Money and irreversible (prod harm) items are pushed during quiet hours too. */
  readonly breaksQuiet: boolean;
  /** An ask that stops being loud once it is answered or withdrawn. */
  readonly askId?: AskId;
}

/** At most one push per this window; what arrives meanwhile is folded into the next one as "+N more". */
export const COALESCE_MS = 20 * 60_000;

export const QUIET_HOURS_KEY = "policy.quiet_hours";

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * A money, credential or irreversible ask that blocks a step is loud (gated runs of class irreversible or money block
 * the lead's step by construction), and so is any approval put back in front of the human because it never ran or
 * its result is unknown. Product calls and non-blocking asks wait for the inbox and the digest.
 */
export const loudAsk = (ask: Ask, reopened: boolean): LoudItem | undefined => {
  const blocking = ask.class !== "product" && ask.blocks !== "nothing";
  const unrunApproval = reopened && ask.kind === "approve";
  if (ask.state !== "open" || !(blocking || unrunApproval)) return undefined;
  const subject = ask.kind === "approve" && ask.gated !== undefined ? ask.gated.reason : ask.text;
  const what = ask.kind === "approve" ? "approval" : ask.kind === "decide" ? "decision" : ask.kind === "do" ? "checklist" : "secret";
  const why = reopened && ask.evidence !== undefined ? ` (${oneLine(ask.evidence.split("\n")[0]!, 60)})` : "";
  return {
    line: oneLine(`${ask.askId} ${ask.class} ${what}${reopened ? " again" : ""}: ${subject}${why}`, 140),
    breaksQuiet: ask.class === "money" || ask.class === "irreversible",
    askId: ask.askId,
  };
};

/** Any other loud event (usage.breaker, machine.offline with running work), by its plain summary. */
export const loudEvent = (summary: string): LoudItem => ({ line: oneLine(summary, 140), breaksQuiet: false });

/** The push text: the first item, then how many more it stands for. */
export const pushLine = (items: ReadonlyArray<LoudItem>) =>
  items.length <= 1 ? (items[0]?.line ?? "") : `${items[0]!.line} (+${items.length - 1} more)`;

export interface QuietHours {
  /** Minutes after local midnight. */
  readonly start: number;
  readonly end: number;
}

/** DESIGN §4: the hours that apply while no `policy.quiet_hours` decision exists. */
export const DEFAULT_QUIET_HOURS = "23:00-08:00";

/** `"23:00-08:00"`; undefined for anything else (such as "off"), which means no quiet hours. */
export const parseQuietHours = (value: string): QuietHours | undefined => {
  const match = /^\s*([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)\s*$/u.exec(value);
  if (match === null) return undefined;
  const [, h1, m1, h2, m2] = match.map(Number) as [number, number, number, number, number];
  const quiet = { start: h1 * 60 + m1, end: h2 * 60 + m2 };
  return quiet.start === quiet.end ? undefined : quiet;
};

/** The quiet hours a `policy.quiet_hours` decision sets, or the default when there is none. */
export const quietHours = (decided: string | undefined) => parseQuietHours(decided ?? DEFAULT_QUIET_HOURS);

const localMinutes = (nowMs: number, tz: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(nowMs);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
};

/** When the quiet hours around `nowMs` end, or undefined when it is not quiet now. */
export const quietUntil = (nowMs: number, tz: string, quiet: QuietHours | undefined): number | undefined => {
  if (quiet === undefined) return undefined;
  const now = localMinutes(nowMs, tz);
  const inside = quiet.start < quiet.end ? now >= quiet.start && now < quiet.end : now >= quiet.start || now < quiet.end;
  if (!inside) return undefined;
  const minutes = (quiet.end - now + 1440) % 1440;
  return nowMs - (nowMs % 60_000) + minutes * 60_000;
};

export type Plan =
  | { readonly kind: "send"; readonly items: ReadonlyArray<LoudItem>; readonly held: ReadonlyArray<LoudItem> }
  | { readonly kind: "wait"; readonly untilMs: number }
  | { readonly kind: "idle" };

/**
 * What to do with the pending items now: send them as one push, or wait for the coalescing window or the end of the
 * quiet hours. During quiet hours only items that break through are sent; the rest are held for when they end.
 */
export const plan = (pending: ReadonlyArray<LoudItem>, nowMs: number, lastSentMs: number | undefined, quietEndMs: number | undefined): Plan => {
  if (pending.length === 0) return { kind: "idle" };
  const sendable = quietEndMs === undefined ? pending : pending.filter((item) => item.breaksQuiet);
  if (sendable.length === 0) return { kind: "wait", untilMs: quietEndMs! };
  if (lastSentMs !== undefined && nowMs - lastSentMs < COALESCE_MS) return { kind: "wait", untilMs: lastSentMs + COALESCE_MS };
  return { kind: "send", items: sendable, held: pending.filter((item) => !sendable.includes(item)) };
};
