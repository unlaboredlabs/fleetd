// The chat's data, from E1's layer (one source of hub data): the chat view, the project's state word, whether the
// live strip has agents to show, the actions that page through its history, and your steers to the lead. The shell
// opens the chat on screen.
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { OrderGetOutput, Steer } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import {
  projectStateWord,
  selectChat,
  selectLeadWorking,
  selectProjectRow,
  type ChatView,
  type ProjectStateWord,
} from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { selectStrip } from "../live/strip";
import { leadSteers } from "../live/steerModel";
import { ordersInView } from "./model";
import type { ProjectRef } from "./slots";

// Status's own query (same input, so one cached read), only for what the hub alone knows (blocked); needs-you
// and working come from the project row the sidebar dot reads, so the dot, the header and Status agree.
const ALL = {} as const;

export interface ChatData {
  readonly view: ChatView | undefined;
  /** The project's state word: the sidebar's and Status's. */
  readonly state: ProjectStateWord | undefined;
  readonly leadWorking: boolean | undefined;
  /** The newest page couldn't be read (before any page landed): the chat shows why, with retry. */
  readonly loadError: HubError | undefined;
  readonly retry: () => void;
  /** The live strip has agents to show. */
  readonly strip: boolean;
  readonly title: string | undefined;
  /** The hub has no such project (a stale link, or one removed): nothing will load. */
  readonly missing: boolean;
  readonly loadOlder: () => void;
  readonly loadNewer: () => void;
  readonly jumpToLatest: () => void;
}

export function useChatData(project: ProjectRef): ChatData {
  const key = projectKey(project);
  const layer = useDataLayer();
  const view = useData(selectChat(key));
  const projectRow = useData(selectProjectRow(key));
  const leadWorking = useData(selectLeadWorking(key));
  const strip = useData((s) => (selectStrip(project)(s)?.rows.length ?? 0) > 0);
  const title = useData((s) => s.projects[key]?.title);
  const missing = useData((s) => s.fresh && !(key in s.projects));
  const loadError = useData((s) => (s.chats[key]?.loaded === true ? undefined : s.chats[key]?.error));
  const status = useToolQuery("status_get", ALL);
  const row = status.data?.rows?.find((r) => r.projectRef.machineId === project.machineId && r.projectRef.projectId === project.projectId);
  const state = projectRow === undefined ? undefined : projectStateWord(projectRow.needsYou, projectRow.working, row?.state);
  const loadOlder = useCallback(() => layer.chat.loadOlder(key), [layer, key]);
  const loadNewer = useCallback(() => layer.chat.loadNewer(key), [layer, key]);
  const jumpToLatest = useCallback(() => layer.chat.jumpToLatest(key), [layer, key]);
  // open() reads the newest page again while none has landed.
  const retry = useCallback(() => layer.chat.open(key), [layer, key]);
  return { view, state, leadWorking, loadError, retry, strip, title, missing, loadOlder, loadNewer, jumpToLatest };
}

const noSteers: readonly Steer[] = [];

/** Every steer the orders' reads list; one array per change of any read, so the rows aren't rebuilt otherwise. */
const listedSteers = (reads: readonly UseQueryResult<OrderGetOutput>[]): readonly Steer[] => {
  const all = reads.flatMap((r) => r.data?.steers ?? []);
  return all.length === 0 ? noSteers : all;
};

/**
 * Your steers to the lead within the chat's loaded pages, and `sent` (this window's, until a read lists them). The hub
 * keeps steers apart from the chat, so they are read per order with order_get (the read the live strip and the
 * agent's box share, which every steer.* event naming the order reads again): the project's open orders from the
 * board, and those that ended within the pages from workstream_list, read again when an order is created.
 */
export function useLeadSteers(project: ProjectRef, view: ChatView | undefined, sent: readonly Steer[]): readonly Steer[] {
  const layer = useDataLayer();
  const fresh = useData((s) => s.fresh);
  // A string, so the selector's answer is equal while the board changes elsewhere.
  const open = useData((s) =>
    Object.values(s.orders ?? {})
      .filter((o) => o.projectRef.machineId === project.machineId && o.projectRef.projectId === project.projectId)
      .map((o) => o.workstreamId)
      .join(" "),
  );
  const listed = useToolQuery("workstream_list", { machineId: project.machineId, projectId: project.projectId }, { enabled: view !== undefined }).data?.workstreams;
  const from = view?.hasOlder === true ? view.items[0]?.at : undefined;
  const to = view?.hasNewer === true ? view.items.at(-1)?.at : undefined;
  const orders = useMemo(() => ordersInView(open === "" ? [] : open.split(" "), listed, from, to), [open, listed, from, to]);
  const steers = useQueries({
    queries: orders.map((workstreamId) => ({ ...layer.toolQuery("order_get", { workstreamId }), enabled: fresh })),
    combine: listedSteers,
  });
  return useMemo(() => leadSteers(steers, sent), [steers, sent]);
}
