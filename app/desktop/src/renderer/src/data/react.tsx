// The data layer in React: one layer per window, read through selectors.
import { hashKey, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useStore } from "zustand";
import type { ToolInput, ToolName } from "../../../shared/contracts";
import { callKey, type DataLayer } from "./queries";
import { selectLiveText, type LiveAgent } from "./selectors";
import type { DataState } from "./store";

const DataContext = createContext<DataLayer | undefined>(undefined);

export const DataProvider = ({ layer, children }: { layer: DataLayer; children: ReactNode }) => {
  useEffect(() => layer.start(), [layer]);
  return (
    <DataContext.Provider value={layer}>
      <QueryClientProvider client={layer.queryClient}>
        <AlwaysOn />
        {children}
      </QueryClientProvider>
    </DataContext.Provider>
  );
};

const wholeBoard = {};

/** The read the live strips and agent counts depend on (the board), kept loaded whatever screen is open. */
const AlwaysOn = () => {
  useToolQuery("orders_board", wholeBoard);
  return null;
};

export const useDataLayer = (): DataLayer => {
  const layer = useContext(DataContext);
  if (layer === undefined) throw new Error("useDataLayer outside DataProvider");
  return layer;
};

/** Reads the store through a selector from ./selectors (memoized, so the value is stable between changes). */
export const useData = <T,>(selector: (s: DataState) => T): T => useStore(useDataLayer().store, selector);

/**
 * `tool(input)` as a query. It waits for a fresh connection (a call made before the resync would describe the
 * old one) and refetches when an event makes it stale.
 */
export const useToolQuery = <T extends ToolName>(tool: T, input: ToolInput<T>, options?: { enabled?: boolean }) => {
  const layer = useDataLayer();
  const fresh = useStore(layer.store, (s) => s.fresh);
  return useQuery({ ...layer.toolQuery(tool, input), enabled: fresh && (options?.enabled ?? true) });
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
