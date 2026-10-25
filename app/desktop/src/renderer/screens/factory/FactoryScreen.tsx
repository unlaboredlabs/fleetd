// Factory (#/factory, D33): what came out of the projects and what it cost you. Status is "now", Time is "where
// agent time went"; this is merges and the person's minutes, kept apart from agent minutes on purpose. One filter row
// scopes everything below it: four tiles, three charts on one shared day axis (merged by route, order to merged,
// your minutes by source), then the projects table and the merge list, which hold every number the charts draw.
// Every figure is the hub's (metrics_get); a repo the hub can't read says so and since when, never a silent zero.
import { useMemo, useState, type ReactNode } from "react";
import type { MetricsGetOutput, MetricsMerge, ProjectRef } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { selectConnection } from "../../src/data/selectors";
import { Dialog, Dot, FrameTitle, Text, cx } from "../../ui";
import { useCommands } from "../palette";
import { toHash, type ProjectKey } from "../shell/routes";
import { errorText } from "../time/data";
import { CallError } from "../../src/data/queries";
import { LeadChart } from "./charts/Lead";
import { MergedChart } from "./charts/Merged";
import { MinutesChart } from "./charts/Minutes";
import { HoverCard, type Hover } from "./charts/parts";
import { FilterRow } from "./FilterRow";
import { inRange, loadFilters, previousWords, queryOf, saveFilters, type Filters } from "./filters";
import { MergeList } from "./MergeList";
import { DEFAULT_SORT, WEEKLY_OVER, columnsOf, fmtAbout, inDays, sortMerges, type Column, type Sort } from "./model";
import { Repos } from "./Repos";
import { lacksMetrics } from "./support";
import { Tiles } from "./Tiles";
import s from "./Factory.module.css";

export interface FactoryScreenProps {
  /** The route's project; null is every project. */
  readonly project: ProjectKey | null;
  /** Fixed "now" for tests. */
  readonly now?: number;
  /** Filters to start from instead of the saved ones (tests). */
  readonly initialFilters?: Filters;
}

const OFFLINE = "Not connected to the hub. The figures come back when it reconnects.";

const navigate = (hash: string) => {
  window.location.hash = hash;
};

const chatHref = (ref: ProjectRef): string => toHash({ id: "project", project: ref, message: null });
const factoryHref = (ref: ProjectRef | null): string => toHash({ id: "factory", project: ref });

export function FactoryScreen(props: FactoryScreenProps) {
  const [filters, setFilters] = useState<Filters>(() => props.initialFilters ?? loadFilters());
  const [nowMs, setNow] = useState(() => props.now ?? Date.now());
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [picked, setPicked] = useState<Column | undefined>();
  const [hover, setHover] = useState<Hover | undefined>();
  const [seen, setSeen] = useState(false);
  const project = props.project;

  const input = useMemo(() => queryOf(filters, project, nowMs), [filters, project, nowMs]);
  const query = useToolQuery("metrics_get", input, { keepPrevious: true });
  const connection = useData(selectConnection);
  const offline = connection.view === "live" || (connection.view === "skeleton" && connection.reason === undefined) ? undefined : OFFLINE;
  const projectRows = useData((st) => st.projects);
  const orders = useData((st) => st.orders);
  const projects = useMemo(
    () =>
      Object.values(projectRows)
        .map((p) => ({ machineId: p.machineId, projectId: p.projectId, title: p.title }))
        .sort((a, b) => a.title.localeCompare(b.title) || a.machineId.localeCompare(b.machineId)),
    [projectRows],
  );
  const projectTitle = (ref: ProjectRef): string =>
    projects.find((p) => p.machineId === ref.machineId && p.projectId === ref.projectId)?.title ?? `a project on ${ref.machineId}`;
  const orderTitle = (id: string): string | undefined => orders?.[id]?.title;

  // Each new question is asked as of now (unless a test pins it); the frame holds, dimmed, until it is answered.
  const fixedNow = props.now;
  const changeFilters = (f: Filters) => {
    setFilters(f);
    saveFilters(f);
    setPicked(undefined);
    setNow(fixedNow ?? Date.now());
  };
  const changeProject = (p: ProjectKey | null) => {
    setPicked(undefined);
    setNow(fixedNow ?? Date.now());
    navigate(factoryHref(p));
  };

  useCommands(
    [
      {
        id: "factory:compare",
        title: filters.compare ? "Factory: stop comparing" : "Factory: compare with the period before",
        group: "actions",
        run: () => changeFilters({ ...filters, compare: !filters.compare }),
      },
      { id: "factory:all", title: "Factory: all projects", group: "actions", enabled: () => project !== null, run: () => changeProject(null) },
    ],
    [filters.compare, project === null],
  );

  const data: MetricsGetOutput | undefined = query.data;
  const refetching = query.isPlaceholderData;
  const title = project === null ? "Factory" : `Factory: ${projectTitle(project)}`;

  let body: ReactNode;
  let state: string;
  // A hub from before metrics: no error, just what to do (a link kept from a newer hub, or typed, lands here).
  const unsupported = data === undefined && query.isError && query.error instanceof CallError && lacksMetrics(query.error.error);
  if (data === undefined) {
    if (unsupported) {
      state = "factory.unsupported";
      body = (
        <div className={cx(s.empty)}>
          <Text strong>This hub doesn&apos;t report metrics yet</Text>
          <Text tone="quiet">Update fleetd on the hub&apos;s machine, and merges, order to merged and your minutes show here.</Text>
        </div>
      );
    } else if (query.isError) {
      state = "factory.error";
      body = (
        <div className={cx(s.empty)} role="alert">
          <Text strong>The hub couldn&apos;t answer</Text>
          <Text tone="quiet">{query.error instanceof CallError ? errorText(query.error.error) : "The hub couldn't answer."}</Text>
        </div>
      );
    } else if (offline !== undefined) {
      state = "factory.offline";
      body = (
        <div className={cx(s.empty)}>
          <Text tone="quiet">{offline}</Text>
        </div>
      );
    } else {
      state = "factory.loading";
      body = (
        <div className={cx(s.skeleton)} aria-busy="true" aria-label="Loading the figures">
          <span />
          <span />
          <span />
          <span />
        </div>
      );
    }
  } else {
    state = data.tiles.merged.n === 0 ? "factory.empty" : "factory";
    body = (
      <Figures
        data={data}
        filters={filters}
        nowMs={nowMs}
        all={project === null}
        sort={sort}
        onSort={setSort}
        picked={picked}
        onPick={(c) => setPicked((was) => (was?.from === c.from ? undefined : c))}
        onHover={setHover}
        onSeen={() => setSeen(true)}
        orderTitle={orderTitle}
        projectTitle={projectTitle}
        refetching={refetching}
      />
    );
  }

  return (
    <div className={cx(s.screen)} data-screen={state}>
      <FrameTitle title={title} detail="What came out, and what it cost you">
        {offline !== undefined && data !== undefined ? (
          <span role="status">
            <Text size="xs" tone="warning">
              {OFFLINE}
            </Text>
          </span>
        ) : null}
      </FrameTitle>
      <FilterRow filters={filters} project={project} projects={projects} nowMs={nowMs} onFilters={changeFilters} onProject={changeProject} />
      <div className={cx(s.scroll)}>{body}</div>
      {hover !== undefined ? <HoverCard hover={hover} /> : null}
      <SeenSheet open={seen} onOpenChange={setSeen} data={data} />
    </div>
  );
}

interface FiguresProps {
  readonly data: MetricsGetOutput;
  readonly filters: Filters;
  readonly nowMs: number;
  readonly all: boolean;
  readonly sort: Sort;
  readonly onSort: (s: Sort) => void;
  readonly picked: Column | undefined;
  readonly onPick: (c: Column) => void;
  readonly onHover: (h: Hover | undefined) => void;
  readonly onSeen: () => void;
  readonly orderTitle: (id: string) => string | undefined;
  readonly projectTitle: (ref: ProjectRef) => string;
  readonly refetching: boolean;
}

function Figures(p: FiguresProps) {
  const { data } = p;
  const columns = useMemo(() => columnsOf(data.days), [data.days]);
  const previous = useMemo(() => (data.compare === undefined ? undefined : columnsOf(data.compare.days)), [data.compare]);
  const weekly = data.days.length > WEEKLY_OVER;
  const dayKeys = useMemo(() => data.days.map((d) => d.day), [data.days]);
  const merges = useMemo(() => {
    const shown = p.picked === undefined ? data.merges : inDays(data.merges, p.picked.from, p.picked.to);
    return sortMerges(shown, p.sort);
  }, [data.merges, p.picked, p.sort]);
  const coverage = data.coverage.repos;
  // Reviews come only from a git host fleetd reads (GitHub first): with none in scope, the minutes chart says why it has none.
  const noReviews = coverage.length > 0 && coverage.every((c) => c.host === "git");
  const orderHref = (m: MetricsMerge) => (m.workstreamId === undefined || m.projectRef === undefined ? undefined : chatHref(m.projectRef));
  const empty = data.tiles.merged.n === 0;

  return (
    <div className={cx(s.frame, p.refetching && s.refetching)} aria-busy={p.refetching}>
      {data.coverage.stale.length > 0 ? (
        <div className={cx(s.banners)} role="note">
          {data.coverage.stale.map((st) => (
            <span key={st.repo} className={cx(s.banner)}>
              <Dot color="var(--warning)" />
              <Text size="xs">{`${st.reason}. Its figures stop there.`}</Text>
            </span>
          ))}
        </div>
      ) : null}
      <Tiles tiles={data.tiles} inRange={inRange(p.filters)} versus={previousWords(p.filters, p.nowMs)} onSeen={p.onSeen} />
      {empty ? (
        <div className={cx(s.empty)}>
          <Text strong>No merges in this range.</Text>
          <Text tone="quiet">
            {coverage.length === 0
              ? "fleetd counts merges in your projects' repos. Add a project to see what comes out of it."
              : "fleetd reads the default branch of every project's repo: merges by the train, by you, or by anyone else show up here."}
          </Text>
        </div>
      ) : (
        <>
          <MergedChart columns={columns} previous={previous} merges={data.merges} weekly={weekly} picked={p.picked} onPick={p.onPick} onHover={p.onHover} />
          <LeadChart
            merges={data.merges}
            days={dayKeys}
            medianMs={data.tiles.orderToMerged.medianMs}
            coverage={coverage}
            orderTitle={p.orderTitle}
            onHover={p.onHover}
          />
          <MinutesChart columns={columns} previous={previous} weekly={weekly} noReviews={noReviews} onHover={p.onHover} />
        </>
      )}
      {p.all && data.repos !== undefined && data.repos.length > 0 ? (
        <Repos rows={data.repos} projectTitle={p.projectTitle} projectHref={factoryHref} />
      ) : null}
      {!empty ? (
        <MergeList
          merges={merges}
          total={data.mergesTotal}
          coverage={coverage}
          sort={p.sort}
          onSort={p.onSort}
          narrowed={p.picked?.label}
          onShowAll={() => p.picked !== undefined && p.onPick(p.picked)}
          orderTitle={p.orderTitle}
          orderHref={orderHref}
        />
      ) : null}
    </div>
  );
}

/** What "from what fleetd sees" means: the estimate, its low bound, and what fleetd can't see at all. */
function SeenSheet({ open, onOpenChange, data }: { open: boolean; onOpenChange: (open: boolean) => void; data: MetricsGetOutput | undefined }) {
  const human = data?.tiles.human;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Your minutes, from what fleetd sees"
      description="Each act you make (a chat message, an approval, a review, a steer, time with the app open on a project) counts the least time it could take; acts under five minutes apart join into one stretch."
    >
      <div className={cx(s.section)}>
        {human !== undefined ? (
          <Text>{`${fmtAbout(human.totalMs)} on fleetd work in this range, at least ${fmtAbout(human.lowMs).slice(2)} counting only the acts themselves. Outside work: ${fmtAbout(human.outsideTotalMs)} over ${human.outsidePrs} merges, a bare minimum.`}</Text>
        ) : null}
        <Text strong>What fleetd can&apos;t see</Text>
        <ul>
          {(data?.coverage.invisible ?? []).map((line) => (
            <li key={line}>
              <Text>{line}</Text>
            </li>
          ))}
        </ul>
        <Text size="xs" tone="quiet">
          Time agents spent waiting on you isn&apos;t in it: that is on the Time screen.
        </Text>
      </div>
    </Dialog>
  );
}
