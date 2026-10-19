// The time inspector (docs/build/time-inspector-spec.md §8): where an order's, a project's or the fleet's agent
// time went. One filter bar over three tabs: the timeline (an order's lanes), the breakdown and the insights. Every
// number is the hub's (`time_*` tools); the screen lays them out and says plainly where a figure is a bound, a split
// or an approximation rather than a measurement (spec §2f).
import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { Button, Dot, Tab, TabList, TabPanel, Tabs, Text, Truncate, cx } from "../../ui";
import { Breakdown } from "./Breakdown";
import { FilterBar } from "./FilterBar";
import { Insights } from "./Insights";
import { LinkedSheet, TranscriptSheet } from "./Sheets";
import { Timeline } from "./Timeline";
import { askLinked, askWindow, hubClient, linkedKeeps, useAsk, useTimeData, type Linked, type TimeClient } from "./data";
import { loadFilters, queryOf, saveFilters, type Filters } from "./filters";
import { NO_NAMES, ROLE_WORD, fmtDur, isMissingEmpty, missing, missingSentence, type Names } from "./format";
import { buildModel } from "./model";
import type { Category, Span, ThreadWindowOutput } from "./types";
import s from "./Time.module.css";

type TabId = "timeline" | "breakdown" | "insights";

export interface TimeScreenProps {
  /** The order to open on (its timeline); none opens the fleet's breakdown. */
  readonly order?: string;
  /** What ids are called on screen, from the live store. */
  readonly names?: Names;
  /** Defaults to the hub through main. */
  readonly client?: TimeClient;
  /** Opens the order view, at a thread item when one is given (from a span's transcript). */
  readonly onOpenOrder?: (order: string, at?: { readonly threadId: string; readonly itemId: string }) => void;
  /** Opens a CI check's page in the browser. */
  readonly onOpenUrl?: (url: string) => void;
  /** Fixed "now" for fixtures and screenshots. */
  readonly now?: number;
  /** Filters to start from instead of the saved ones (fixtures). */
  readonly initialFilters?: Filters;
}

interface Highlight {
  readonly ids: ReadonlySet<number>;
  readonly title: string;
  readonly linked: Linked;
}

export function TimeScreen(props: TimeScreenProps) {
  const names = props.names ?? NO_NAMES;
  const [client] = useState<TimeClient>(() => props.client ?? hubClient());
  const [order, setOrder] = useState(props.order);
  const [filters, setFilters] = useState<Filters>(() => props.initialFilters ?? loadFilters());
  const [nowMs, setNow] = useState(() => props.now ?? Date.now());
  const [tab, setTab] = useState<TabId>(props.order !== undefined ? "timeline" : "breakdown");
  const [view, setView] = useState<readonly [number, number] | undefined>();
  const [highlight, setHighlight] = useState<Highlight | undefined>();
  const [linked, setLinked] = useState<Linked | undefined>();
  const [linkedAnswer, askLinkedSpans] = useAsk<Span[]>();
  const [windowAt, setWindowAt] = useState<Span | undefined>();
  const [windowAnswer, askThreadWindow] = useAsk<ThreadWindowOutput>();

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
  const data = useTimeData(client, query);
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
    setView(undefined);
    setHighlight(undefined);
    setTab(o !== undefined ? "timeline" : tab === "timeline" ? "breakdown" : tab);
    reaim();
  };

  /** "Show spans": on an order, its own timeline lit up; elsewhere the hub lists them in a sheet. */
  const showLinked = (l: Linked, ids?: readonly number[]) => {
    if (order !== undefined && model !== undefined) {
      const set = ids !== undefined && ids.length > 0 ? new Set(ids) : new Set(model.spans.filter((x) => linkedKeeps(l, x)).map((x) => x.id));
      setHighlight({ ids: set, title: l.title, linked: l });
      setTab("timeline");
      return;
    }
    setLinked(l);
    askLinkedSpans(askLinked(client, query, l));
  };

  const listHighlight = () => {
    if (highlight === undefined) return;
    setLinked(highlight.linked);
    askLinkedSpans(askLinked(client, query, highlight.linked));
  };

  /** A click on one span: a check's page, else its transcript at that item. */
  const openSpan = (span: Span) => {
    if (span.extra?.url !== undefined) {
      props.onOpenUrl?.(span.extra.url);
      return;
    }
    if (span.machineId === undefined || span.threadId === undefined || span.itemId === undefined) return;
    setWindowAt(span);
    askThreadWindow(askWindow(client, { machineId: span.machineId, threadId: span.threadId, itemId: span.itemId }));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Esc closes the innermost thing: the sheets close themselves, then the highlight, then the zoom.
    if (e.key !== "Escape" || linked !== undefined || windowAt !== undefined) return;
    if (highlight !== undefined) setHighlight(undefined);
    else if (view !== undefined) setView(undefined);
    else return;
    e.stopPropagation();
  };

  const orderInfo = order === undefined ? undefined : names.orders.get(order);
  const title = order === undefined ? "Where the time went" : (orderInfo?.title ?? "This order");
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
    <div className={cx(s.screen)} data-screen="time" onKeyDown={onKeyDown}>
      <header className={cx(s.head)}>
        {order !== undefined && props.onOpenOrder !== undefined ? (
          <Button variant="ghost" onClick={() => props.onOpenOrder?.(order)}>
            ‹ Order
          </Button>
        ) : null}
        {orderInfo !== undefined ? (
          <Text tone="quiet" className={cx(s.noShrink)}>
            {orderInfo.project} ›
          </Text>
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
              <Truncate size="xs">{`${highlight.ids.size} span${highlight.ids.size === 1 ? "" : "s"} lit: ${highlight.title.replace(/`/gu, "")}`}</Truncate>
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
            <Text as="p" size="xs" tone="quiet" className={cx(s.loadingLine)}>
              Loading spans… {data.spans.length} so far
            </Text>
          ) : null}
          {model !== undefined ? (
            <Timeline model={model} names={names} nowMs={nowMs} view={view} onView={setView} lit={highlight?.ids} onSpan={openSpan} />
          ) : (
            <div className={cx(s.empty)} data-screen="time.timeline.empty">
              <Text tone={data.spansError !== undefined ? "danger" : "quiet"}>
                {data.spansError ??
                  (data.spansDone
                    ? "No spans for this order yet. Spans start when its first agent starts; a machine running an older fleetd records none."
                    : "Loading this order's spans…")}
              </Text>
            </div>
          )}
        </TabPanel>
        <TabPanel value="breakdown" className={cx(s.panel)}>
          {data.breakdown === undefined ? (
            <div className={cx(s.empty)}>
              <Text tone="quiet">Asking the hub where the time went…</Text>
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
            <div className={cx(s.empty)}>
              <Text tone="quiet">Running the hub&apos;s rules over this period…</Text>
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
          orderOf !== undefined && props.onOpenOrder !== undefined && windowAt?.threadId !== undefined && windowAt.itemId !== undefined
            ? () => props.onOpenOrder?.(orderOf, { threadId: windowAt.threadId ?? "", itemId: windowAt.itemId ?? "" })
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
