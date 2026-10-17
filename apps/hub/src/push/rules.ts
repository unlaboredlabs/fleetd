// How loud items become one Web Push line, and when it may go out; what is loud is attention/rules.ts. Pure, so the rules are tested without a clock or a network.
import type { Ask, AskId } from "@fleetd/contracts";
import { COALESCE_MS } from "../attention/rules.ts";

/** One thing only the human can unblock. `line` is what the phone shows: one line, no secret values. */
export interface LoudItem {
  readonly line: string;
  /** Money and irreversible (prod harm) items are pushed during quiet hours too. */
  readonly breaksQuiet: boolean;
  /** An ask that stops being loud once it is answered or withdrawn. */
  readonly askId?: AskId;
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The one line a push shows for an ask the hub marked for attention (attention/rules.ts). */
export const askLine = (ask: Ask, reopened: boolean): string => {
  const subject = ask.kind === "approve" && ask.gated !== undefined ? ask.gated.reason : ask.text;
  const what = ask.kind === "approve" ? "approval" : ask.kind === "decide" ? "decision" : ask.kind === "do" ? "checklist" : "secret";
  const why = reopened && ask.evidence !== undefined ? ` (${oneLine(ask.evidence.split("\n")[0]!, 60)})` : "";
  return oneLine(`${ask.askId} ${ask.class} ${what}${reopened ? " again" : ""}: ${subject}${why}`, 140);
};

/** Any other loud event (usage.breaker, machine.offline with running work), by its plain summary. */
export const eventLine = (summary: string) => oneLine(summary, 140);

/** The push text: the first item, then how many more it stands for. */
export const pushLine = (items: ReadonlyArray<LoudItem>) =>
  items.length <= 1 ? (items[0]?.line ?? "") : `${items[0]!.line} (+${items.length - 1} more)`;

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
