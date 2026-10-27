// The data layer in React: one layer per hub (hubs.ts), read through selectors. `HubScope` puts one hub's layer under
// whatever it wraps, so a screen inside it reads and calls that hub and needs to know of no other.
import { hashKey, keepPreviousData, QueryClientProvider, useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ToolInput, ToolName, ToolOutput } from "../../../shared/contracts";
import { FIRST_HUB } from "../../../shared/hubs";
import type { HubSet, HubSetStore, HubView } from "./hubs";
import { callKey, type DataLayer } from "./queries";
import { selectLiveText, type LiveAgent } from "./selectors";
import type { DataState } from "./store";

const DataContext = createContext<DataLayer | undefined>(undefined);
const HubContext = createContext<HubView | undefined>(undefined);
const HubsContext = createContext<HubSetStore | undefined>(undefined);

/** One hub's layer, and what it is (its id, label and colour), for everything inside. */
export const HubScope = ({ hub, children }: { hub: HubView; children: ReactNode }) => (
  <HubContext.Provider value={hub}>
    <DataContext.Provider value={hub.layer}>
      <QueryClientProvider client={hub.layer.queryClient}>{children}</QueryClientProvider>
    </DataContext.Provider>
  </HubContext.Provider>
);

/** Every hub's layer, started by the set; the board each hub's sidebar marks need is read whatever is open. */
export const HubsProvider = ({ hubs, children }: { hubs: HubSetStore; children: ReactNode }) => {
  const list = useStore(hubs, (s) => s.hubs);
  return (
    <HubsContext.Provider value={hubs}>
      {list.map((hub) => (
        <HubScope key={hub.id} hub={hub}>
          <AlwaysOn />
        </HubScope>
      ))}
      {children}
    </HubsContext.Provider>
  );
};

/** One layer as the app's only hub: what a test, or a window with one hub, needs. */
export const DataProvider = ({ layer, children }: { layer: DataLayer; children: ReactNode }) => {
  useEffect(() => layer.start(), [layer]);
  const hubs = useMemo(() => createStore<HubSet>()(() => ({ hubs: [{ id: layer.hub, label: "", layer }] })), [layer]);
  const hub = hubs.getState().hubs[0];
  if (hub === undefined) return null;
  return (
    <HubsContext.Provider value={hubs}>
      <HubScope hub={hub}>
        <AlwaysOn />
        {children}
      </HubScope>
    </HubsContext.Provider>
  );
};

const wholeBoard = {};

/** The read the live strips and agent counts depend on (the board), kept loaded whatever screen is open. */
const AlwaysOn = () => {
  useToolQuery("orders_board", wholeBoard);
  return null;
};

/** The hub of what is on screen here: the screen's, or a sidebar group's. */
export const useHub = (): HubView => {
  const hub = useContext(HubContext);
  if (hub === undefined) throw new Error("useHub outside a HubScope");
  return hub;
};

const noHubs: readonly HubView[] = [];

/** Every hub, in sidebar order. */
export const useHubs = (): readonly HubView[] => {
  const hubs = useContext(HubsContext);
  return useSyncExternalStore(hubs?.subscribe ?? (() => () => undefined), () => hubs?.getState().hubs ?? noHubs);
};

/** The hub set itself, for code that reads every hub's layer outside render (the Dock badge, the palette). */
export const useHubSet = (): HubSetStore | undefined => useContext(HubsContext);

/** Whether to say which hub something is on: only once there are several. */
export const useSeveralHubs = (): boolean => useHubs().length > 1;

/** `FIRST_HUB`'s layer keeps its keys as they were; another hub's are prefixed with its id (seen marks, last project). */
export const hubKey = (hub: string, key: string): string => (hub === FIRST_HUB ? key : `${hub}:${key}`);

export const useDataLayer = (): DataLayer => {
  const layer = useContext(DataContext);
  if (layer === undefined) throw new Error("useDataLayer outside DataProvider");
  return layer;
};

/** Reads the store through a selector from ./selectors (memoized, so the value is stable between changes). */
export const useData = <T,>(selector: (s: DataState) => T): T => useStore(useDataLayer().store, selector);

/**
 * `tool(input)` as a query. It waits for a fresh connection (a call made before the resync would describe the
 * old one) and refetches when an event makes it stale. `keepPrevious` keeps the last input's answer on screen
 * while a new input's is on its way (`isPlaceholderData`), for a view that holds its frame across a filter change.
 */
export const useToolQuery = <T extends ToolName>(tool: T, input: ToolInput<T>, options?: { enabled?: boolean; keepPrevious?: boolean }) => {
  const layer = useDataLayer();
  const fresh = useStore(layer.store, (s) => s.fresh);
  return useQuery({
    ...layer.toolQuery(tool, input),
    enabled: fresh && (options?.enabled ?? true),
    ...(options?.keepPrevious === true ? { placeholderData: keepPreviousData } : {}),
  });
};

/**
 * `tool(input)` a page at a time, for reads too long for one answer (a PR's files): `next` gives the input fields
 * that ask for the page after `page` (its offset or cursor), undefined after the last. Pages load on
 * `fetchNextPage`, never by themselves.
 */
export const useToolPages = <T extends ToolName>(
  tool: T,
  input: ToolInput<T>,
  next: (page: ToolOutput<T>) => Partial<ToolInput<T>> | undefined,
  options?: { enabled?: boolean },
) => {
  const layer = useDataLayer();
  const fresh = useStore(layer.store, (s) => s.fresh);
  return useInfiniteQuery({
    queryKey: layer.toolQuery(tool, input).queryKey,
    queryFn: ({ pageParam }) => layer.toolQuery(tool, { ...(input as object), ...(pageParam as object) } as ToolInput<T>).queryFn(),
    initialPageParam: {} as Partial<ToolInput<T>>,
    getNextPageParam: next,
    enabled: fresh && (options?.enabled ?? true),
  });
};

/** `tool` for each of `inputs`, as one query each: a list whose length changes (the pages of a diff in view). */
export const useToolQueries = <T extends ToolName>(tool: T, inputs: readonly ToolInput<T>[]) => {
  const layer = useDataLayer();
  const fresh = useStore(layer.store, (s) => s.fresh);
  return useQueries({ queries: inputs.map((input) => ({ ...layer.toolQuery(tool, input), enabled: fresh })) });
};

const NO_THREAD = { machineId: "", threadId: "", limit: 40 } as const;

/**
 * One agent's work, read-only: its newest steps (agent_work, read again on its thread's events) and the message it
 * is writing now, which the live feed streams while this is mounted. Undefined steps while the first read is out.
 */
export const useAgentWork = (agent: LiveAgent | undefined) => {
  const layer = useDataLayer();
  const thread = agent?.row.threadRef;
  const input = thread === undefined ? NO_THREAD : { machineId: thread.machineId, threadId: thread.threadId, limit: 40 };
  const query = useToolQuery("agent_work", input, { enabled: thread !== undefined });
  const workstreamId = agent?.row.workstreamId;
  useEffect(() => {
    if (workstreamId === undefined) return;
    layer.focus(workstreamId);
    return () => layer.focus(null);
  }, [layer, workstreamId]);
  const streaming = useData(selectLiveText(agent?.row.laneId ?? ""));
  return { steps: query.data?.steps, running: query.data?.running, streaming, error: query.error, hasThread: thread !== undefined };
};

/**
 * The number of the read whose answer the cache holds for `tool(input)` (DataLayer.readOf), or undefined while it
 * holds none. It changes on every answer, even one that says the same, which a query's own result doesn't signal.
 */
export const useReadOf = <T extends ToolName>(tool: T, input: ToolInput<T>): number | undefined => {
  const { queryClient, readOf } = useDataLayer();
  const key = callKey(tool, input);
  const hash = hashKey(key);
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe((e) => {
        if (e.type === "updated" && e.query.queryHash === hash) onChange();
      }),
    [queryClient, hash],
  );
  return useSyncExternalStore(subscribe, () => (queryClient.getQueryData(key) === undefined ? undefined : readOf(tool, input)));
};
