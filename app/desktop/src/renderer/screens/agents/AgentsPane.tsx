// The panel's agents: the project's agents at work, or with All projects every project's under its name, one calm row
// each (role, what it is doing, for how long), those waiting on you first; a row opens that agent's live work in their place, read-only. The rows come from the data
// layer (agents_list, refetched on events, merged with the live feed), so nothing here polls; the clocks tick once a
// second and only for the rows on screen. Under the project's own agents, Elsewhere: the work on its repo and base
// that isn't theirs (work_list, refetched on work, task and change events), read-only.
import { memo, useEffect, useMemo, useState } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { selectLiveAgents, selectProjects, type LiveAgent } from "../../src/data/selectors";
import { Button, Dot, EmptyState, IdChip, PROFILE_WORD, RoleTag, Text, Truncate, VirtualList, cx } from "../../ui";
import { ActivityLine } from "../live/parts";
import { describe, isRunning } from "../live/words";
import { fmtElapsed, parseMs } from "../live/format";
import { useNow } from "../live/clock";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { AgentWork } from "./AgentWork";
import { allAgents, elsewhere, headline, nextExpiry, projectAgents, type ElsewhereRow, type ProjectLine } from "./model";
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

/** The Elsewhere group's line, above its rows: the base they are on. */
interface ElsewhereLine {
  readonly elsewhere: string;
}

type Item = ProjectLine | LiveAgent | ElsewhereLine | { readonly row: ElsewhereRow; readonly other: true };

const keyOf = (item: Item): string =>
  "elsewhere" in item ? "elsewhere" : "other" in item ? `elsewhere:${item.row.id}` : isLine(item) ? `project:${item.group}` : item.id;

/**
 * The project's Elsewhere rows, read with This project only; none until read, and none when the hub can't say (an
 * older hub, or a project whose repo it doesn't know): the agents above are the point, so a failed read stays quiet.
 * Read from the hub alone (`paths: false`): the rows show no files, so no machine is asked what its writers changed.
 * Read again when the soonest claim shown expires, as a renewal sends no event.
 */
function useElsewhere(project: ProjectKey, enabled: boolean): { base: string; rows: readonly ElsewhereRow[] } | undefined {
  const query = useToolQuery("work_list", { projectRef: { machineId: project.machineId, projectId: project.projectId }, paths: false }, { enabled });
  const { data, refetch } = query;
  useEffect(() => {
    if (!enabled || data === undefined) return undefined;
    const at = nextExpiry(data, Date.now());
    if (at === undefined) return undefined;
    // A second after, so the hub's sweep has had its chance; capped at what setTimeout holds.
    const timer = window.setTimeout(() => void refetch(), Math.min(at - Date.now() + 1_000, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [enabled, data, refetch]);
  const projects = useData(selectProjects);
  const key = projectKey(project);
  // "expires in 9 h" and "2 h ago" move by the minute, and only while the group is read.
  const now = useNow(enabled, 60_000);
  return useMemo(() => {
    if (!enabled || query.data === undefined) return undefined;
    const titles = new Map((projects ?? []).map((p) => [projectKey(p), p.title]));
    return { base: query.data.scope.base, rows: elsewhere(query.data, key, now, (k) => titles.get(k)) };
  }, [enabled, query.data, projects, key, now]);
}

/** The agents of `scope`, or (`agent`, a lane) one agent's work. */
export function AgentsPane({ project, agent, scope, onScope }: { project: ProjectKey; agent: string | null; scope: AgentScope; onScope: (next: AgentScope) => void }) {
  const key = projectKey(project);
  if (agent !== null) return <AgentWork key={agent} id={`${key}/${agent}`} />;
  return <AgentList project={project} scope={scope} onScope={onScope} />;
}

function AgentList({ project: ref, scope, onScope }: { project: ProjectKey; scope: AgentScope; onScope: (next: AgentScope) => void }) {
  const project = projectKey(ref);
  const fresh = useData((st) => st.fresh);
  const query = useToolQuery("agents_list", ALL);
  const all = useData(selectLiveAgents);
  const agents = useMemo(() => (all === undefined ? undefined : scopedAgents(all, project, scope)), [all, project, scope]);
  const other = useElsewhere(ref, scope === "project");
  const items = useMemo((): readonly Item[] | undefined => {
    if (agents === undefined || other === undefined || other.rows.length === 0) return agents;
    return [...agents, { elsewhere: `Elsewhere on ${other.base}` }, ...other.rows.map((row) => ({ row, other: true as const }))];
  }, [agents, other]);
  const head = agents === undefined ? "" : headline(agents.filter((a): a is LiveAgent => !isLine(a)));

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
          {agents?.length === 0 ? (
            <div className={s.none}>
              <Text size="sm" tone="quiet">
                No agents are working here.
              </Text>
            </div>
          ) : null}
          <VirtualList
            items={items}
            getKey={keyOf}
            renderItem={(a) =>
              "elsewhere" in a ? (
                <ProjectLineRow line={{ group: "elsewhere", title: a.elsewhere }} />
              ) : "other" in a ? (
                <ElsewhereRowView row={a.row} />
              ) : isLine(a) ? (
                <ProjectLineRow line={a} />
              ) : (
                <AgentRowLink agent={a} />
              )
            }
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

/**
 * Work elsewhere, laid out as an agent's row: what it is where the role is, its title, and under it who holds it and
 * until when, whose it is, or how it landed, and a landing's commit to copy. Not a link: none of it is this project's
 * to open.
 */
function ElsewhereRowView({ row }: { row: ElsewhereRow }) {
  return (
    <div className={cx(s.row, s.other, row.dim && s.dim)} data-elsewhere={row.id}>
      <span className={s.line}>
        <span className={s.tag}>
          <Truncate size="xs" tone="quiet" expand="none">
            {row.tag}
          </Truncate>
        </span>
        <span className={s.task}>
          <Truncate size="sm" expand="none">
            {row.title}
          </Truncate>
        </span>
        {row.sha === undefined ? null : <IdChip label="Commit" id={row.sha} kind="commit" size="xs" tone="quiet" />}
      </span>
      <span className={s.doing}>
        <Truncate size="xs" tone="quiet" expand="none">
          {row.meta}
        </Truncate>
      </span>
    </div>
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
