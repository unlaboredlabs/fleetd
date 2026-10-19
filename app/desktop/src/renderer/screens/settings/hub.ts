// Settings' reads and writes, all through the app's one data layer (src/renderer/src/data): reads are queries that
// wait for a fresh connection and refetch when a hub event (prompt.changed, prompt.default_changed, …) makes them
// stale; writes are calls, after which the page refetches what it shows rather than waiting for the event.
import { useCallback } from "react";
import type { ToolInput, ToolName, ToolOutput } from "../../../shared/contracts";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";

export const errorText = (e: unknown): string => {
  if (e instanceof CallError) return e.error.fix ? `${e.error.message} ${e.error.fix}` : e.error.message;
  return e instanceof Error ? e.message : String(e);
};

/** Whether the app is connected to its hub right now. */
export const useLive = (): boolean => useData((s) => s.hub.phase === "live");

export type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed"; message: string };

/**
 * `tool(input)` as a Load: loading until the first answer for this input; while it refetches (an event, a save),
 * the last answer stays on screen. A query for another input never shows this one's answer.
 */
export function useRead<T extends ToolName>(tool: T, input: ToolInput<T>, enabled = true): [Load<ToolOutput<T>>, () => void] {
  const q = useToolQuery(tool, input, { enabled });
  const load: Load<ToolOutput<T>> =
    q.data !== undefined ? { state: "ready", value: q.data } : q.isError ? { state: "failed", message: errorText(q.error) } : { state: "loading" };
  return [load, () => void q.refetch()];
}

/** A call that resolves to its output or throws the hub's error. */
export function useHubCall() {
  const layer = useDataLayer();
  return useCallback(
    async <T extends ToolName>(tool: T, input: ToolInput<T>): Promise<ToolOutput<T>> => {
      const outcome = await layer.call(tool, input);
      if (!outcome.ok) throw new CallError(outcome.error);
      return outcome.output;
    },
    [layer],
  );
}

/** Refetches every read of these tools now (after a write of ours; the hub's event would do it a moment later). */
export function useRefetch() {
  const layer = useDataLayer();
  return useCallback(
    (tools: readonly ToolName[]) =>
      void layer.queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "call" && (tools as readonly unknown[]).includes(q.queryKey[1]),
      }),
    [layer],
  );
}
