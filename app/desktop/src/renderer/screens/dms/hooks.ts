// The DM reads: agent_messages for a project (Activity › DMs, a page at a time), for one agent (its thread's cards),
// and its total (the lead chat strip's count). Each reads again on the hub's DM events (src/data/effects.ts), so
// nothing here polls.
import { useCallback, useMemo } from "react";
import type { ToolOutput } from "../../../shared/contracts";
import { useData, useToolPages, useToolQuery } from "../../src/data/react";
import type { ProjectKey } from "../shell/routes";
import type { AgentMessage } from "./model";

/** DMs per page of the log: about two screens of rows. */
const PAGE = 50;
/** An agent's DMs its thread shows: more than a run ever sends or gets. */
const THREAD = 100;

/** The hub's feature that serves agent_messages and its events: an older hub has no DMs to show. */
export const DMS_FEATURE = "agent_messages";

/** Whether the hub serves agents' DMs. */
export const useDmsServed = (): boolean => useData((st) => st.features.includes(DMS_FEATURE));

const projectRef = (project: ProjectKey) => ({ machineId: project.machineId, projectId: project.projectId });

const olderThan = (page: ToolOutput<"agent_messages">) => {
  const last = page.messages[page.messages.length - 1];
  return page.more && last !== undefined ? { before: last.id } : undefined;
};

export interface DmLog {
  /** Newest first; undefined until the first page is read. */
  readonly messages: readonly AgentMessage[] | undefined;
  readonly error: Error | null;
  readonly retry: () => void;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly olderFailed: boolean;
  readonly loadOlder: () => void;
  readonly retryOlder: () => void;
}

/** Every DM of `project` (or only those `taskId` sent or got), newest first, a page at a time. */
export function useDmLog(project: ProjectKey, taskId: string | undefined): DmLog {
  const input = useMemo(
    () => ({ projectRef: projectRef(project), limit: PAGE, ...(taskId === undefined ? {} : { taskId }) }),
    [project.machineId, project.projectId, taskId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const pages = useToolPages("agent_messages", input, olderThan, { enabled: useDmsServed() });
  const read = pages.data?.pages;
  const messages = useMemo(() => read?.flatMap((p) => p.messages), [read]);
  const { fetchNextPage, refetch, hasNextPage, isFetchingNextPage, isFetchNextPageError } = pages;
  // Stable between renders, so the list's end asks for the next page once, not on every render.
  const loadOlder = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const retryOlder = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  return {
    messages,
    error: pages.error,
    retry: () => void refetch(),
    hasOlder: hasNextPage,
    loadingOlder: isFetchingNextPage,
    olderFailed: isFetchNextPageError,
    loadOlder,
    retryOlder,
  };
}

/** The DMs `taskId` sent or got, for its thread; undefined until read, or when the hub has no such read. */
export function useAgentDms(project: ProjectKey, taskId: string | undefined): readonly AgentMessage[] | undefined {
  const q = useToolQuery("agent_messages", { projectRef: projectRef(project), taskId: taskId ?? "", limit: THREAD }, { enabled: useDmsServed() && taskId !== undefined });
  return q.data?.messages;
}

/** How many DMs `project`'s agents have sent each other; undefined until read. */
export function useDmTotal(project: ProjectKey): number | undefined {
  return useToolQuery("agent_messages", { projectRef: projectRef(project), limit: 1 }, { enabled: useDmsServed() }).data?.total;
}
