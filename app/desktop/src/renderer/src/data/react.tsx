// The data layer in React: one layer per window, read through selectors.
import { QueryClientProvider, useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useStore } from "zustand";
import type { ToolInput, ToolName, ToolOutput } from "../../../shared/contracts";
import type { DataLayer } from "./queries";
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
