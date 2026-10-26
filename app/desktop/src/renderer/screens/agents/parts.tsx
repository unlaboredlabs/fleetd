// The agents' small parts, shared by the list and one agent's head: the state dot, the role pill and where the work
// is. Kept here until another screen wants them.
import type { AgentRole, AgentRow } from "../../../shared/contracts";
import { cx, ROLE_WORD, roleTint, Truncate } from "../../ui";
import { MiddleCut } from "../live/parts";
import { agentState, STATE_WORD, workPlace } from "./model";
import s from "./agents.module.css";

/** The agent's state as a dot: working breathes as it starts (still when motion is reduced), waiting is amber, failed is danger. */
export function StateDot({ status }: { status: AgentRow["status"] }) {
  return <span className={s.state} data-state={agentState(status)} role="img" aria-label={STATE_WORD[status]} />;
}

/** The role's word in its tint on a faint wash of it. */
export function RolePill({ role }: { role: AgentRole }) {
  return (
    <span className={s.pill} style={{ color: roleTint(role) }}>
      {ROLE_WORD[role]}
    </span>
  );
}

/** Its PR with the train's word for it, or its branch in mono; nothing when it has neither yet. */
export function WorkPlaceTag({ row }: { row: Pick<AgentRow, "pr" | "branch"> }) {
  const place = workPlace(row);
  if (place === undefined) return null;
  if (place.kind === "branch") {
    return (
      // As wide as the branch in mono, up to its share of the line: a long one is cut in the middle.
      <span className={s.branch} style={{ flexBasis: `${String(place.text.length + 1)}ch` }}>
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
