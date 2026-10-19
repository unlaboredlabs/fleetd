// Call-based reads through TanStack Query, wired to the store: main's frames feed the store, events invalidate the
// reads they make stale, and results the store holds by entity (board, order, asks) are folded into it.
import { QueryClient, type Query, type QueryKey } from "@tanstack/react-query";
import { typedCall, type Call, type RawCall, type ToolInput, type ToolName, type ToolOutput } from "../../../shared/contracts";
import type { HubError, HubFrame } from "../../../shared/hub";
import { effectsOf, matches, type Invalidation } from "./effects";
import { applyFrame, createDataStore, ingest, type DataStore } from "./store";

export class CallError extends Error {
  constructor(readonly error: HubError) {
    super(error.message);
    this.name = "CallError";
  }
}

/** The hub refused the input or the key: asking again won't help. */
const FINAL_CODES = new Set(["invalid", "forbidden", "not_found"]);

export const callKey = <T extends ToolName>(tool: T, input: ToolInput<T>) => ["call", tool, input] as const;

/** The slice of `window.fleetd.hub` the data layer uses. */
export interface HubApi {
  readonly call: RawCall;
  subscribe(listener: (frame: HubFrame) => void): () => void;
  resync(): Promise<void>;
}

/** How long events coalesce before their refetches go out: a burst (a merge, a batch) costs one round. */
const INVALIDATE_EVERY_MS = 100;

export interface DataLayer {
  readonly store: DataStore;
  readonly queryClient: QueryClient;
  readonly call: Call;
  /** Query options for `tool(input)`; screens pass them to useQuery (see `useToolQuery`). */
  toolQuery<T extends ToolName>(
    tool: T,
    input: ToolInput<T>,
  ): { queryKey: QueryKey; queryFn: () => Promise<ToolOutput<T>> };
  /** Start applying main's frames; returns the stop. */
  start(): () => void;
}

export const createDataLayer = (hub: HubApi, now: () => number = Date.now): DataLayer => {
  const store = createDataStore();
  const call = typedCall(hub.call);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Events say when a read is stale; nothing goes stale by time, and the window regaining focus is the live
        // subscription's business, not a refetch storm.
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: (failures, error) => !(error instanceof CallError && FINAL_CODES.has(error.error.code)) && failures < 2,
      },
    },
  });

  const toolQuery = <T extends ToolName>(tool: T, input: ToolInput<T>) => ({
    queryKey: callKey(tool, input),
    queryFn: async (): Promise<ToolOutput<T>> => {
      const outcome = await call(tool, input);
      if (!outcome.ok) throw new CallError(outcome.error);
      return outcome.output;
    },
  });

  // Queries an event made stale while their call was in flight. That answer predates the event, so it is not folded
  // into the store, and the query runs once more when it lands: at most one call per read in flight, none cancelled
  // (a steady event stream would otherwise keep restarting a slow call), and never an older answer over a newer one.
  const dirty = new Set<string>();

  const reset = () => {
    dirty.clear();
    pending = [];
    void queryClient.resetQueries();
  };

  // The store takes call results only from what the query cache kept: a cancelled or superseded fetch never lands.
  const onCache: Parameters<ReturnType<QueryClient["getQueryCache"]>["subscribe"]>[0] = (e) => {
    if (e.type !== "updated") return;
    const q = e.query as Query<unknown, Error, unknown>;
    if (e.action.type === "error") dirty.delete(q.queryHash);
    if (e.action.type !== "success") return;
    if (dirty.delete(q.queryHash)) {
      void queryClient.invalidateQueries({ queryKey: q.queryKey, exact: true });
      return;
    }
    const [scope, tool, input] = q.queryKey;
    if (scope !== "call") return;
    store.setState((s) => ingest(s, { tool, input, output: q.state.data } as Parameters<typeof ingest>[1]));
  };

  let pending: Invalidation[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const batch = pending;
    pending = [];
    const stale = (q: Query): boolean => {
      const [scope, tool, input] = q.queryKey;
      return scope === "call" && batch.some((i) => i.tool === tool && matches(input, i.where));
    };
    const inFlight = (q: Query): boolean => q.state.fetchStatus === "fetching";
    for (const q of queryClient.getQueryCache().findAll({ predicate: (q) => stale(q) && inFlight(q) })) dirty.add(q.queryHash);
    void queryClient.invalidateQueries({ predicate: (q) => stale(q) && !inFlight(q) });
  };

  const onFrame = (frame: HubFrame) => {
    const prev = store.getState();
    const [next, effects] = applyFrame(prev, frame, now());
    // A repeated event (the stream resumed past it) changes nothing and refetches nothing.
    if (next === prev) return;
    store.setState(next, true);
    // A new snapshot, or the link dropping: every cached answer describes a connection that is gone. Reset drops it
    // (screens show skeletons, not old data as live); reads run again once the connection is fresh.
    if (effects.refetchAll === true || (prev.fresh && !next.fresh)) {
      reset();
      return;
    }
    if (frame.t !== "event") return;
    const { invalidate, resync } = effectsOf(frame.event, prev.machines);
    if (resync) void hub.resync();
    if (invalidate.length === 0) return;
    pending.push(...invalidate);
    timer ??= setTimeout(flush, INVALIDATE_EVERY_MS);
  };

  return {
    store,
    queryClient,
    call,
    toolQuery,
    start: () => {
      const stopCache = queryClient.getQueryCache().subscribe(onCache);
      const stop = hub.subscribe(onFrame);
      return () => {
        stop();
        stopCache();
        if (timer !== undefined) clearTimeout(timer);
      };
    },
  };
};
