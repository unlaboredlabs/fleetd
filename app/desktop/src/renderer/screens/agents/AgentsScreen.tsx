// Agents: every agent at work across the projects, one calm row each under its project (role, what it is doing, for
// how long), and beside the list the opened agent's live work, read-only. The rows come from the data layer
// (agents_list, refetched on events, merged with the live feed), so nothing here polls; the clocks tick once a second
// and only for the rows on screen.
import { memo, useMemo } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { selectLiveAgents, type LiveAgent } from "../../src/data/selectors";
import { Button, cx, Dot, EmptyState, RoleTag, Text, Truncate, VirtualList } from "../../ui";
import { ActivityLine } from "../live/parts";
import { describe, isRunning } from "../live/words";
import { fmtElapsed, parseMs } from "../live/format";
import { useNow } from "../live/clock";
import { agentId, toHash, type AgentKey } from "../shell/routes";
import { AgentWork } from "./AgentWork";
import { headline, listItems, type ListItem } from "./model";
import s from "./agents.module.css";

const ALL = {} as const;

export function AgentsScreen({ agent }: { agent: AgentKey | null }) {
  const fresh = useData((st) => st.fresh);
  const query = useToolQuery("agents_list", ALL);
  const agents = useData(selectLiveAgents);
  const items = useMemo(() => (agents === undefined ? undefined : listItems(agents)), [agents]);
  const open = agent === null ? null : agentId(agent);

  return (
    <div className={s.screen} data-screen={agent === null ? "agents" : "agents.work"}>
      <header className={s.header}>
        <span className={s.title}>
          <Text strong>Agents</Text>
          {agents !== undefined && agents.length > 0 ? (
            <Text size="xs" tone="quiet">
              {headline(agents)}
            </Text>
          ) : null}
        </span>
        {!fresh ? (
          <span className={s.liveness} role="status">
            <Dot color="var(--warning)" />
            <Text size="xs">Not live: reconnecting</Text>
          </span>
        ) : query.isError ? (
          <span className={s.liveness} role="alert">
            <Dot color="var(--warning)" />
            <Text size="xs">Couldn’t read the agents</Text>
            <Button variant="quiet" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </span>
        ) : null}
      </header>
      {items === undefined ? (
        <div className={s.split}>
          <Skeleton busy={fresh} />
          <div className={s.work} />
        </div>
      ) : items.length === 0 && open === null ? (
        <EmptyState title="No agents are working">When a lead starts agents, they show here, with what each is doing.</EmptyState>
      ) : (
        <div className={s.split}>
          <div className={s.list}>
            <VirtualList
              items={items}
              getKey={(item) => (item.kind === "project" ? `p:${item.key}` : item.agent.id)}
              renderItem={(item) => <Item item={item} open={open} />}
              estimateSize={44}
              aria-label="Agents"
            />
          </div>
          <div className={s.work}>
            {open === null ? (
              <EmptyState title="Pick an agent">Its work shows here as it happens. Reading it doesn’t interrupt it.</EmptyState>
            ) : (
              <AgentWork key={open} id={open} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const Item = ({ item, open }: { item: ListItem; open: string | null }) =>
  item.kind === "project" ? (
    <div className={s.group}>
      <span className={s.task}>
        <Truncate size="xs" tone="quiet" strong expand="none">
          {item.title}
        </Truncate>
      </span>
      <Text size="xs" tone="faint" tabular>
        {String(item.count)}
      </Text>
    </div>
  ) : (
    <AgentRowLink agent={item.agent} current={item.agent.id === open} />
  );

/** Role, the task, how long; under it what it is doing now. A link, so it opens with the keyboard and keeps history. */
const AgentRowLink = memo(function AgentRowLink({ agent, current }: { agent: LiveAgent; current: boolean }) {
  const { row } = agent;
  const href = toHash({ id: "agents", agent: { machineId: row.projectRef.machineId, projectId: row.projectRef.projectId, laneId: row.laneId } });
  return (
    <a className={cx(s.row, current && s.current)} href={href} {...(current ? { "aria-current": "page" as const } : {})}>
      <span className={s.line}>
        <RoleTag role={row.role} width={88} inRow />
        <span className={s.task}>
          <Truncate size="sm" expand="none">
            {row.title}
          </Truncate>
        </span>
        <Elapsed startedAt={row.startedAt} running={isRunning(row.status)} />
      </span>
      <span className={s.doing}>
        <ActivityLine line={describe(row)} />
      </span>
    </a>
  );
});

/** How long it has run, ticking once a second while it does; nothing before it started. */
export function Elapsed({ startedAt, running }: { startedAt: string | undefined; running: boolean }) {
  const now = useNow(running);
  const start = parseMs(startedAt);
  if (start === undefined || !running) return null;
  return (
    <Text size="xs" tone="quiet" tabular>
      {fmtElapsed(now - start)}
    </Text>
  );
}

/** Row outlines, no shimmer. Busy only while an answer is on its way, not while the hub is out of reach. */
function Skeleton({ busy }: { busy: boolean }) {
  return (
    <div className={s.skeleton} aria-busy={busy} aria-label="Loading agents">
      <span />
      <span />
      <span />
    </div>
  );
}
