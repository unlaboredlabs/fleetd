// The Activity feed's reads: events_list a page at a time back through the log, and the events that arrive while it
// is open, from the data layer's event stream rather than a refetch, so a busy hub costs no reads.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HubEvent, ToolOutput } from "../../../shared/contracts";
import { useData, useDataLayer, useToolPages } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import type { ProjectKey } from "../shell/routes";
import { hubWideFor, inFeed, linesOf, typesFor, type KindFilter, type Line } from "./model";
import { useActivitySeen } from "./seen";

/** Events per page: about two screens of rows. */
const PAGE = 50;

const NO_FILTER: KindFilter = new Set();

const olderThan = (page: ToolOutput<"events_list">) => {
  const last = page.events[page.events.length - 1];
  return page.more && last !== undefined ? { before: last.seq } : undefined;
};

/** The events of `project` (and the hub's own) that came in through the stream since this mounted, newest last. */
function useStreamed(project: ProjectKey): readonly HubEvent[] {
  const { store } = useDataLayer();
  const { machineId, projectId } = project;
  const [held, setHeld] = useState<readonly HubEvent[]>([]);
  useEffect(() => {
    const ours = { machineId, projectId };
    // The store keeps the latest events only: take each as it lands, so none drops out of the feed later.
    const take = (events: readonly HubEvent[]) =>
      setHeld((h) => {
        const last = h[h.length - 1]?.seq ?? 0;
        const fresh = events.filter((e) => e.seq > last && inFeed(e, ours, NO_FILTER));
        return fresh.length === 0 ? h : [...h, ...fresh];
      });
    take(store.getState().events);
    return store.subscribe((s, prev) => {
      if (s.events !== prev.events) take(s.events);
    });
  }, [store, machineId, projectId]);
  return held;
}

export interface ActivityFeed {
  /** Newest first; undefined until the first page is read. */
  readonly lines: readonly Line[] | undefined;
  readonly error: Error | null;
  readonly retry: () => void;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** Reading the next older page failed (its retries spent): nothing loads it again until `retryOlder`. */
  readonly olderFailed: boolean;
  readonly loadOlder: () => void;
  readonly retryOlder: () => void;
}

/** `project`'s activity under `filter`: the pages read so far, with what streamed in since above them. */
export function useActivityFeed(project: ProjectKey, filter: KindFilter): ActivityFeed {
  const input = useMemo(
    () => ({
      projectRef: { machineId: project.machineId, projectId: project.projectId },
      types: typesFor(filter),
      hubWide: hubWideFor(filter),
      limit: PAGE,
    }),
    [project.machineId, project.projectId, filter],
  );
  const pages = useToolPages("events_list", input, olderThan);
  const streamed = useStreamed(project);
  const read = pages.data?.pages;
  const lines = useMemo(() => {
    if (read === undefined) return undefined;
    const events = read.flatMap((p) => p.events);
    // Only what is newer than the read: an older streamed event would sit below a gap the next page hasn't filled.
    const top = events[0]?.seq ?? 0;
    const after = streamed.filter((e) => e.seq > top);
    return linesOf([...after, ...events].filter((e) => inFeed(e, project, filter)));
  }, [read, streamed, project, filter]);
  const { fetchNextPage, refetch, hasNextPage, isFetchingNextPage, isFetchNextPageError } = pages;
  // Stable between renders, so the list's end asks for the next page once, not on every render.
  const loadOlder = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const retryOlder = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  return {
    lines,
    error: pages.error,
    retry: () => void refetch(),
    hasOlder: hasNextPage,
    loadingOlder: isFetchingNextPage,
    olderFailed: isFetchNextPageError,
    loadOlder,
    retryOlder,
  };
}

/**
 * How many of `project`'s activity lines came in since the person last looked at its Activity, for a tab's count:
 * from the events this window holds, none before the person has ever looked. Never reads the hub.
 */
export function useActivityUnread(project: ProjectKey): number {
  const seen = useActivitySeen(projectKey(project));
  return useData(
    useCallback(
      (s) => {
        if (seen === undefined) return 0;
        let n = 0;
        for (const e of s.events) if (e.seq > seen && inFeed(e, project, NO_FILTER)) n++;
        return n;
      },
      [seen, project],
    ),
  );
}
