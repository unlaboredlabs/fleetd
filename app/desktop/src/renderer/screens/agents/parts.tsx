// The agents' small parts, shared by the list and one agent's head: the state dot, the role pill and where the work
// is. Kept here until another screen wants them.
import type { CSSProperties } from "react";
import type { AgentRole, AgentRow } from "../../../shared/contracts";
import { cx, ROLE_WORD, roleTint, StateGlyph, Truncate, type GlyphState } from "../../ui";
import { MiddleCut } from "../live/parts";
import { agentState, STATE_WORD, workPlace } from "./model";
import s from "./agents.module.css";

/** The glyph for a lane's status; a working lane with nothing to show yet is thinking. */
export const glyphOf = (status: AgentRow["status"], thinking = false): GlyphState => {
  if (status === "parked") return "paused";
  const state = agentState(status);
  return state === "working" && thinking ? "thinking" : state;
};

/**
 * The agent's state as a 3×3 dither glyph (StateGlyph): working is grain, thinking walks its ring, the rest hold a
 * shape of their own, and it morphs as the state changes; `still` for a count, where only the shape speaks.
 */
export function StateDot({ status, thinking = false, still = false, seed }: { status: AgentRow["status"]; thinking?: boolean; still?: boolean; seed?: string }) {
  // Seeded by the agent, each glyph keeps its own place in the rhythm: a list of them never beats as one.
  let hash = 7;
  for (let i = 0; i < (seed?.length ?? 0); i++) hash = (hash * 31 + (seed?.charCodeAt(i) ?? 0)) % 997;
  const phase = hash / 997;
  return (
    <span className={cx(s.state, still && s.stillGlyph)} data-state={agentState(status)} style={{ "--glyph-phase": phase } as CSSProperties}>
      <StateGlyph state={glyphOf(status, thinking)} label={thinking && agentState(status) === "working" ? "thinking" : STATE_WORD[status]} />
    </span>
  );
}

/** The role's word in its tint on a faint wash of it. */
export function RolePill({ role }: { role: AgentRole }) {
  return (
    <span className={s.pill} style={{ color: roleTint(role) }}>
      {ROLE_WORD[role]}
    </span>
  );
}

/** Its PR with the train's word for it, or its branch in mono (its task id in the tooltip); nothing when it has neither yet. */
export function WorkPlaceTag({ row }: { row: Pick<AgentRow, "pr" | "branch"> }) {
  const place = workPlace(row);
  if (place === undefined) return null;
  if (place.kind === "branch") {
    return (
      // As wide as the branch in mono, up to its share of the line: a long one is cut in the middle.
      <span className={s.branch} style={{ flexBasis: `${String(place.text.length + 1)}ch` }} title={place.full}>
        <MiddleCut text={place.text} />
      </span>
    );
  }
  return (
    <span className={cx(s.place, place.tone === "danger" && s.failed, place.tone === "success" && s.merged)}>
      <Truncate size="xs" tone="inherit" expand="none">
        {place.state === undefined ? place.text : `${place.text} · ${place.state}`}
      </Truncate>
    </span>
  );
}
