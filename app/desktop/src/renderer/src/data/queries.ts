// Call-based reads through TanStack Query, wired to the store: main's frames feed the store, events invalidate the
// reads they make stale, and results the store holds by entity (board, order, asks) are folded into it.
import { QueryClient, type Query, type QueryKey } from "@tanstack/react-query";
import {
  typedCall,
  type Call,
  type OrderCard,
  type RawCall,
  type ToolInput,
  type ToolName,
  type ToolOutput,
} from "../../../shared/contracts";
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

/** A finished order stays on the board this long after it finished (the GPUI board's hold). */
export const DONE_HOLD_MS = 10 * 60_000;
/** The refetch goes out this long after a hold ends, so the hub's `updatedAt >= since` has surely dropped it. */
const HOLD_MARGIN_MS = 1_000;

/**
 * When the board must be refetched so a finished order whose hold ran out leaves it: the earliest hold that ends
 * after `hubNowMs`, in hub time. Undefined when no finished order is held.
 */
export const boardRefreshAt = (
  orders: Readonly<Record<string, OrderCard>> | undefined,
  hubNowMs: number,
): number | undefined => {
  let next: number | undefined;
  for (const o of Object.values(orders ?? {})) {
    if (o.state !== "done") continue;
    const ends = Date.parse(o.updatedAt) + DONE_HOLD_MS;
    if (Number.isNaN(ends) || ends <= hubNowMs) continue;
    if (next === undefined || ends < next) next = ends;
  }
  return next;
};

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

  const hubNowMs = () => now() + (store.getState().live.skewMs ?? 0);

  // A board read without its own includeDoneSince holds finished orders for DONE_HOLD_MS. The window is taken when
  // the call goes out, not baked into the key, so every refetch (an event's, the hold timer's) uses the current one.
  const withDoneHold = <T extends ToolName>(tool: T, input: ToolInput<T>): ToolInput<T> => {
    if (tool !== "orders_board") return input;
    const board = input as ToolInput<"orders_board">;
    if (board.includeDoneSince !== undefined) return input;
    return { ...board, includeDoneSince: new Date(hubNowMs() - DONE_HOLD_MS).toISOString() };
  };

  const toolQuery = <T extends ToolName>(tool: T, input: ToolInput<T>) => ({
    queryKey: callKey(tool, input),
    queryFn: async (): Promise<ToolOutput<T>> => {
      const outcome = await call(tool, withDoneHold(tool, input));
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
      // One timer, for the next hold to end: no polling, and none at all while nothing finished is held.
      let hold: { at: number; timer: ReturnType<typeof setTimeout> } | undefined;
      const scheduleHold = () => {
        const at = boardRefreshAt(store.getState().orders, hubNowMs());
        if (at === hold?.at) return;
        if (hold !== undefined) clearTimeout(hold.timer);
        hold =
          at === undefined
            ? undefined
            : {
                at,
                timer: setTimeout(() => {
                  hold = undefined;
                  void queryClient.invalidateQueries({ queryKey: ["call", "orders_board"] });
                }, at - hubNowMs() + HOLD_MARGIN_MS),
              };
      };
      const stopHold = store.subscribe((s, prev) => {
        if (s.orders !== prev.orders) scheduleHold();
      });
      return () => {
        stop();
        stopCache();
        stopHold();
        if (hold !== undefined) clearTimeout(hold.timer);
        if (timer !== undefined) clearTimeout(timer);
      };
    },
  };
};
