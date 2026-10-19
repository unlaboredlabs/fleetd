// The data layer in React: one layer per window, read through selectors.
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useStore } from "zustand";
import type { ToolInput, ToolName } from "../../../shared/contracts";
import type { DataLayer } from "./queries";
import type { DataState } from "./store";

const DataContext = createContext<DataLayer | undefined>(undefined);

export const DataProvider = ({ layer, children }: { layer: DataLayer; children: ReactNode }) => {
  useEffect(() => layer.start(), [layer]);
  return (
    <DataContext.Provider value={layer}>
      <QueryClientProvider client={layer.queryClient}>{children}</QueryClientProvider>
    </DataContext.Provider>
  );
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
