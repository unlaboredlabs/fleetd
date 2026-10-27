// Call-based reads through TanStack Query, wired to the store: main's frames feed the store, events invalidate the
// reads they make stale, and results the store holds by entity (board, order) are folded into it.
import { hashKey, QueryClient, type Query, type QueryKey } from "@tanstack/react-query";
import {
  typedCall,
  type Call,
  type RawCall,
  type ToolInput,
  type ToolName,
  type ToolOutput,
} from "../../../shared/contracts";
import type { HubError, HubFrame } from "../../../shared/hub";
import type { ChatScope, OrderFocus } from "../../../shared/ipc";
import { keepCache, type CacheIo } from "./cache";
import { createChatActions, refOf, type ChatActions } from "./chat-layer";
import { effectsOf, matches, type Invalidation } from "./effects";
import { applyFrame, applySlots, createDataStore, ingest, type DataStore } from "./store";

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
  chat(project: ChatScope | null): Promise<void>;
  focus(workstreamId: OrderFocus | null): Promise<void>;
  /** Dial the hub now instead of at the next retry. */
  retryNow?(): Promise<void>;
  /** The disk cache (cache.ts); without it the layer keeps only what this window saw. */
  readonly cache?: CacheIo;
}

/** How long events coalesce before their refetches go out: a burst (a merge, a batch) costs one round. */
const INVALIDATE_EVERY_MS = 100;
/**
 * Reads that coalesce longer: work_list reads every project on the repo, and agents starting, finishing and opening
 * PRs fire task and change events in runs, so a run of them costs one read every two seconds at most.
 */
const SLOW_EVERY_MS: Partial<Record<ToolName, number>> = { work_list: 2_000 };

export interface DataLayer {
  readonly store: DataStore;
  readonly queryClient: QueryClient;
  readonly call: Call;
  /** Query options for `tool(input)`; screens pass them to useQuery (see `useToolQuery`). */
  toolQuery<T extends ToolName>(
    tool: T,
    input: ToolInput<T>,
  ): { queryKey: QueryKey; queryFn: () => Promise<ToolOutput<T>> };
  /**
   * Reads are numbered as they go out: `readsStarted()` is the last number handed out, and `readOf(tool, input)` the
   * number of the read whose answer the cache holds. A read numbered above a mark taken after a write landed went
   * out after the hub took the write, so what it says includes it.
   */
  readonly readsStarted: () => number;
  readonly readOf: <T extends ToolName>(tool: T, input: ToolInput<T>) => number | undefined;
  /** The lead chats: history, and the person's messages (chat-layer.ts). */
  readonly chat: ChatActions;
  /** Reconnect now, not at the next retry (the offline banner's Retry now). */
  retryNow(): void;
  /** Read the hub's snapshot again (the projects, the machines) on the live link, as a project.added event does. */
  resync(): void;
  /** The order whose lanes stream their text, or null. Main always subscribes to every open order's lanes. */
  focus(workstreamId: OrderFocus | null): void;
  /** Start applying main's frames; returns the stop. */
  start(): () => void;
}

export const createDataLayer = (hub: HubApi, now: () => number = Date.now): DataLayer => {
  const store = createDataStore();
  const typed = typedCall(hub.call);
  const chat = createChatActions(store, typed, (key) => void hub.chat(key === null ? null : refOf(key)), now);
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

  let reads = 0;
  /** By query hash: the newest read that answered. A read a reset made moot can land after; it never wins. */
  const answeredBy = new Map<string, number>();
  const toolQuery = <T extends ToolName>(tool: T, input: ToolInput<T>) => {
    const queryKey = callKey(tool, input);
    return {
      queryKey,
      queryFn: async (): Promise<ToolOutput<T>> => {
        const read = ++reads;
        const outcome = await call(tool, input);
        if (!outcome.ok) throw new CallError(outcome.error);
        const hash = hashKey(queryKey);
        answeredBy.set(hash, Math.max(answeredBy.get(hash) ?? 0, read));
        return outcome.output;
      },
    };
  };
  const readOf = <T extends ToolName>(tool: T, input: ToolInput<T>): number | undefined => answeredBy.get(hashKey(callKey(tool, input)));

  // Queries an event made stale while their call was in flight. That answer predates the event, so it is not folded
  // into the store, and the query runs once more when it lands: at most one call per read in flight, none cancelled
  // (a steady event stream would otherwise keep restarting a slow call), and never an older answer over a newer one.
  const dirty = new Set<string>();

  // One batch per wait: the first event starts its timer, and later ones join the batch until it goes out.
  const pending = new Map<number, Invalidation[]>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const later = (everyMs: number, invalidations: readonly Invalidation[]): void => {
    if (invalidations.length === 0) return;
    pending.set(everyMs, [...(pending.get(everyMs) ?? []), ...invalidations]);
    if (timers.has(everyMs)) return;
    timers.set(
      everyMs,
      setTimeout(() => {
        timers.delete(everyMs);
        const batch = pending.get(everyMs) ?? [];
        pending.delete(everyMs);
        invalidateNow(batch);
      }, everyMs),
    );
  };

  const reset = () => {
    dirty.clear();
    pending.clear();
    void queryClient.resetQueries();
  };

  // The store takes call results only from what the query cache kept: a cancelled or superseded fetch never lands.
  const onCache: Parameters<ReturnType<QueryClient["getQueryCache"]>["subscribe"]>[0] = (e) => {
    if (e.type !== "updated") return;
    const q = e.query as Query<unknown, Error, unknown>;
    if (e.action.type === "error") {
      dirty.delete(q.queryHash);
      return;
    }
    if (e.action.type !== "success") return;
    if (dirty.delete(q.queryHash)) {
      void queryClient.invalidateQueries({ queryKey: q.queryKey, exact: true });
      return;
    }
    const [scope, tool, input] = q.queryKey;
    if (scope !== "call") return;
    store.setState((s) => ingest(s, { tool, input, output: q.state.data } as Parameters<typeof ingest>[1]));
  };


  /** Refetch what `batch` names; a read already in flight is marked dirty, so its (older) answer never lands. */
  function invalidateNow(batch: readonly Invalidation[]): void {
    const stale = (q: Query): boolean => {
      const [scope, tool, input] = q.queryKey;
      return scope === "call" && batch.some((i) => i.tool === tool && matches(input, i.where));
    };
    const inFlight = (q: Query): boolean => q.state.fetchStatus === "fetching";
    for (const q of queryClient.getQueryCache().findAll({ predicate: (q) => stale(q) && inFlight(q) })) dirty.add(q.queryHash);
    void queryClient.invalidateQueries({ predicate: (q) => stale(q) && !inFlight(q) });
  }

  // A saved max agents shows at once, before the next live frame's slots; a hub update's progress before its event.
  const afterWrite = (tool: ToolName, output: unknown): void => {
    if (tool === "cap_set") store.setState(applySlots(store.getState(), (output as ToolOutput<"cap_set">).slots));
  };

  const call: Call = async (tool, input, options) => {
    const outcome = await typed(tool, input, options);
    if (outcome.ok) afterWrite(tool, outcome.output);
    return outcome;
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
    const slow = new Map<number, Invalidation[]>();
    for (const i of invalidate) {
      const every = SLOW_EVERY_MS[i.tool] ?? INVALIDATE_EVERY_MS;
      slow.set(every, [...(slow.get(every) ?? []), i]);
    }
    for (const [every, batch] of slow) later(every, batch);
  };

  return {
    store,
    queryClient,
    call,
    toolQuery,
    readsStarted: () => reads,
    readOf,
    chat: chat.actions,
    retryNow: () => void hub.retryNow?.(),
    resync: () => void hub.resync(),
    focus: (workstreamId) => void hub.focus(workstreamId),
    start: () => {
      const stopChat = store.subscribe((s, prev) => chat.onState(prev, s));
      const stopKeep = hub.cache === undefined ? () => undefined : keepCache(store, hub.cache, chat.focus, now);
      const stopCache = queryClient.getQueryCache().subscribe(onCache);
      const stop = hub.subscribe(onFrame);
      return () => {
        stopChat();
        stopKeep();
        stop();
        stopCache();
        for (const t of timers.values()) clearTimeout(t);
      };
    },
  };
};
