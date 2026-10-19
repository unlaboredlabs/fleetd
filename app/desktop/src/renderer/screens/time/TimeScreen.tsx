// The time inspector (docs/build/time-inspector-spec.md §8): where an order's, a project's or the fleet's agent
// time went. One filter bar over three tabs: the timeline (an order's lanes), the breakdown and the insights. Every
// number is the hub's (`time_*` tools); the screen lays them out and says plainly where a figure is a bound, a split
// or an approximation rather than a measurement (spec §2f).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Dot, Tab, TabList, TabPanel, Tabs, Text, Truncate, copyText, cx, toast } from "../../ui";
import { selectConnection } from "../../src/data/selectors";
import { useData } from "../../src/data/react";
import { useCommands } from "../palette";
import { Breakdown } from "./Breakdown";
import "./commands";
import { FilterBar } from "./FilterBar";
import { Insights } from "./Insights";
import { LinkedSheet, TranscriptSheet } from "./Sheets";
import { Timeline } from "./Timeline";
import { linkedKeeps, useLinked, useNames, useTimeData, useWindow, type Linked } from "./data";
import { loadFilters, queryOf, saveFilters, type Filters } from "./filters";
import { ROLE_WORD, fmtDur, isMissingEmpty, missing, missingSentence } from "./format";
import { barsFor, buildModel } from "./model";
import { orderRoute } from "./route";
import type { Category, Span } from "./types";
import s from "./Time.module.css";

type TabId = "timeline" | "breakdown" | "insights";

export interface TimeScreenProps {
  /** The order to open on (its timeline); none opens the fleet's breakdown. */
  readonly order?: string | undefined;
  /** Opens the order view, at a thread item when one is given. Defaults to the route (#/order/<id>?thread=&item=). */
  readonly onOpenOrder?: (order: string, at?: { readonly threadId: string; readonly itemId: string }) => void;
  /** Opens a CI check's page in the browser. Without one, the link is copied: the renderer opens nothing itself. */
  readonly onOpenUrl?: (url: string) => void;
  /** Fixed "now" for fixtures and screenshots. */
  readonly now?: number;
  /** Filters to start from instead of the saved ones (fixtures). */
  readonly initialFilters?: Filters;
}

const routeToOrder = (order: string, at?: { readonly threadId: string; readonly itemId: string }) => {
  window.location.hash = orderRoute(order, at);
};

const copyLink = (url: string) => {
  void copyText(url).then((ok) => toast({ title: ok ? "Link to the check copied" : "Couldn't copy the link", tone: ok ? "success" : "danger" }));
};

const noSpans: readonly Span[] = [];

interface Highlight {
  readonly ids: ReadonlySet<number>;
  readonly title: string;
  readonly linked: Linked;
}

export function TimeScreen(props: TimeScreenProps) {
  const openOrder = props.onOpenOrder ?? routeToOrder;
  const openUrl = props.onOpenUrl ?? copyLink;
  const [order, setOrder] = useState(props.order);
  const [filters, setFilters] = useState<Filters>(() => props.initialFilters ?? loadFilters());
  const [nowMs, setNow] = useState(() => props.now ?? Date.now());
  const [tab, setTab] = useState<TabId>(props.order !== undefined ? "timeline" : "breakdown");
  const [view, setView] = useState<readonly [number, number] | undefined>();
  const [highlight, setHighlight] = useState<Highlight | undefined>();
  const [linked, setLinked] = useState<Linked | undefined>();
  const [windowAt, setWindowAt] = useState<Span | undefined>();

  // The route can re-aim the open screen at another order.
  const [routeOrder, setRouteOrder] = useState(props.order);
  if (props.order !== routeOrder) {
    setRouteOrder(props.order);
    setOrder(props.order);
    setTab(props.order !== undefined ? "timeline" : "breakdown");
    setView(undefined);
    setHighlight(undefined);
  }

  // Each new question is asked as of now (unless a fixture pins it).
  const fixedNow = props.now;
  const reaim = useCallback(() => setNow(fixedNow ?? Date.now()), [fixedNow]);

  const query = useMemo(() => queryOf(filters, order, nowMs), [filters, order, nowMs]);
  const data = useTimeData(query);
  const connection = useData(selectConnection);
  // Off the hub nothing can be asked; say so rather than show a loading line that never ends.
  const offline =
    connection.view === "live" || (connection.view === "skeleton" && connection.reason === undefined)
      ? undefined
      : "Not connected to the hub. The figures come back when it reconnects.";
  const names = useNames(order);
  const breakdown = data.breakdown?.ok === true ? data.breakdown.value : undefined;
  const coverage = data.spansCoverage ?? breakdown?.coverage;

  const model = useMemo(
    () => (order !== undefined && data.spans.length > 0 ? buildModel(data.spans, breakdown?.criticalPath, coverage, names, nowMs) : undefined),
    [order, data.spans, breakdown?.criticalPath, coverage, names, nowMs],
  );

  const shown = useMemo(() => {
    if (coverage === undefined) return undefined;
    // An order is asked for a year back, so a retention cutoff matters only if the order began before it.
    const from = order !== undefined ? (model?.startMs ?? breakdown?.criticalPath?.startMs) : Date.parse(query.breakdown.since);
    return missing(coverage, from);
  }, [coverage, order, model?.startMs, breakdown?.criticalPath?.startMs, query.breakdown.since]);

  const pathIds = useMemo(() => {
    if (model === undefined) return undefined;
    const out = new Map<Category, number[]>();
    for (const seg of model.path) {
      const span = seg.span === undefined ? undefined : model.spans[seg.span];
      if (span === undefined) continue;
      out.set(seg.cat, [...(out.get(seg.cat) ?? []), span.id]);
    }
    return out;
  }, [model]);

  const changeFilters = (f: Filters) => {
    setFilters(f);
    saveFilters(f);
    reaim();
  };

  const changeOrder = (o: string | undefined) => {
    setOrder(o);
    // The route follows, so back/forward and a reload keep the order; outside the router this changes nothing.
    window.location.hash = o === undefined ? "#/time" : `#/time/order/${encodeURIComponent(o)}`;
    setView(undefined);
    setHighlight(undefined);
    setTab(o !== undefined ? "timeline" : tab === "timeline" ? "breakdown" : tab);
    reaim();
  };

  /** "Show spans": on an order, its own timeline lit up; elsewhere the hub lists them in a sheet. */
  const showLinked = (l: Linked, ids?: readonly number[]) => {
    if (order !== undefined && model !== undefined) {
      // Matched spans become the bars that show them (a parallel call lights its group), and the list later lists
      // exactly these: one set for both.
      const matched = ids !== undefined && ids.length > 0 ? ids : model.spans.filter((x) => linkedKeeps(l, x)).map((x) => x.id);
      const set = barsFor(model, matched);
      setHighlight({ ids: set, title: l.title, linked: l });
      setTab("timeline");
      return;
    }
    setLinked(l);
  };

  const listHighlight = () => {
    if (highlight === undefined) return;
    // The lit spans are already here, by id; asking the hub again by rule or kind would list other spans.
    setLinked({ ...highlight.linked, ids: highlight.ids });
  };

  /** A click on one span: a check's page, else its transcript at that item. */
  const openSpan = (span: Span) => {
    if (span.extra?.url !== undefined) {
      openUrl(span.extra.url);
      return;
    }
    if (span.machineId === undefined || span.threadId === undefined || span.itemId === undefined) return;
    setWindowAt(span);
  };

  // While the inspector is open, the palette can drive it.
  const compareOn = filters.compare && order === undefined;
  useCommands(
    [
      { id: "time:timeline", title: "Time: timeline", group: "actions", enabled: () => order !== undefined, run: () => setTab("timeline") },
      { id: "time:breakdown", title: "Time: breakdown", group: "actions", run: () => setTab("breakdown") },
      { id: "time:insights", title: "Time: insights", group: "actions", run: () => setTab("insights") },
      { id: "time:whole", title: "Time: show the whole order", detail: "Undo the zoom", group: "actions", enabled: () => view !== undefined, run: () => setView(undefined) },
      { id: "time:clear", title: "Time: clear the lit spans", group: "actions", enabled: () => highlight !== undefined, run: () => setHighlight(undefined) },
      {
        id: "time:compare",
        title: compareOn ? "Time: stop comparing" : "Time: compare with the period before",
        group: "actions",
        enabled: () => order === undefined,
        run: () => changeFilters({ ...filters, compare: !filters.compare }),
      },
    ],
    [compareOn],
  );

  const linkedAnswer = useLinked(query, linked, model?.spans ?? noSpans);
  const windowAnswer = useWindow(windowAt);

  const waitingOnHub = offline !== undefined && !data.spansDone;
  const timelineNote = waitingOnHub
    ? offline
    : (data.spansError ??
      (data.spansDone
        ? "No spans for this order yet. Spans start when its first agent starts; a machine running an older fleetd records none."
        : "Loading this order's spans…"));

  // Esc closes the innermost thing: the sheets, menus and the palette close themselves, then the highlight, then the
  // zoom. On the document, not the screen: after a tab switch or a click on a sheet's row, focus sits on <body>.
  const sheetOpen = linked !== undefined || windowAt !== undefined;
  const hasHighlight = highlight !== undefined;
  const zoomed = view !== undefined;
  useEffect(() => {
    if (!hasHighlight && !zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || sheetOpen) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null) return;
      if (hasHighlight) setHighlight(undefined);
      else setView(undefined);
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hasHighlight, zoomed, sheetOpen]);

  const orderInfo = order === undefined ? undefined : names.orders.get(order);
  const title = order === undefined ? "Where the time went" : (orderInfo?.title ?? `Order ${order}`);
  const figures: string[] = [];
  if (breakdown !== undefined) {
    figures.push(`${order !== undefined ? "wall" : "wall of orders"} ${fmtDur(breakdown.wallMs)}`);
    const p = breakdown.criticalPath;
    if (p !== undefined) figures.push(`path ${fmtDur(p.endMs - p.startMs)}`);
    figures.push(`agents ${fmtDur(breakdown.agentMs)}`);
    if (breakdown.wallMs > 0) figures.push(`${(breakdown.agentMs / breakdown.wallMs).toFixed(1)}× in parallel`);
  }
  const badge: string[] = [];
  if (shown !== undefined && !isMissingEmpty(shown)) {
    if (shown.gaps > 0) badge.push(`${shown.gaps} gap${shown.gaps === 1 ? "" : "s"} in the data`);
    if (shown.capped) badge.push("capped");
    if (shown.detailSince !== undefined) badge.push(`detail since ${shown.detailSince}`);
  }
  const coverageText = shown !== undefined && coverage !== undefined ? missingSentence(shown, coverage) : undefined;

  const lane = windowAt?.threadId === undefined ? undefined : names.threads.get(windowAt.threadId);
  const who = lane === undefined ? (windowAt?.taskId ?? "agent") : `${ROLE_WORD[lane.role]} ${lane.taskId ?? ""}`.trim();
  const orderOf = windowAt?.workstreamId ?? order;

  return (
    <div className={cx(s.screen)} data-screen="time">
      <header className={cx(s.head)}>
        {order !== undefined ? (
          <Button variant="ghost" onClick={() => openOrder(order)}>
            ‹ Order
          </Button>
        ) : null}
        {orderInfo !== undefined ? (
          <Truncate tone="quiet" className={cx(s.crumb)}>{`${orderInfo.project} ›`}</Truncate>
        ) : null}
        <Truncate strong as="h2">
          {title}
        </Truncate>
        <span className={cx(s.grow)} />
        {figures.length > 0 ? (
          <Text size="xs" tone="quiet" tabular className={cx(s.figures)}>
            {figures.join(" · ")}
          </Text>
        ) : null}
        {badge.length > 0 ? (
          <span className={cx(s.badge)}>
            <Dot color="var(--warning)" />
            <Text size="xs" tone="warning">
              {badge.join(" · ")}
            </Text>
          </span>
        ) : null}
      </header>
      <FilterBar filters={filters} order={order} names={names} nowMs={nowMs} onFilters={changeFilters} onOrder={changeOrder} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className={cx(s.tabs)}>
        <TabList className={cx(s.tabList)} aria-label="Views">
          <Tab value="timeline" disabled={order === undefined} title={order === undefined ? "Pick an order to see its timeline" : undefined}>
            Timeline
          </Tab>
          <Tab value="breakdown">Breakdown</Tab>
          <Tab value="insights" count={data.insights?.ok === true && data.insights.value.insights.length > 0 ? data.insights.value.insights.length : undefined}>
            Insights
          </Tab>
        </TabList>
        <TabPanel value="timeline" className={cx(s.panel)}>
          {coverageText !== undefined ? (
            <div className={cx(s.banner)} role="note">
              <Dot color="var(--warning)" />
              <Text size="xs">
                Timeline not complete: {coverageText}. Missing stretches are marked under their rows; they have no bars and are not idle time.
              </Text>
            </div>
          ) : null}
          {highlight !== undefined ? (
            <div className={cx(s.banner)}>
              <span className={cx(s.litMark)} aria-hidden />
              <Truncate size="xs">{`${highlight.ids.size} span${highlight.ids.size === 1 ? "" : "s"} lit: ${highlight.title}`}</Truncate>
              <span className={cx(s.grow)} />
              <Button variant="ghost" onClick={listHighlight}>
                List them
              </Button>
              <Button variant="ghost" onClick={() => setHighlight(undefined)}>
                Clear
              </Button>
            </div>
          ) : null}
          {!data.spansDone && model !== undefined ? (
            // Busy until every page is in, so nothing (a screenshot, a screen reader) takes half an order as the whole.
            <div className={cx(s.loadingLine)} aria-busy="true">
              <Text size="xs" tone="quiet">
                Loading spans… {data.spans.length} so far
              </Text>
            </div>
          ) : null}
          {model !== undefined ? (
            <Timeline model={model} names={names} nowMs={nowMs} view={view} onView={setView} lit={highlight?.ids} onSpan={openSpan} />
          ) : (
            <div className={cx(s.empty)} data-screen={waitingOnHub ? "time.timeline.offline" : "time.timeline.empty"}>
              <Text tone={data.spansError !== undefined ? "danger" : "quiet"}>{timelineNote}</Text>
            </div>
          )}
        </TabPanel>
        <TabPanel value="breakdown" className={cx(s.panel)}>
          {data.breakdown === undefined ? (
            <div className={cx(s.empty)} {...(offline === undefined ? {} : { "data-screen": "time.breakdown.offline" })}>
              <Text tone="quiet">{offline ?? "Asking the hub where the time went…"}</Text>
            </div>
          ) : !data.breakdown.ok ? (
            <div className={cx(s.empty)} data-screen="time.breakdown.error">
              <Text strong>The hub couldn&apos;t answer</Text>
              <Text tone="quiet">{data.breakdown.error}</Text>
            </div>
          ) : (
            <Breakdown data={data.breakdown.value} order={order !== undefined} missing={shown} pathIds={pathIds} onLinked={showLinked} />
          )}
        </TabPanel>
        <TabPanel value="insights" className={cx(s.panel)}>
          {data.insights === undefined ? (
            <div className={cx(s.empty)} {...(offline === undefined ? {} : { "data-screen": "time.insights.offline" })}>
              <Text tone="quiet">{offline ?? "Running the hub's rules over this period…"}</Text>
            </div>
          ) : !data.insights.ok ? (
            <div className={cx(s.empty)} data-screen="time.insights.error">
              <Text strong>The hub couldn&apos;t answer</Text>
              <Text tone="quiet">{data.insights.error}</Text>
            </div>
          ) : (
            <Insights insights={data.insights.value.insights} compare={query.insights.compare !== undefined} onLinked={showLinked} />
          )}
        </TabPanel>
      </Tabs>
      <TranscriptSheet
        open={windowAt !== undefined}
        who={who}
        answer={windowAnswer}
        onClose={() => setWindowAt(undefined)}
        onOpenInOrder={
          orderOf !== undefined && windowAt?.threadId !== undefined && windowAt.itemId !== undefined
            ? () => openOrder(orderOf, { threadId: windowAt.threadId ?? "", itemId: windowAt.itemId ?? "" })
            : undefined
        }
      />
      <LinkedSheet
        title={linked?.title}
        answer={linkedAnswer}
        names={names}
        nowMs={nowMs}
        onClose={() => setLinked(undefined)}
        onSpan={(x) => {
          setLinked(undefined);
          openSpan(x);
        }}
      />
    </div>
  );
}
