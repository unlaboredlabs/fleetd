// The Agents tab: one list. The project's agents at work under the orders they work on, those waiting on you first, one
// calm row each (its state as a glyph, its title, and under it what it is doing now); its role and where its work is
// are in the row's hover and on its own view. A row opens that agent's live work in the list's place, read-only. Under
// them Screens, where the hub serves them: the browsers and devices the agents and you have open, with All screens and
// New screen at the label's end, and the ones that ended under a fold. Then, folded, what is elsewhere: Also on this
// repo (the live work on its repo and base that isn't the project's, read-only) and Other projects (their agents,
// under their names). The rows come from the data layer (agents_list, browser_sessions and work_list, refetched on
// events, merged with the live feed) and the orders' titles from the board, so nothing here polls.
import { LayoutGrid } from "lucide-react";
import { memo, useEffect, useMemo, useRef, type ComponentProps } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { selectLiveAgents, selectProjects, type LiveAgent } from "../../src/data/selectors";
import { Button, ContextMenu, ContextMenuCopy, ContextMenuItem, Dot, IdChip, ROLE_WORD, Text, Tooltip, Truncate, VirtualList, cx, useArrivals, useArrived, useLeavers } from "../../ui";
import { ActivityLine } from "../live/parts";
import { steerNext } from "../live/Steer";
import { describe, isFinal } from "../live/words";
import { useNow } from "../live/clock";
import { FoldLine, GroupLabel, ListNote, PanelEmpty, useFold } from "../panel/folds";
import { FEATURE, useScreenWaits, useSessions } from "../sessions/hub";
import { isLive, sessionGroups, type BrowserSession, type ScreenWaiting } from "../sessions/model";
import { NewScreenButton } from "../sessions/NewScreen";
import { SessionRow, WaitRow } from "../sessions/SessionRows";
import { navigate } from "../shell/navigation";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { AgentWork } from "./AgentWork";
import { agentDetail, alsoOnRepo, nextExpiry, otherProjects, projectGroups, type ElsewhereRow, type GroupLine, type OrderTitle } from "./model";
import { StateDot } from "./parts";
import s from "./agents.module.css";

const ALL = {} as const;

export const isLine = (item: GroupLine | LiveAgent): item is GroupLine => "group" in item;

/** A fold's line: what is elsewhere or over, with how many. */
interface Fold {
  readonly fold: "repo" | "projects" | "recent";
  readonly label: string;
  readonly count: number;
}

type Item =
  | GroupLine
  | LiveAgent
  | Fold
  | { readonly row: ElsewhereRow; readonly other: true }
  | { readonly note: string }
  | { readonly screens: number }
  | { readonly wait: ScreenWaiting }
  | { readonly session: BrowserSession };

const keyOf = (item: Item): string => {
  if ("fold" in item) return `fold:${item.fold}`;
  if ("other" in item) return `elsewhere:${item.row.id}`;
  if ("note" in item) return "note";
  if ("screens" in item) return "screens";
  if ("wait" in item) return `wait:${item.wait.id}`;
  if ("session" in item) return `session:${item.session.id}`;
  return isLine(item) ? item.group : item.id;
};

/**
 * The project's Also on this repo rows; none until read, and none when the hub can't say (an older hub, or a project
 * whose repo it doesn't know): the agents above are the point, so a failed read stays quiet. Read from the hub alone
 * (`paths: false`): the rows show no files, so no machine is asked what its writers changed. Read again when the
 * soonest claim shown expires, as a renewal sends no event.
 */
function useElsewhere(project: ProjectKey): { base: string; rows: readonly ElsewhereRow[] } | undefined {
  const query = useToolQuery("work_list", { projectRef: { machineId: project.machineId, projectId: project.projectId }, paths: false });
  const { data, refetch } = query;
  useEffect(() => {
    if (data === undefined) return undefined;
    const at = nextExpiry(data, Date.now());
    if (at === undefined) return undefined;
    // A second after, so the hub's sweep has had its chance; capped at what setTimeout holds.
    const timer = window.setTimeout(() => void refetch(), Math.min(at - Date.now() + 1_000, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [data, refetch]);
  const projects = useData(selectProjects);
  const key = projectKey(project);
  // "expires in 9 h" and "2 h ago" move by the minute.
  const now = useNow(true, 60_000);
  return useMemo(() => {
    if (query.data === undefined) return undefined;
    const titles = new Map((projects ?? []).map((p) => [projectKey(p), p.title]));
    return { base: query.data.scope.base, rows: alsoOnRepo(query.data, key, now, (k) => titles.get(k)) };
  }, [query.data, projects, key, now]);
}

/** The project's agents and screens, or (`agent`, a lane) one agent's work. `at`: the place in the list a link named. */
export function AgentsPane({ project, agent, at = null }: { project: ProjectKey; agent: string | null; at?: "screens" | null }) {
  const key = projectKey(project);
  if (agent !== null) return <AgentWork key={agent} id={`${key}/${agent}`} />;
  return <AgentList project={project} at={at} />;
}

function AgentList({ project: ref, at }: { project: ProjectKey; at: "screens" | null }) {
  const project = projectKey(ref);
  const fresh = useData((st) => st.fresh);
  const query = useToolQuery("agents_list", ALL);
  const all = useData(selectLiveAgents);
  const orders = useData((st) => st.orders);
  const agents = useMemo(() => {
    if (all === undefined) return undefined;
    const titleOf: OrderTitle = (id) => orders?.[id]?.title;
    return projectGroups(all, project, titleOf);
  }, [all, orders, project]);
  const others = useMemo(() => (all === undefined ? [] : otherProjects(all, project)), [all, project]);
  const repo = useElsewhere(ref);

  const screensOn = useData((st) => st.features.includes(FEATURE));
  const sessions = useSessions(ref);
  const waits = useScreenWaits(ref);
  const groups = useMemo(() => sessionGroups(sessions), [sessions]);
  // What a live screen's hover says counts up with the app's one clock; the ended ones say how long ago, by the minute.
  const now = useNow(screensOn, sessions.some(isLive) ? undefined : 60_000);
  const screenList = `sessions:${project}`;
  useArrivals(screenList, sessions.map((x) => x.id));

  // Folded until asked for: the project's own agents and what is live are the point, the rest is context.
  const [repoOpen, toggleRepo] = useFold(`agents:${project}:repo`);
  const [othersOpen, toggleOthers] = useFold(`agents:${project}:projects`);
  const [recentOpen, toggleRecent] = useFold(`agents:${project}:recent`);
  const toggles = { repo: toggleRepo, projects: toggleOthers, recent: toggleRecent };
  const opened = { repo: repoOpen, projects: othersOpen, recent: recentOpen };

  const items = useMemo((): readonly Item[] | undefined => {
    if (agents === undefined) return undefined;
    const out: Item[] = [...agents];
    if (screensOn) {
      const live = groups.filter((g) => g.group !== "recent").flatMap((g) => g.sessions);
      const recent = groups.find((g) => g.group === "recent")?.sessions ?? [];
      out.push({ screens: live.length }, ...waits.map((wait) => ({ wait })), ...live.map((session) => ({ session })));
      if (recent.length > 0) out.push({ fold: "recent", label: "Recent", count: recent.length }, ...(recentOpen ? recent.map((session) => ({ session })) : []));
    }
    if (repo !== undefined && repo.rows.length > 0) {
      out.push({ fold: "repo", label: "Also on this repo", count: repo.rows.length }, ...(repoOpen ? repo.rows.map((row) => ({ row, other: true as const })) : []));
    }
    const theirs = others.filter((a) => !isLine(a)).length;
    if (theirs > 0) out.push({ fold: "projects", label: "Other projects", count: theirs }, ...(othersOpen ? others : []));
    // Nothing of its own at work, with something under it: one quiet line where its agents would be.
    return agents.length === 0 && out.length > 0 ? [{ note: "No agents are working." }, ...out] : out;
  }, [agents, screensOn, groups, waits, recentOpen, repo, repoOpen, others, othersOpen]);
  // Folding is a new view, not rows leaving: its rows go at once, with no fade.
  const shown = useLeavers(items, keyOf, `${project}:${String(repoOpen)}:${String(othersOpen)}:${String(recentOpen)}`);
  // Rows that join the list later enter once; those it opened with, or scrolled to, don't.
  useArrivals(`agents:${project}`, all?.filter((a) => a.project === project).map((a) => a.id));

  // A link to the project's screens (`/sessions`, the palette's Go to Screens) opens the list at them.
  const list = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const screensAt = shown?.findIndex((x) => "screens" in x.item) ?? -1;
  const there = at === "screens" && screensAt >= 0;
  useEffect(() => {
    if (there) list.current?.scrollToIndex(screensAt, { align: "start" });
    // Only as the link opens it: the list then scrolls as the reader does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [there]);

  return (
    <div className={s.pane} data-screen={at === "screens" ? "sessions" : "agents"}>
      {!fresh ? (
        <span className={s.liveness} role="status">
          <Dot color="var(--warning)" />
          <Text size="xs">Not live: reconnecting</Text>
        </span>
      ) : query.isError ? (
        <span className={s.liveness} role="alert">
          <Dot color="var(--warning)" />
          <Text size="xs">Couldn’t read the agents</Text>
          <Button variant="quiet" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
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
        <PanelEmpty title="No agents are working" />
      ) : (
        <div className={s.list}>
          <VirtualList
            items={shown ?? []}
            getKey={(x) => keyOf(x.item)}
            virtualizerRef={list}
            renderItem={({ item: a, leaving }) => {
              const row =
                "fold" in a ? (
                  <FoldLine label={a.label} count={a.count} open={opened[a.fold]} onToggle={toggles[a.fold]} />
                ) : "other" in a ? (
                  <ElsewhereRowView row={a.row} />
                ) : "note" in a ? (
                  <ListNote>{a.note}</ListNote>
                ) : "screens" in a ? (
                  <ScreensLabel project={ref} count={a.screens} />
                ) : "wait" in a ? (
                  <WaitRow wait={a.wait} />
                ) : "session" in a ? (
                  <SessionRow list={screenList} session={a.session} now={now} />
                ) : isLine(a) ? (
                  <GroupLabel label={a.title} count={a.count} />
                ) : (
                  <AgentRowLink agent={a} />
                );
              // A row that left fades where it stood (ui/lib/leaving), then goes.
              return leaving ? (
                <div data-leaving="" inert aria-hidden>
                  {row}
                </div>
              ) : (
                row
              );
            }}
            estimateSize={52}
            aria-label="Agents"
          />
        </div>
      )}
    </div>
  );
}

/**
 * Screens, above the project's: how many are live, and at the label's end the way to every project's screens as a wall
 * (the Screens page, D305) and New screen, which opens one of your own.
 */
function ScreensLabel({ project, count }: { project: ProjectKey; count: number }) {
  return (
    <GroupLabel
      label="Screens"
      count={count}
      end={
        <>
          <Tooltip content="All screens: every project’s, side by side">
            <Button variant="quiet" size="sm" iconOnly aria-label="All screens" onClick={() => navigate({ id: "screens", open: null })}>
              <LayoutGrid />
            </Button>
          </Tooltip>
          <NewScreenButton project={project} />
        </>
      }
    />
  );
}

/**
 * Work elsewhere, laid out as an agent's row: its title with what it is at the line's end, and under it who holds it
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
        <span className={s.tag}>{row.tag}</span>
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
 * Its state as a glyph and its title; under them what it is doing now. Waiting on you, its title is a step heavier. Its
 * role, its profile and where its work is (its PR, or its branch) are in its hover, beside the row. A link, so it opens
 * with the keyboard and keeps history. Its right-click menu opens it, opens it to steer while it runs (once it has
 * started), or copies its branch.
 */
export const AgentRowLink = memo(function AgentRowLink({ agent }: { agent: LiveAgent }) {
  const { row } = agent;
  const href = toHash(panelRoute(row.projectRef, { tab: "agents", agent: row.laneId }));
  const { taskId, branch } = row;
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
      <AgentRow agent={agent} href={href} />
    </ContextMenu>
  );
});

/** The row itself: a link under its hover, which takes the menu's props and ref as any element would. */
function AgentRow({ agent, ...rest }: { agent: LiveAgent } & ComponentProps<"a">) {
  const { row } = agent;
  const line = describe(row);
  const fresh = useArrived(`agents:${agent.project}`, agent.id);
  return (
    <Tooltip content={agentDetail(row, ROLE_WORD[row.role])} side="left">
      <a {...rest} className={cx(s.row, fresh && s.arrive, row.status === "waiting" && s.waiting)} data-state={row.status} data-role={row.role}>
        <StateDot status={row.status} thinking={line.thinking} seed={agent.id} />
        <span className={s.task}>
          <Truncate size="sm" expand="none">
            {row.title}
          </Truncate>
        </span>
        <span className={s.doing}>
          <ActivityLine line={line} />
        </span>
      </a>
    </Tooltip>
  );
}

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
