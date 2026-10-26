// The panel's agents: the project's agents at work under the orders they work on, or with All projects every
// project's under its name; one calm row each (its state as a dot, its title and role, and under them what it is doing
// now and where its work is), those waiting on you first. A row opens that agent's live work in their place,
// read-only. The rows come from the data layer (agents_list, refetched on events, merged with the live feed) and the
// orders' titles from the board, so nothing here polls. Under the project's own agents, folded, Also on this repo: the
// live work on its repo and base that isn't theirs (work_list, refetched on work, task and change events), read-only;
// nothing at all when there is none.
import { ChevronRight } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { selectLiveAgents, selectProjects, type LiveAgent } from "../../src/data/selectors";
import { Button, ContextMenu, ContextMenuCopy, ContextMenuItem, Dot, EmptyState, IdChip, PROFILE_WORD, Text, Truncate, VirtualList, cx, useArrived } from "../../ui";
import { ActivityLine } from "../live/parts";
import { steerNext } from "../live/Steer";
import { describe, isFinal } from "../live/words";
import { useNow } from "../live/clock";
import { useRoute } from "../shell/navigation";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { AgentWork } from "./AgentWork";
import { allAgents, alsoOnRepo, nextExpiry, onItsPr, projectGroups, tally, type ElsewhereRow, type GroupLine, type OrderTitle } from "./model";
import { RolePill, StateDot, WorkPlaceTag } from "./parts";
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

/** The agents `scope` lists under their orders (and with All projects, their projects), the leads not counted. */
export const scopedAgents = (agents: readonly LiveAgent[], project: string, scope: AgentScope, titleOf?: OrderTitle): readonly (GroupLine | LiveAgent)[] =>
  scope === "all" ? allAgents(agents, titleOf) : projectGroups(agents, project, titleOf);

export const isLine = (item: GroupLine | LiveAgent): item is GroupLine => "group" in item;

/** The Also on this repo line, above its rows: how many, and whether they show. */
interface ElsewhereLine {
  readonly elsewhere: string;
  readonly count: number;
}

type Item = GroupLine | LiveAgent | ElsewhereLine | { readonly row: ElsewhereRow; readonly other: true };

const keyOf = (item: Item): string => ("elsewhere" in item ? "elsewhere" : "other" in item ? `elsewhere:${item.row.id}` : isLine(item) ? item.group : item.id);

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
    return { base: query.data.scope.base, rows: alsoOnRepo(query.data, key, now, (k) => titles.get(k)) };
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
  const orders = useData((st) => st.orders);
  const agents = useMemo(() => {
    if (all === undefined) return undefined;
    const titleOf: OrderTitle = (id) => orders?.[id]?.title;
    return scopedAgents(all, project, scope, titleOf);
  }, [all, orders, project, scope]);
  const other = useElsewhere(ref, scope === "project");
  // Folded until asked for: the project's own agents are the point, the rest is context.
  const [unfolded, setUnfolded] = useState(false);
  const items = useMemo((): readonly Item[] | undefined => {
    if (agents === undefined || other === undefined || other.rows.length === 0) return agents;
    const line = { elsewhere: "Also on this repo", count: other.rows.length };
    return [...agents, line, ...(unfolded ? other.rows.map((row) => ({ row, other: true as const })) : [])];
  }, [agents, other, unfolded]);
  const counts = agents === undefined ? undefined : tally(agents.filter((a): a is LiveAgent => !isLine(a)));
  const none = agents?.every(isLine) === true;

  return (
    <div className={s.pane} data-screen="agents">
      <div className={s.top}>
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
        ) : counts !== undefined ? (
          <Counts counts={counts} />
        ) : null}
      </div>
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
          {none ? (
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
                <button type="button" className={s.fold} aria-expanded={unfolded} onClick={() => setUnfolded((u) => !u)}>
                  <ChevronRight aria-hidden className={s.foldIcon} />
                  <Text size="xs" tone="quiet" strong>
                    {a.elsewhere}
                  </Text>
                  <Text size="xs" tone="faint" tabular>
                    {String(a.count)}
                  </Text>
                </button>
              ) : "other" in a ? (
                <ElsewhereRowView row={a.row} />
              ) : isLine(a) ? (
                <GroupLineRow line={a} />
              ) : (
                <AgentRowLink agent={a} />
              )
            }
            estimateSize={52}
            aria-label="Agents"
          />
        </div>
      )}
    </div>
  );
}

/** What works, what waits on you and what is queued, each with its dot; nothing when none of the three. */
function Counts({ counts }: { counts: ReturnType<typeof tally> }) {
  const { working, waiting, queued } = counts;
  if (working + waiting + queued === 0) return null;
  return (
    <span className={s.counts}>
      {waiting > 0 ? (
        <span className={cx(s.count, s.countWaiting)}>
          <StateDot status="waiting" still />
          <Text size="xs" tone="inherit" strong tabular>{`${String(waiting)} ${waiting === 1 ? "needs" : "need"} you`}</Text>
        </span>
      ) : null}
      {working > 0 ? (
        <span className={s.count}>
          <StateDot status="working" still />
          <Text size="xs" tone="quiet" tabular>{`${String(working)} working`}</Text>
        </span>
      ) : null}
      {queued > 0 ? (
        <span className={s.count}>
          <StateDot status="queued" still />
          <Text size="xs" tone="quiet" tabular>{`${String(queued)} queued`}</Text>
        </span>
      ) : null}
    </span>
  );
}

/**
 * A project's name above its orders, or an order's title above its agents, with how many; an order's also says how
 * many need you (its project's would say it twice).
 */
function GroupLineRow({ line }: { line: GroupLine }) {
  return (
    <span className={cx(s.group, line.level === "project" && s.projectGroup)} data-group={line.level}>
      <span className={s.groupTitle}>
        <Truncate size={line.level === "project" ? "sm" : "xs"} tone={line.level === "project" ? "default" : "quiet"} strong expand="none">
          {line.title}
        </Truncate>
      </span>
      {line.level === "order" && line.waiting > 0 ? (
        <Text size="xs" tone="warning" tabular>
          {`${String(line.waiting)} ${line.waiting === 1 ? "needs" : "need"} you`}
        </Text>
      ) : null}
      {line.count > 0 ? (
        <Text size="xs" tone="faint" tabular>
          {String(line.count)}
        </Text>
      ) : null}
    </span>
  );
}

/**
 * Work elsewhere, laid out as an agent's row: its title with what it is where the role is, and under it who holds it
 * and until when, whose it is, or how it landed, and a landing's commit to copy. Not a link: none of it is this
 * project's to open.
 */
function ElsewhereRowView({ row }: { row: ElsewhereRow }) {
  return (
    <div className={cx(s.row, s.other, row.dim && s.dim)} data-elsewhere={row.id}>
      <span className={cx(s.state, s.otherMark)} aria-hidden />
      <span className={s.line}>
        <span className={s.task}>
          <Truncate size="sm" expand="none">
            {row.title}
          </Truncate>
        </span>
        {row.sha === undefined ? null : <IdChip label="Commit" id={row.sha} kind="commit" size="xs" tone="quiet" />}
        <span className={cx(s.pill, s.tag)}>{row.tag}</span>
      </span>
      <span className={s.doing}>
        <Truncate size="xs" tone="quiet" expand="none">
          {row.meta}
        </Truncate>
      </span>
    </div>
  );
}

/**
 * Its state as a dot, its title and role; under them what it is doing now and where its work is (its PR, or its
 * branch), left out on that PR's own page. Waiting on you, it stands out gently; a lead keeps its own tint. A link,
 * so it opens with the keyboard and keeps history. Its right-click menu opens it, opens it to steer while it runs (once
 * it has started), or copies its branch.
 */
export const AgentRowLink = memo(function AgentRowLink({ agent }: { agent: LiveAgent }) {
  const { row } = agent;
  const onPr = onItsPr(useRoute(), row);
  const href = toHash(panelRoute(row.projectRef, { tab: "agents", agent: row.laneId }));
  const { taskId, branch } = row;
  const line = describe(row);
  const fresh = useArrived("agents", agent.id);
  const menu = () => (
    <>
      <ContextMenuItem onSelect={() => (window.location.hash = href)}>Open</ContextMenuItem>
      {/* Only when its view shows a steer box (AgentWork's, once it has a thread): with none, the box's focus would
          wait for one and take the cursor whenever it showed. */}
      {taskId !== undefined && row.workstreamId !== undefined && row.threadRef !== undefined && !isFinal(row.status) ? (
        <ContextMenuItem
          onSelect={() => {
            steerNext(taskId);
            window.location.hash = href;
          }}
        >
          Steer
        </ContextMenuItem>
      ) : null}
      {branch !== undefined ? <ContextMenuCopy text={branch}>Copy branch</ContextMenuCopy> : null}
    </>
  );
  return (
    <ContextMenu menu={menu}>
      <a className={cx(s.row, fresh && s.arrive, row.status === "waiting" && s.waiting, row.role === "lead" && s.lead)} href={href} data-state={row.status}>
        <StateDot status={row.status} thinking={line.thinking} seed={agent.id} />
        <span className={s.line}>
          <span className={s.task}>
            <Truncate size="sm" expand="none">
              {row.title}
            </Truncate>
          </span>
          {row.profile === "medium" ? (
            <Text size="xs" tone="faint">
              {PROFILE_WORD[row.profile]}
            </Text>
          ) : null}
          <RolePill role={row.role} />
        </span>
        <span className={s.doing}>
          <ActivityLine line={line} />
          {onPr ? null : <WorkPlaceTag row={row} />}
        </span>
      </a>
    </ContextMenu>
  );
});

/** Rows' outlines (a dot, a title, a line under it), no shimmer. Busy only while an answer is on its way. */
function Skeleton({ busy }: { busy: boolean }) {
  return (
    <div className={s.skeleton} aria-busy={busy} aria-label="Loading agents">
      {[72, 58, 64].map((w) => (
        <span key={w} className={s.skeletonRow}>
          <span className={s.skeletonDot} />
          <span className={s.skeletonLines}>
            <span style={{ width: `${String(w)}%` }} />
            <span style={{ width: `${String(w - 20)}%` }} />
          </span>
        </span>
      ))}
    </div>
  );
}
