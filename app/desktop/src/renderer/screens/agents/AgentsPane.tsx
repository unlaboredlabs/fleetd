// The panel's agents: the project's agents at work, or with All projects every project's under its name, one calm row
// each (role, what it is doing, for how long), those waiting on you first; a row opens that agent's live work in their place, read-only. The rows come from the data
// layer (agents_list, refetched on events, merged with the live feed), so nothing here polls; the clocks tick once a
// second and only for the rows on screen.
import { memo, useEffect, useMemo, useState } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { selectLiveAgents, type LiveAgent } from "../../src/data/selectors";
import { Button, Dot, EmptyState, PROFILE_WORD, RoleTag, Text, Truncate, VirtualList } from "../../ui";
import { ActivityLine } from "../live/parts";
import { describe, isRunning } from "../live/words";
import { fmtElapsed, parseMs } from "../live/format";
import { useNow } from "../live/clock";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { AgentWork } from "./AgentWork";
import { allAgents, headline, projectAgents, type ProjectLine } from "./model";
import s from "./agents.module.css";

const ALL = {} as const;

/** Whose agents the list shows: the project's beside its chat, or every project's. */
export type AgentScope = "project" | "all";

const SCOPE = "fleetd.panel.agents";

/** The list's scope, kept across launches as the panel's tab is. */
export function useAgentScope(): [AgentScope, (next: AgentScope) => void] {
  const [scope, setScope] = useState<AgentScope>(() => {
    try {
      return window.localStorage.getItem(SCOPE) === "all" ? "all" : "project";
    } catch {
      return "project";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(SCOPE, scope);
    } catch {
      // Without storage it starts on this project, as on a first launch.
    }
  }, [scope]);
  return [scope, setScope];
}

/** The agents `scope` lists, the leads not counted. */
export const scopedAgents = (agents: readonly LiveAgent[], project: string, scope: AgentScope): readonly (ProjectLine | LiveAgent)[] =>
  scope === "all" ? allAgents(agents) : projectAgents(agents, project);

export const isLine = (item: ProjectLine | LiveAgent): item is ProjectLine => "group" in item;

/** The agents of `scope`, or (`agent`, a lane) one agent's work. */
export function AgentsPane({ project, agent, scope, onScope }: { project: ProjectKey; agent: string | null; scope: AgentScope; onScope: (next: AgentScope) => void }) {
  const key = projectKey(project);
  if (agent !== null) return <AgentWork key={agent} id={`${key}/${agent}`} />;
  return <AgentList project={key} scope={scope} onScope={onScope} />;
}

function AgentList({ project, scope, onScope }: { project: string; scope: AgentScope; onScope: (next: AgentScope) => void }) {
  const fresh = useData((st) => st.fresh);
  const query = useToolQuery("agents_list", ALL);
  const all = useData(selectLiveAgents);
  const items = useMemo(() => (all === undefined ? undefined : scopedAgents(all, project, scope)), [all, project, scope]);
  const head = items === undefined ? "" : headline(items.filter((a): a is LiveAgent => !isLine(a)));

  return (
    <div className={s.pane} data-screen="agents">
      <div className={s.scope} role="group" aria-label="Whose agents">
        <Button variant={scope === "project" ? "secondary" : "quiet"} size="sm" aria-pressed={scope === "project"} onClick={() => onScope("project")}>
          This project
        </Button>
        <Button variant={scope === "all" ? "secondary" : "quiet"} size="sm" aria-pressed={scope === "all"} onClick={() => onScope("all")}>
          All projects
        </Button>
      </div>
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
      ) : head !== "" ? (
        <span className={s.liveness}>
          <Text size="xs" tone="quiet">
            {head}
          </Text>
        </span>
      ) : null}
      {items === undefined && !fresh ? (
        // Nothing held and no hub to ask: bars would read as loading that never ends.
        <div className={s.note}>
          <Text tone="quiet">Agents show once you’re connected.</Text>
        </div>
      ) : items === undefined ? (
        // A failed read says so above; the skeleton then waits for Retry, it doesn't claim to be loading.
        <Skeleton busy={!query.isError} />
      ) : items.length === 0 ? (
        <EmptyState title="No agents are working">When the lead starts agents, they show here, with what each is doing.</EmptyState>
      ) : (
        <div className={s.list}>
          <VirtualList
            items={items}
            getKey={(a) => (isLine(a) ? `project:${a.group}` : a.id)}
            renderItem={(a) => (isLine(a) ? <ProjectLineRow line={a} /> : <AgentRowLink agent={a} />)}
            estimateSize={44}
            aria-label="Agents"
          />
        </div>
      )}
    </div>
  );
}

/** A project's name above its agents. */
function ProjectLineRow({ line }: { line: ProjectLine }) {
  return (
    <span className={s.group}>
      <Truncate size="xs" tone="quiet" strong expand="none">
        {line.title}
      </Truncate>
    </span>
  );
}

/** Role, the task, how long; under it what it is doing now. A link, so it opens with the keyboard and keeps history. */
export const AgentRowLink = memo(function AgentRowLink({ agent }: { agent: LiveAgent }) {
  const { row } = agent;
  const href = toHash(panelRoute(row.projectRef, { tab: "agents", agent: row.laneId }));
  return (
    <a className={s.row} href={href}>
      <span className={s.line}>
        <RoleTag role={row.role} width={88} inRow />
        <span className={s.task}>
          <Truncate size="sm" expand="none">
            {row.title}
          </Truncate>
        </span>
        {row.profile === undefined ? null : (
          <Text size="xs" tone="quiet">
            {PROFILE_WORD[row.profile]}
          </Text>
        )}
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

/** Row outlines, no shimmer. Busy only while an answer is on its way. */
function Skeleton({ busy }: { busy: boolean }) {
  return (
    <div className={s.skeleton} aria-busy={busy} aria-label="Loading agents">
      <span />
      <span />
      <span />
    </div>
  );
}
