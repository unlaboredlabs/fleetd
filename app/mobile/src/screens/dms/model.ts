// A project's DMs between agents on the phone (W533), kept pure: agent_messages' shapes, a DM's route (who to whom),
// its opening words, what became of it for each recipient (delivered at its next step, held for its next run, woke
// it to answer what it asked, didn't wake it, or not sent), and the events that change the log. Read-only: the hub keeps every
// DM as it was sent, and nobody edits or deletes one.
import type { AgentMessage, AgentMessageOutcome, AgentMessageRecipient, AgentMessagesOutput, HubEvent, HubState, ProjectRef } from "../../desktop";

/** The hub keeps agents' DMs (`agent_messages`), as the desktop checks. */
export const DMS_FEATURE = "agent_messages";
export const dmsShown = (hub: HubState): boolean => hub.phase === "live" && hub.features?.includes(DMS_FEATURE) === true;

/**
 * What became of a DM for one recipient: taken in at its next step (`delivered`), kept for its first run (`held`),
 * continued its run as the answer to what it asked (`woke`), kept because an agent can't restart a finished one
 * (`not_woken`), or not sent at all (`refused`). A word a newer hub adds shows as it names it.
 */
export type DmOutcome = AgentMessageOutcome | (string & {});

export type { AgentMessage };
export type DmReceipt = AgentMessageRecipient;

/** agent_messages' answer: a page, newest first; `more` when older ones are left, `total` the project's whole count. */
export type DmPage = Pick<AgentMessagesOutput, "messages" | "more" | "total">;

/** The most DMs one read brings. */
export const DM_PAGE = 50;

/** Who to whom: "T2573 → T2577, T2580". */
export const route = (m: Pick<AgentMessage, "from" | "to">): string => `${m.from.taskId} → ${m.to.map((r) => r.taskId).join(", ")}`;

/** Its opening words on one line: the row cuts them at two. */
export const opening = (text: string): string => text.replace(/\s+/gu, " ").trim().slice(0, 300);

/** What became of it for one recipient, in a word or three. */
export const outcomeWord = (outcome: DmOutcome): string => {
  switch (outcome) {
    case "delivered":
      return "Delivered";
    case "held":
      return "Held";
    case "woke":
      return "Woke it";
    case "not_woken":
      return "Didn't wake it";
    case "refused":
      return "Not sent";
    default:
      return outcome.length === 0 ? "Sent" : `${outcome.charAt(0).toUpperCase()}${outcome.slice(1).replace(/_/gu, " ")}`;
  }
};

/** The same, for several recipients that fared alike. */
const outcomeWords = (outcome: DmOutcome, n: number): string => (n === 1 ? outcomeWord(outcome) : outcome === "woke" ? "Woke them" : outcome === "not_woken" ? "Didn't wake them" : outcomeWord(outcome));

/** Its row's last line: one outcome for all, or each with whom it was for ("Delivered to T2577 · Didn't wake T2567"). */
export const rowOutcome = (m: Pick<AgentMessage, "to">): string => {
  const groups: { outcome: DmOutcome; ids: string[] }[] = [];
  for (const r of m.to) {
    const g = groups.find((x) => x.outcome === r.outcome);
    if (g === undefined) groups.push({ outcome: r.outcome, ids: [r.taskId] });
    else g.ids.push(r.taskId);
  }
  if (groups.length <= 1) return groups[0] === undefined ? "Sent" : outcomeWords(groups[0].outcome, groups[0].ids.length);
  return groups
    .map(({ outcome, ids }) => {
      const who = ids.join(", ");
      if (outcome === "woke") return `Woke ${who}`;
      if (outcome === "not_woken") return `Didn't wake ${who}`;
      if (outcome === "refused") return `Not sent to ${who}`;
      if (outcome === "held") return `Held for ${who}`;
      return `${outcomeWord(outcome)} to ${who}`;
    })
    .join(" · ");
};

/** The glyph its outcome shows with: a quiet mark, never a badge. */
export type DmGlyph = "delivered" | "held" | "woke" | "notWoken" | "refused";
export const glyphOf = (m: Pick<AgentMessage, "to">): DmGlyph => {
  const all = m.to.map((r) => r.outcome);
  if (all.includes("refused")) return "refused";
  if (all.includes("not_woken")) return "notWoken";
  if (all.includes("held")) return "held";
  if (all.includes("woke")) return "woke";
  return "delivered";
};

/** For VoiceOver: a row read out as a sentence. */
export const rowLabel = (m: AgentMessage, when: string): string => `From ${m.from.taskId} to ${m.to.map((r) => r.taskId).join(", ")}, ${when}. ${sentence(opening(m.text))} ${rowOutcome(m)}.`;

/** Words ending as a sentence does, once. */
const sentence = (s: string): string => (/[.!?…]$/u.test(s) ? s : `${s}.`);

/** The Info row's count: the project's DMs, once read. */
export const countValue = (total: number | undefined): string | undefined => (total === undefined || total === 0 ? undefined : String(total));

/** A DM sent (`agent.messaged`), or a recipient's outcome changed (`agent.message_updated`), in this project. */
export const touchesDms = (event: HubEvent, p: ProjectRef): boolean => {
  if (event.type !== "agent.messaged" && event.type !== "agent.message_updated") return false;
  return event.projectId === p.projectId && (event.machineId === undefined || event.machineId === p.machineId);
};

/** Pages read so far, joined, a DM that is on two pages (a new one pushed the rest down) kept once. */
export const joinPages = (shown: readonly AgentMessage[], older: readonly AgentMessage[]): AgentMessage[] => {
  const ids = new Set(shown.map((m) => m.id));
  return [...shown, ...older.filter((m) => !ids.has(m.id))];
};

/** The log as shown: every DM read so far, newest first, and whether older ones are left. */
export interface DmLog {
  readonly messages: readonly AgentMessage[];
  readonly more: boolean;
}

/**
 * A fresh newest page (a DM sent, a receipt) over the whole log as shown: the rows it holds take their new outcomes, a
 * new DM goes on top, and every row read before stays where it was, so the list never jumps or loses a row under the
 * person's thumb. The first read is the log.
 */
export const withNewest = (shown: DmLog | null, page: DmLog): DmLog => (shown === null ? { messages: page.messages, more: page.more } : { messages: joinPages(page.messages, shown.messages), more: shown.more });

/** An older page, read from before the oldest shown, under the log. */
export const withOlder = (shown: DmLog, page: DmLog): DmLog => ({ messages: joinPages(shown.messages, page.messages), more: page.more });
