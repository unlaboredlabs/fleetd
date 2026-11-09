// Agent DMs as the person sees and audits them, pure: what became of a DM for each recipient in words (a card's
// receipt line, the log's receipts, a row's state), which of an agent's DMs it sent or got, and where they stand in
// its work by time. A DM goes from one agent to one to five others; each recipient has its own outcome. Nobody edits
// or deletes one: they are the log.

import type { AgentMessage, AgentMessageOutcome, AgentMessageRecipient } from "../../../shared/contracts";

export type { AgentMessage };
/**
 * Where a DM stands for one recipient: `delivered` (it takes it at its next step; `at` once it did), `held` (it isn't
 * running: kept for its next run), `woke` (it was waiting for this answer, and this continued it), `not_woken` (the
 * guard: it has finished and wasn't waiting on the sender, so it is held, not started), `refused` (not sent).
 */
export type Outcome = AgentMessageOutcome;
export type AgentMessageTo = AgentMessageRecipient;

/** `at`, or the empty string: the times a receipt prints. */
const clock = (at: string | undefined, fmt: (iso: string) => string): string => (at === undefined ? "" : fmt(at));

/** "T2567 has finished and isn’t waiting on T2584" without a closing full stop, so a sentence can go on after it. */
const clause = (detail: string | undefined): string | undefined => {
  const d = detail?.trim().replace(/[.\s]+$/u, "");
  return d === undefined || d === "" ? undefined : d;
};

/**
 * Why the guard didn't wake `t`, as one plain clause about it: the hub's first clause ("T2567 has finished and isn't
 * waiting on T2584"), with the recipient as "it". What follows the hub's colon (how it gets the DM later) is what
 * "Held for its next run" says.
 */
const guardWhy = (t: AgentMessageTo): string | undefined => {
  const first = clause(t.detail?.split(": ")[0]);
  return first?.startsWith(`${t.taskId} `) === true ? `it ${first.slice(t.taskId.length + 1)}` : first;
};

/** The recipient the guard didn't wake: it had finished and wasn't waiting on the sender. */
export const notWoken = (m: AgentMessage): AgentMessageTo | undefined => m.to.find((t) => t.outcome === "not_woken");

/**
 * A card's receipt on the agent's thread, for one recipient: how it reached it, or why not. `received` words it from
 * the recipient's side ("Read at its next step, 23:02"), else from the sender's ("Delivered at its next step").
 */
export function cardReceipt(t: AgentMessageTo, received: boolean, fmt: (iso: string) => string): string {
  const at = clock(t.at, fmt);
  const why = clause(t.detail);
  switch (t.outcome) {
    case "delivered":
      if (at === "") return received ? "Reads it at its next step." : "Goes in at its next step.";
      return `${received ? "Read at its next step" : "Delivered at its next step"}, ${at}.`;
    case "held":
      return `Held: ${why ?? "it isn’t running, and reads this when it runs again"}.`;
    case "woke":
      return `Woke it${at === "" ? "" : `, ${at}`}${why === undefined ? "" : `: ${why}`}.`;
    case "not_woken": {
      const no = guardWhy(t);
      return `Didn’t wake ${t.taskId}${no === undefined ? "" : `: ${no}`}. Held for its next run.`;
    }
    case "refused":
      return `Not sent${why === undefined ? "" : `: ${why}`}.`;
  }
}

/** A receipt in the log, for one recipient: what it did with the DM, in a few words after its id. */
export function logReceipt(t: AgentMessageTo): string {
  const why = clause(t.detail);
  switch (t.outcome) {
    case "delivered":
      return t.at === undefined ? "gets it at its next step" : "read it at its next step";
    case "held":
      return why === undefined ? "isn’t running: held for its next run" : `held: ${why}`;
    case "woke":
      return why === undefined ? "was woken" : `was woken: ${why}`;
    case "not_woken": {
      const no = guardWhy(t);
      return `wasn’t woken${no === undefined ? "" : `: ${no}`}. Held for its next run`;
    }
    case "refused":
      return `not sent${why === undefined ? "" : `: ${why}`}`;
  }
}

/**
 * A log row's state: "delivered", "held", "woke T2577", "didn’t wake T2567", "not sent", or for several "2 delivered,
 * 1 held". What the person would want to know first (the guard, a failure, a wake) says it alone, strongly.
 */
export function rowState(m: AgentMessage): { readonly text: string; readonly strong: boolean } {
  const no = notWoken(m);
  if (no !== undefined) return { text: `didn’t wake ${no.taskId}`, strong: true };
  const failed = m.to.find((t) => t.outcome === "refused");
  if (failed !== undefined) return { text: m.to.length === 1 ? "not sent" : `not sent to ${failed.taskId}`, strong: true };
  const woke = m.to.find((t) => t.outcome === "woke");
  if (woke !== undefined) return { text: `woke ${woke.taskId}`, strong: true };
  const held = m.to.filter((t) => t.outcome === "held").length;
  const got = m.to.length - held;
  if (m.to.length === 1) return { text: held === 1 ? "held" : "delivered", strong: false };
  return { text: held === 0 ? `delivered to ${String(got)}` : got === 0 ? `held for ${String(held)}` : `${String(got)} delivered, ${String(held)} held`, strong: false };
}

/** "T2573 → T2577, T2576": who wrote to whom. */
export const route = (m: AgentMessage): string => `${m.from.taskId} → ${m.to.map((t) => t.taskId).join(", ")}`;

/** Its opening words on one line. */
export const opening = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** How `taskId` stands to a DM: it sent it, it got it, or neither. */
export const sideOf = (m: AgentMessage, taskId: string): "sent" | "received" | undefined =>
  m.from.taskId === taskId ? "sent" : m.to.some((t) => t.taskId === taskId) ? "received" : undefined;

/** When a DM shows in `taskId`'s work: when it went, for the sender; when it read it (or was woken), for a recipient. */
export const shownAt = (m: AgentMessage, taskId: string): string => (m.from.taskId === taskId ? m.sentAt : (m.to.find((t) => t.taskId === taskId)?.at ?? m.sentAt));

/** A DM as its recipient was given it: it opens with the DM's id, "M12 · T2573 (…) writes to you". */
const DM_HEAD = /^\s*(M\d+) · T\d+ /u;

/**
 * A step of the agent's work without what a DM card stands for: the `agent_message` call that sent one is dropped, and
 * so is a message a recipient was given, which is the DM alone. A run that carries held DMs gets them in front of what
 * else it was told ("{DM}\n\n{the lead's words}"): that step keeps the rest. Undefined when nothing is left.
 */
export function withoutDm<S extends { readonly kind: string }>(step: S, received: ReadonlySet<string>): S | undefined {
  const s = step as S & { readonly role?: string; readonly text?: string; readonly action?: { readonly summary: string } };
  if (s.kind === "action") return /(?:^|__|\s)agent_message\b/u.test(s.action?.summary ?? "") ? undefined : step;
  if (s.kind !== "message" || s.role !== "user" || s.text === undefined) return step;
  const blocks = s.text.split(/\n{2,}/u);
  const rest = blocks.filter((b) => {
    const id = DM_HEAD.exec(b)?.[1];
    return id === undefined || !received.has(id);
  });
  if (rest.length === blocks.length) return step;
  return rest.length === 0 ? undefined : { ...step, text: rest.join("\n\n") };
}

/**
 * `steps` (oldest first) with `dms` set among them by time, each where it happened for `taskId`, and without the steps
 * the cards stand for. Steps keep their order; a card goes before the first step later than it.
 */
export function withDms<S extends { readonly at: string; readonly kind: string }>(
  steps: readonly S[],
  dms: readonly AgentMessage[] | undefined,
  taskId: string,
): readonly (S | { readonly kind: "dm"; readonly id: string; readonly dm: AgentMessage })[] {
  // Only what happened within the steps on view: older DMs are in Activity's log.
  const first = steps[0] === undefined ? -Infinity : Date.parse(steps[0].at);
  const mine = (dms ?? []).filter((m) => sideOf(m, taskId) !== undefined && Date.parse(shownAt(m, taskId)) >= first);
  if (mine.length === 0) return steps;
  const received = new Set(mine.filter((m) => m.from.taskId !== taskId).map((m) => m.id));
  const cards = mine
    .map((dm) => ({ kind: "dm" as const, id: `dm:${dm.id}`, dm, ms: Date.parse(shownAt(dm, taskId)) }))
    .sort((a, b) => a.ms - b.ms);
  const out: (S | { readonly kind: "dm"; readonly id: string; readonly dm: AgentMessage })[] = [];
  let i = 0;
  for (const step of steps) {
    const ms = Date.parse(step.at);
    while (i < cards.length && (cards[i]?.ms ?? 0) <= ms) {
      const { ms: _, ...card } = cards[i] as (typeof cards)[number];
      out.push(card);
      i++;
    }
    const kept = withoutDm(step, received);
    if (kept !== undefined) out.push(kept);
  }
  for (; i < cards.length; i++) {
    const { ms: _, ...card } = cards[i] as (typeof cards)[number];
    out.push(card);
  }
  return out;
}

/** "8 DMs between agents", or nothing when there are none. */
export const countWords = (total: number | undefined): string | undefined =>
  total === undefined || total <= 0 ? undefined : `${total.toLocaleString("en-US")} ${total === 1 ? "DM" : "DMs"} between agents`;
