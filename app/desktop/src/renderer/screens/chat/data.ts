// The chat's data, from E1's layer (one source of hub data): the chat view, the project's state word, whether the
// live strip has agents to show, and the actions that open the chat and page back through its history.
import { useCallback, useEffect } from "react";
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
  const status = useToolQuery("status_projects", ALL);
  const row = status.data?.rows.find((r) => r.projectRef.machineId === project.machineId && r.projectRef.projectId === project.projectId);
  const state = projectRow === undefined ? undefined : projectStateWord(projectRow.needsYou, projectRow.working, row?.state);
  // Idempotent: loads the newest page once per connection.
  useEffect(() => {
    layer.chat.open(key);
  }, [layer, key]);
  const loadOlder = useCallback(() => layer.chat.loadOlder(key), [layer, key]);
  const loadNewer = useCallback(() => layer.chat.loadNewer(key), [layer, key]);
  const jumpToLatest = useCallback(() => layer.chat.jumpToLatest(key), [layer, key]);
  // open() reads the newest page again while none has landed.
  const retry = useCallback(() => layer.chat.open(key), [layer, key]);
  return { view, state, leadWorking, loadError, retry, strip, title, missing, loadOlder, loadNewer, jumpToLatest };
}
