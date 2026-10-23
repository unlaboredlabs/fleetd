// What the time inspector reads, all through the app's one data layer (src/renderer/src/data): its queries wait for
// a fresh connection and refetch when an event makes them stale (data/effects.ts names the time_* reads), so this
// screen neither subscribes nor polls. Undefined means "not answered yet": the screen shows a skeleton.
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { CallError } from "../../src/data/queries";
import { selectOrderEvents } from "../../src/data/selectors";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import type { HubError, HubEvent } from "../../../shared/hub";
import { spansInput, type TimeQuery } from "./filters";
import type { TaskProfile } from "../../../shared/contracts";
import { NO_NAMES, numberCollisions, type Lane, type Names } from "./format";
import type { DataState } from "../../src/data/store";
import type { AgentRole, Coverage, InsightRule, Span, SpanKind, ThreadWindowOutput, TimeBreakdownOutput, TimeInsightsOutput } from "./types";

export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const SAID: Record<string, string> = {
  offline: "Not connected to the hub. The figures come back when it reconnects.",
  disconnected: "Not connected to the hub. The figures come back when it reconnects.",
  timeout: "The hub took too long to answer. Try a shorter range.",
  forbidden: "This app's key can't read time data on this hub.",
  not_found: "The hub has no time data for this yet.",
};

/**
 * What a failed call says on screen: a sentence for the code, plus the hub's own fix when it gave one. The raw
 * message (tool names, inputs) is for logs, never the screen.
 */
export const errorText = (error: HubError): string => {
  const said = SAID[error.code] ?? "The hub couldn't answer.";
  return error.fix === undefined ? said : `${said} ${error.fix}`;
};

const failure = (error: unknown): Answer<never> => ({
  ok: false,
  error: error instanceof CallError ? errorText(error.error) : "The hub couldn't answer.",
});

/** A query's state as the screens read it: undefined while it is out. */
const answerOf = <T>(q: { data?: T | undefined; error: unknown; isError: boolean }): Answer<T> | undefined =>
  q.isError ? failure(q.error) : q.data === undefined ? undefined : { ok: true, value: q.data };

/** Merges a page into spans kept sorted by id; a span sent again (it closed since) replaces the old copy. */
export const mergeSpans = (spans: readonly Span[], page: readonly Span[]): Span[] => {
  const out = spans.slice();
  for (const span of page) {
    let lo = 0;
    let hi = out.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((out[mid]?.id ?? 0) < span.id) lo = mid + 1;
      else hi = mid;
    }
    if (out[lo]?.id === span.id) out[lo] = span;
    else out.splice(lo, 0, span);
  }
  return out;
};

/** Where to resume after an event: just before the oldest span still open, so those come back with their end. */
export const resumeAfter = (spans: readonly Span[]): number | undefined => {
  let open: number | undefined;
  for (const s of spans) if (s.endMs === undefined && (open === undefined || s.id < open)) open = s.id;
  return open !== undefined ? open - 1 : spans.at(-1)?.id;
};

const CONCERNS = ["task.", "change.", "ask.", "workstream."];

/** Whether an event about an order can add or close its spans (the order's events are already filtered by order). */
export const changesSpans = (event: HubEvent): boolean =>
  CONCERNS.some((p) => event.type.startsWith(p)) || event.type === "lead.woken" || event.type === "pr.merged";

const noEvents: readonly HubEvent[] = [];
const noOrderEvents = () => noEvents;

export interface TimeData {
  readonly breakdown?: Answer<TimeBreakdownOutput> | undefined;
  readonly insights?: Answer<TimeInsightsOutput> | undefined;
  /** The open order's spans, by id; pages keep arriving until `spansDone`. */
  readonly spans: readonly Span[];
  readonly spansDone: boolean;
  readonly spansError?: string | undefined;
  /** What the hub knows is missing from those spans. */
  readonly spansCoverage?: Coverage | undefined;
}

const noSpans: readonly Span[] = [];

/** The breakdown, the insights and (for an order) every span, page by page. */
export const useTimeData = (query: TimeQuery): TimeData => {
  const layer = useDataLayer();
  const fresh = useData((s) => s.fresh);
  const generation = useData((s) => s.generation);
  const breakdown = useToolQuery("time_breakdown", query.breakdown);
  const insights = useToolQuery("time_insights", query.insights);
  const base = spansInput(query, undefined);
  const order = query.scope.kind === "order" ? query.scope.workstreamId : undefined;
  // An order's spans come 500 a time by `afterId`. Kept out of the data layer's "call" keys on purpose: an event
  // there refetches a query whole, which for ~30 pages would mean ~30 calls per event. A snapshot still resets it.
  const pages = useInfiniteQuery({
    queryKey: ["time_spans", base],
    queryFn: async ({ pageParam }) => {
      const outcome = await layer.call("time_spans", pageParam === undefined ? base : { ...base, afterId: pageParam });
      if (!outcome.ok) throw new CallError(outcome.error);
      return outcome.output;
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextAfterId,
    enabled: fresh && query.spans,
  });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = pages;
  // Keyed on the page count too: a fast answer can start and finish a fetch between two commits, so the fetching
  // flag alone may never be seen to change.
  const pageCount = pages.data?.pages.length ?? 0;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage, pageCount]);
  const data = pages.data;
  const loaded = useMemo(() => data?.pages.reduce<Span[]>((all, p) => mergeSpans(all, p.spans), []) ?? noSpans, [data]);
  const done = data !== undefined && !hasNextPage;

  // Then, as the order's events arrive, only what changed: from just before the oldest open span (GPUI's rule).
  // Kept with the key it belongs to, so a new query or a new snapshot starts from the pages again.
  // Keyed on the connection too: when the link drops the pages reset, and spans topped up over the dead link must
  // not be drawn on their own; a snapshot (a new generation) starts over as well.
  const key = `${JSON.stringify(base)}#${generation}#${String(fresh)}`;
  const [newer, setNewer] = useState<{ readonly key: string; readonly spans: readonly Span[] }>({ key, spans: noSpans });
  const extra = newer.key === key ? newer.spans : noSpans;
  const spans = useMemo(() => (extra.length === 0 ? loaded : mergeSpans(loaded, extra)), [loaded, extra]);
  const events = useData(order === undefined ? noOrderEvents : selectOrderEvents(order));
  const seen = useRef<{ key: string; event: HubEvent | undefined }>({ key, event: events.at(-1) });
  const latest = useRef(spans);
  useEffect(() => {
    latest.current = spans;
  });
  const busy = useRef({ running: false, again: false });
  useEffect(() => {
    if (seen.current.key !== key) seen.current = { key, event: events.at(-1) };
    const from = seen.current.event === undefined ? 0 : events.lastIndexOf(seen.current.event) + 1;
    const fresh = events.slice(from);
    seen.current = { key, event: events.at(-1) };
    if (!done || !query.spans || !fresh.some(changesSpans)) return;
    const flags = busy.current;
    if (flags.running) {
      flags.again = true;
      return;
    }
    flags.running = true;
    const askedAgain = () => flags.again;
    void (async () => {
      do {
        flags.again = false;
        let after = resumeAfter(latest.current);
        let got: Span[] = [];
        for (;;) {
          const outcome = await layer.call("time_spans", after === undefined ? base : { ...base, afterId: after });
          if (!outcome.ok) break;
          got = mergeSpans(got, outcome.output.spans);
          if (outcome.output.nextAfterId === undefined) break;
          after = outcome.output.nextAfterId;
        }
        setNewer((prev) => ({ key, spans: mergeSpans(prev.key === key ? prev.spans : noSpans, got) }));
      } while (askedAgain());
      flags.running = false;
    })();
    // `base` is in `key`; the pages being done and the events are what start a refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, done, key]);

  return {
    breakdown: answerOf(breakdown),
    insights: answerOf(insights),
    spans,
    spansDone: isError || done,
    spansError: isError ? (failure(pages.error) as { error: string }).error : undefined,
    spansCoverage: data?.pages.at(-1)?.coverage,
  };
};

/** The spans a finding or a breakdown row links to: by rule or kind on the hub, narrowed here to a label or check. */
export interface Linked {
  readonly title: string;
  readonly rule?: InsightRule;
  readonly kinds?: readonly SpanKind[];
  readonly label?: string;
  readonly check?: string;
  /** Spans already lit on the timeline: listed from here, never asked again by rule or kind. */
  readonly ids?: ReadonlySet<number>;
}

export const linkedKeeps = (l: Linked, s: Span): boolean =>
  (l.kinds === undefined || l.kinds.length === 0 || l.kinds.includes(s.kind)) &&
  (l.label === undefined || s.label === l.label) &&
  (l.check === undefined || s.extra?.check === l.check);

/** The spans a highlight lit, oldest first: what "List them" shows, never a fresh query that could differ. */
export const litSpans = (spans: readonly Span[], ids: ReadonlySet<number>): Span[] =>
  spans.filter((s) => ids.has(s.id)).sort((a, b) => a.startMs - b.startMs || a.id - b.id);

/** The linked spans' list: the lit ones from `local`, else the hub's first page (500) for the rule or kinds. */
export const useLinked = (query: TimeQuery, linked: Linked | undefined, local: readonly Span[]): Answer<Span[]> | undefined => {
  const input = {
    ...spansInput(query, undefined),
    ...(linked?.rule === undefined ? {} : { rule: linked.rule }),
    ...(linked?.kinds === undefined || linked.kinds.length === 0 ? {} : { kinds: [...linked.kinds] }),
  };
  const hub = useToolQuery("time_spans", input, { enabled: linked !== undefined && linked.ids === undefined });
  if (linked === undefined) return undefined;
  if (linked.ids !== undefined) return { ok: true, value: litSpans(local, linked.ids) };
  const a = answerOf(hub);
  return a?.ok === true ? { ok: true, value: a.value.spans.filter((s) => linkedKeeps(linked, s)) } : a;
};

/** The transcript around one span's item; undefined while asked, or when no span is open. */
export const useWindow = (span: Span | undefined): Answer<ThreadWindowOutput> | undefined => {
  const input = { machineId: span?.machineId ?? "", threadId: span?.threadId ?? "", itemId: span?.itemId ?? "", before: 10, after: 10 };
  const q = useToolQuery("thread_window", input, { enabled: span?.machineId !== undefined && span.threadId !== undefined && span.itemId !== undefined });
  return span === undefined ? undefined : answerOf(q);
};

export type NamesInput = Pick<DataState, "fresh" | "orders" | "details" | "projects" | "machines">;

/** What ids are called on screen, from the store: lanes by role, task and title, PRs by number, orders by title. */
export const namesOf = (s: NamesInput): Names => {
  if (!s.fresh) return NO_NAMES;
  const seen = new Map<string, Lane & { startedAt?: string }>();
  const leads = new Set<string>();
  const changes = new Map<string, number>();
  const orders = new Map<string, { title: string; project: string; ref: { machineId: string; projectId: string } }>();
  const lane = (l: { role: AgentRole; title: string; model?: string | undefined; profile?: TaskProfile | undefined; laneId: string; startedAt?: string | undefined; threadRef?: { threadId: string } | undefined }) => {
    if (l.threadRef === undefined) return;
    seen.set(l.threadRef.threadId, {
      role: l.role,
      title: l.title,
      laneId: l.laneId,
      ...(l.model === undefined ? {} : { model: l.model }),
      ...(l.profile === undefined ? {} : { profile: l.profile }),
      ...(l.startedAt === undefined ? {} : { startedAt: l.startedAt }),
    });
    if (l.role === "lead") leads.add(l.threadRef.threadId);
  };
  const projects = Object.values(s.projects);
  const titleOf = (r: { machineId: string; projectId: string }) =>
    projects.find((p) => p.machineId === r.machineId && p.projectId === r.projectId)?.title ?? r.projectId;
  for (const card of Object.values(s.orders ?? {})) {
    orders.set(card.workstreamId, { title: card.title, project: titleOf(card.projectRef), ref: card.projectRef });
    card.lanes.forEach(lane);
    for (const pr of card.prs) changes.set(pr.changeId, pr.number);
  }
  for (const d of Object.values(s.details)) {
    d.doneLanes.forEach(lane);
    if (d.lead !== undefined) lane(d.lead);
  }
  return {
    threads: numberCollisions(seen),
    leads,
    changes,
    orders,
    projects: projects.map((p) => ({ machineId: p.machineId, projectId: p.projectId, title: p.title })),
    machines: Object.keys(s.machines),
  };
};

/** The names, kept stable until the store's orders, details, projects or machines change. */
export const useNames = (order: string | undefined): Names => {
  // An order's finished lanes and its lead come with order_get, which also folds them into the store.
  useToolQuery("order_get", { workstreamId: order ?? "" }, { enabled: order !== undefined });
  const fresh = useData((s) => s.fresh);
  const orders = useData((s) => s.orders);
  const details = useData((s) => s.details);
  const projects = useData((s) => s.projects);
  const machines = useData((s) => s.machines);
  return useMemo(() => namesOf({ fresh, orders, details, projects, machines }), [fresh, orders, details, projects, machines]);
};
