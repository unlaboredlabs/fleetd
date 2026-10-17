// The human digest's lines for advise-only retro proposals. Pure.
import type { RetroProposal } from "@fleetd/contracts";

const SHOWN = 3;

/** Newest first in, at most three lines out, plus how to turn them on. */
export const suggestedLines = (suggested: ReadonlyArray<RetroProposal>): ReadonlyArray<string> => {
  if (suggested.length === 0) return [];
  const lines = suggested.slice(0, SHOWN).map((p) => {
    const aim = p.metric.class === "agent_minutes_per_done" ? "agent-minutes per done workstream" : `${p.metric.class} incidents`;
    return `Suggested ${p.proposalId}: ${p.playbook} ${p.kind} (${p.fields.join(", ")}) · fixes ${p.fixesIncidents.join(", ")} · aims to cut ${aim} over ${p.metric.windowDays} d`;
  });
  const more = suggested.length > SHOWN ? ` (+${suggested.length - SHOWN} more)` : "";
  return [...lines, `Retro suggestions${more} apply only once policy.retro.apply = true; retro_proposals has the diffs.`];
};
