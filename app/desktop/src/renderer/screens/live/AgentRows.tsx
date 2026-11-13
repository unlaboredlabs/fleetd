// The agents at work, a row each (chat/Island.tsx opens them in its card): a dot (at work in their role's tint, waiting
// on you in the attention color, queued hollow), the role, the task and what it is doing now; each row opens the agent
// in the panel's agents, where its live work and steer box are. Over the rows, the PRs they are on and a way to the
// panel's list.
import { RoleTag, Text, Truncate, cx, roleTint } from "../../ui";
import { panelRoute, toHash } from "../shell/routes";
import { ActivityLine } from "./parts";
import { type ProjectRef, type Strip, stripPrs } from "./strip";
import s from "./live.module.css";

const agentHref = (project: ProjectRef, laneId: string | null): string => toHash(panelRoute(project, { tab: "agents", agent: laneId }));

/** The agents a row each, opened in the island's card: the PRs they are on, a way to the panel's list, and a row per agent. */
export function Lanes({ id, project, strip, onOpened }: { id: string; project: ProjectRef; strip: Strip; onOpened: () => void }) {
  const prs = stripPrs(strip.prs);
  return (
    <div id={id} className={s.lanes}>
      <div className={s.lanesHead}>
        <Text size="xs" tone="quiet">
          {prs.length === 0
            ? "Agents"
            : prs.map((part, i) => {
                if (typeof part === "string") return part;
                const href = toHash(panelRoute(project, { tab: "prs", pr: { repo: null, number: part } }));
                return (
                  <a key={i} className={s.pr} href={href} onClick={onOpened}>
                    #{part}
                  </a>
                );
              })}
        </Text>
        <a className={s.all} href={agentHref(project, null)} onClick={onOpened}>
          <Text size="xs" tone="inherit">
            Open in the panel
          </Text>
        </a>
      </div>
      <ul className={s.list} aria-label="Agents at work">
        {strip.lanes.map((a) => (
          <li key={a.laneId}>
            <a className={s.lane} href={agentHref(project, a.laneId)} onClick={onOpened}>
              <span className={cx(s.dot, s[a.state])} style={a.state === "working" ? { color: roleTint(a.role) } : undefined} aria-hidden />
              <RoleTag role={a.role} width={64} inRow />
              <span className={s.title}>
                <Truncate expand="none" size="sm" tone="inherit">
                  {a.title}
                </Truncate>
              </span>
              <ActivityLine line={a.line} />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
