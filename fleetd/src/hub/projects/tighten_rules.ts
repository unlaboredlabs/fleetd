// `project_setup`'s approvals, merges and mergeMode (D786, call 9): a lead makes a bot's approvals or merges stricter
// when a person asks in the chat ("ask me before every send"), never looser; loosening stays a person's, in the bot's
// settings. Pure, so the cloud holds a lead to the same order: each setting's values from loosest to strictest, and
// what a call may change.
import type { ApprovalMode, Merger, MergeMode } from "../../shared/contracts.ts";

/** Loosest first: YOLO asks nothing, the checker asks when unsure, Ask me about everything asks each time. */
export const APPROVALS_ORDER: readonly ApprovalMode[] = ["yolo", "checker", "ask"];
/** fleetd's train merging a PR is looser than a person merging it. */
export const MERGES_ORDER: readonly Merger[] = ["fleetd", "people"];
/** Merging before CI on the combined tree is looser than testing first. */
export const MERGE_MODE_ORDER: readonly MergeMode[] = ["verify_after", "test_first"];

/** A bot's safety settings a lead may tighten, as they are now. */
export type Strictness = { approvals: ApprovalMode; merges: Merger; mergeMode: MergeMode };

/** What a call asks for: any of them. */
export type TightenCall = Partial<Strictness>;

export const LOOSER_FIX = "A person loosens a bot's settings in the app: the bot's settings, Safety.";

/** The names the person reads, as the apps label each value. */
export const APPROVAL_WORDS: Record<ApprovalMode, string> = { yolo: "YOLO", checker: "Checker decides", ask: "Ask me about everything" };
export const MERGES_WORDS: Record<Merger, string> = { fleetd: "fleetd merges", people: "You merge" };
export const MERGE_MODE_WORDS: Record<MergeMode, string> = { verify_after: "Merge, then verify", test_first: "Test, then merge" };

const ORDERS = { approvals: APPROVALS_ORDER, merges: MERGES_ORDER, mergeMode: MERGE_MODE_ORDER } as const;
const WORDS = { approvals: APPROVAL_WORDS, merges: MERGES_WORDS, mergeMode: MERGE_MODE_WORDS } as const;
const WHAT = { approvals: "approvals", merges: "who merges", mergeMode: "how PRs merge" } as const;

/** The settings a call changes, each stricter than now; a value already set changes nothing. */
export type Tightened = { change: TightenCall } | { refused: string; fix: string; code: "invalid" | "forbidden" };

/**
 * Checks a lead's call against the bot's settings now, before anything changes: a value it doesn't know, or one looser
 * than now, refuses the whole call, so nothing changes in part.
 */
export function tighten(now: Strictness, call: TightenCall): Tightened {
  const keys = (Object.keys(ORDERS) as (keyof Strictness)[]).filter((k) => call[k] !== undefined);
  if (keys.length === 0) return { code: "invalid", refused: "Nothing to make stricter as sent.", fix: "Give approvals, merges or mergeMode." };
  const change: TightenCall = {};
  for (const k of keys) {
    const order = ORDERS[k] as readonly string[];
    const to = call[k] as string;
    const at = order.indexOf(to);
    if (at < 0) return { code: "invalid", refused: `${to} isn't a value of ${k}.`, fix: `Give one of ${order.join(", ")}.` };
    const from = order.indexOf(now[k]);
    if (at < from) {
      const words = WORDS[k] as Record<string, string>;
      return {
        code: "forbidden",
        refused: `${words[to]} is looser than ${words[now[k]]}: a lead only makes ${WHAT[k]} stricter, never looser.`,
        fix: LOOSER_FIX,
      };
    }
    if (at > from) (change as Record<string, string>)[k] = to;
  }
  return { change };
}
