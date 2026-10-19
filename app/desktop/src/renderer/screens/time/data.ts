// What the time inspector asks the hub, and how the answers land. Nothing here polls: a running order's open view
// asks again only on the hub events that change it (spec §7), and stops when the view closes.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CallOutcome, HubEvent } from "../../../shared/hub";
import type { TimeClient } from "./client";
import { spansInput, type TimeQuery } from "./filters";
export type { TimeClient };
import type {
  Coverage,
  InsightRule,
  Span,
  SpanKind,
  ThreadWindowInput,
  ThreadWindowOutput,
  TimeBreakdownOutput,
  TimeInsightsOutput,
  TimeSpansOutput,
} from "./types";


export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A shallow shape check before the answer is trusted: the arrays the screens iterate must be arrays. */
const shaped = <T>(output: unknown, arrays: readonly string[], objects: readonly string[] = []): Answer<T> =>
  isObject(output) && arrays.every((k) => Array.isArray(output[k])) && objects.every((k) => isObject(output[k]))
    ? { ok: true, value: output as T }
    : { ok: false, error: "Unexpected answer from the hub." };

export const parseBreakdown = (o: unknown) =>
  shaped<TimeBreakdownOutput>(o, ["byCategory", "topCommands", "repeated", "ciChecks"], ["humanWait", "coverage"]);
export const parseInsights = (o: unknown) => shaped<TimeInsightsOutput>(o, ["insights"]);
export const parseSpans = (o: unknown) => shaped<TimeSpansOutput>(o, ["spans"], ["coverage"]);
export const parseWindow = (o: unknown) => shaped<ThreadWindowOutput>(o, ["items"]);

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
export const errorText = (outcome: Extract<CallOutcome, { ok: false }>): string => {
  const said = SAID[outcome.error.code] ?? "The hub couldn't answer.";
  return outcome.error.fix === undefined ? said : `${said} ${outcome.error.fix}`;
};

const call = async <T>(client: TimeClient, tool: string, input: unknown, parse: (o: unknown) => Answer<T>): Promise<Answer<T>> => {
  const outcome = await client.call(tool, input);
  return outcome.ok ? parse(outcome.output) : { ok: false, error: errorText(outcome) };
};

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

/** Whether a hub event can change an order's time: its tasks, PRs, asks, or a lead wake that served it. */
export const eventConcerns = (event: HubEvent, order: string): boolean => {
  const kind = event.type;
  if (!CONCERNS.some((p) => kind.startsWith(p)) && kind !== "lead.woken" && kind !== "pr.merged") return false;
  const data = event["data"];
  if (!isObject(data)) return false;
  if (data["workstreamId"] === order) return true;
  const ids = data["workstreamIds"];
  return Array.isArray(ids) && ids.includes(order);
};

export interface TimeData {
  readonly breakdown?: Answer<TimeBreakdownOutput>;
  readonly insights?: Answer<TimeInsightsOutput>;
  /** The open order's spans, by id; pages keep arriving until `spansDone`. */
  readonly spans: readonly Span[];
  readonly spansDone: boolean;
  readonly spansError?: string;
  /** What the hub knows is missing from those spans. */
  readonly spansCoverage?: Coverage;
}

const EMPTY: TimeData = { spans: [], spansDone: false };

/** The breakdown, insights and (for an order) every span of a query, refetched on the events that concern it. */
export const useTimeData = (client: TimeClient, query: TimeQuery): TimeData => {
  const key = JSON.stringify(query);
  // Answers are kept with the query they answer, so a new query shows nothing stale while it is asked.
  const [state, setState] = useState<{ readonly key: string; readonly data: TimeData }>({ key, data: EMPTY });
  const spansRef = useRef<readonly Span[]>([]);

  useEffect(() => {
    const flags = { live: true, fetching: false, again: false };
    const askedAgain = () => flags.again;
    spansRef.current = [];
    const q = JSON.parse(key) as TimeQuery;
    const set = (f: (d: TimeData) => TimeData) => {
      if (flags.live) setState((prev) => ({ key, data: f(prev.key === key ? prev.data : EMPTY) }));
    };
    const pageFrom = async (after: number | undefined) => {
      for (;;) {
        const page = await call(client, "time_spans", spansInput(q, after), parseSpans);
        if (!flags.live) return;
        if (!page.ok) {
          set((d) => ({ ...d, spansError: page.error, spansDone: true }));
          return;
        }
        spansRef.current = mergeSpans(spansRef.current, page.value.spans);
        const spans = spansRef.current;
        const done = page.value.nextAfterId === undefined;
        set((d) => ({ ...d, spans, spansCoverage: page.value.coverage, spansDone: done }));
        if (done) return;
        after = page.value.nextAfterId;
      }
    };
    const fetchAll = async (after: number | undefined) => {
      // One refetch in flight; events that land meanwhile fold into one more.
      if (flags.fetching) {
        flags.again = true;
        return;
      }
      flags.fetching = true;
      do {
        flags.again = false;
        const work: Promise<void>[] = [
          call(client, "time_breakdown", q.breakdown, parseBreakdown).then((breakdown) => set((d) => ({ ...d, breakdown }))),
          call(client, "time_insights", q.insights, parseInsights).then((insights) => set((d) => ({ ...d, insights }))),
        ];
        if (q.spans) work.push(pageFrom(after));
        await Promise.all(work);
        after = resumeAfter(spansRef.current);
        // Read through a call: an event during the awaits above may have set it.
      } while (askedAgain() && flags.live);
      flags.fetching = false;
    };
    void fetchAll(undefined);
    const order = q.scope.kind === "order" ? q.scope.workstreamId : undefined;
    const unsubscribe =
      order === undefined
        ? undefined
        : client.subscribe((frame) => {
            if (frame.t === "event" && eventConcerns(frame.event, order)) void fetchAll(resumeAfter(spansRef.current));
          });
    return () => {
      flags.live = false;
      unsubscribe?.();
    };
  }, [client, key]);

  return state.key === key ? state.data : EMPTY;
};

/** The spans a finding or a breakdown row links to: by rule or kind on the hub, narrowed here to a label or check. */
export interface Linked {
  readonly title: string;
  readonly rule?: InsightRule;
  readonly kinds?: readonly SpanKind[];
  readonly label?: string;
  readonly check?: string;
}

export const linkedKeeps = (l: Linked, s: Span): boolean =>
  (l.kinds === undefined || l.kinds.length === 0 || l.kinds.includes(s.kind)) &&
  (l.label === undefined || s.label === l.label) &&
  (l.check === undefined || s.extra?.check === l.check);

/** One ask, answered later; `undefined` while it is out. */
export const useAsk = <T>(): [Answer<T> | undefined, (p: Promise<Answer<T>> | undefined) => void] => {
  const [answer, setAnswer] = useState<Answer<T> | undefined>();
  const gen = useRef(0);
  const ask = useCallback((p: Promise<Answer<T>> | undefined) => {
    gen.current += 1;
    const g = gen.current;
    setAnswer(undefined);
    void p?.then((a) => {
      if (g === gen.current) setAnswer(a);
    });
  }, []);
  return [answer, ask];
};

export const askLinked = (client: TimeClient, q: TimeQuery, l: Linked): Promise<Answer<Span[]>> =>
  call(
    client,
    "time_spans",
    {
      ...spansInput(q, undefined),
      ...(l.rule === undefined ? {} : { rule: l.rule }),
      ...(l.kinds === undefined || l.kinds.length === 0 ? {} : { kinds: l.kinds }),
    },
    parseSpans,
  ).then((a) => (a.ok ? { ok: true, value: a.value.spans.filter((s) => linkedKeeps(l, s)) } : a));

export const askWindow = (client: TimeClient, input: ThreadWindowInput): Promise<Answer<ThreadWindowOutput>> =>
  call(client, "thread_window", { before: 10, after: 10, ...input }, parseWindow);

/** The app's own client: everything goes through main (the renderer has no network). */
export const hubClient = (): TimeClient => ({
  call: (tool, input) => window.fleetd.hub.call(tool, input),
  subscribe: (listener) => window.fleetd.hub.subscribe(listener),
});
