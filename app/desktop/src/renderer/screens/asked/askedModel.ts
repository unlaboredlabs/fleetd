// A project's Asked tab as rows: each message its lead sent another project's lead (project_asks), said in a short line, with how
// its order is going as one word and whether its lead folded it into the order of an earlier ask. Pure, so it is
// unit-tested. No fleetd ids: an order is its title.
import type { ProjectAsk, ProjectAskOrder } from "../../../shared/contracts";
import type { StatusTone } from "../../ui";

/** One message the lead sent another project's lead (project_message), and the orders that lead opened for it. */
export type Ask = ProjectAsk;

export type AskedOrder = ProjectAskOrder;

export type AskState = "waiting" | "working" | "merged" | "done" | "stopped";

/** Each state as its chip says it, and what it means on hover. */
export const ASK_STATE: Readonly<Record<AskState, { readonly word: string; readonly tone: StatusTone; readonly hint: string }>> = {
  waiting: { word: "Waiting", tone: "idle", hint: "No order yet: its lead hasn’t opened one, or answered in its chat without one" },
  working: { word: "Working", tone: "working", hint: "Its order is under way" },
  merged: { word: "Merged", tone: "done", hint: "Its order is done, and its work merged" },
  done: { word: "Done", tone: "done", hint: "Its order is done" },
  stopped: { word: "Stopped", tone: "quiet", hint: "Its order was stopped before it was done" },
};

/** An order's state: open is under way; a done one with a merged PR merged. */
export const orderState = (o: AskedOrder): AskState =>
  o.state === "open" ? "working" : o.state === "stopped" ? "stopped" : o.merged === true ? "merged" : "done";

/** An ask's state, from its orders: any still under way, else the furthest any got; none yet is waiting. */
export const askState = (orders: readonly AskedOrder[]): AskState => {
  const states = orders.map(orderState);
  return (["working", "merged", "done", "stopped"] as const).find((s) => states.includes(s)) ?? "waiting";
};

// What a lead says before the person's words when it passes them on ("From the person, relayed by their lead (their
// words: "…"): …"): every ask would open the same way, so the summary starts after it.
const RELAYED = /^from (?:the person|your person|[^\s,:]+),? (?:relayed|passed on|forwarded) by (?:their|the|your) lead\s*(?:\((?:in )?their words:\s*|:\s*)?/iu;

/** The ask in a line: its first line, past a relay preamble; one that quotes the person, their quoted words. The row
 * clamps it to two lines. */
export const askSummary = (text: string): string => {
  const first = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const rest = first.replace(RELAYED, "");
  const quoted = rest === first ? undefined : /^["“](.+?)["”]/u.exec(rest)?.[1];
  const words = (quoted ?? rest).trim();
  if (words === "") return first;
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export interface AskRow {
  readonly ask: Ask;
  readonly summary: string;
  readonly state: AskState;
  /** Its lead took it into an order opened for an earlier ask, rather than one of its own. */
  readonly folded: boolean;
}

/** The asks as rows, newest first as the hub lists them. */
export const askRows = (asks: readonly Ask[]): AskRow[] =>
  asks.map((ask, i) => {
    // Listed newest first: an earlier ask comes after it.
    const earlier = new Set(asks.slice(i + 1).flatMap((a) => a.orders.map((o) => o.workstreamId)));
    return {
      ask,
      summary: askSummary(ask.text),
      state: askState(ask.orders),
      folded: ask.orders.length > 0 && ask.orders.every((o) => earlier.has(o.workstreamId)),
    };
  });
