// The chat's data, from E1's layer (one source of hub data): the chat view, the project's state word, whether the
// live strip has agents to show, and the actions that page through its history. The shell opens the chat on screen.
import { useCallback } from "react";
import type { HubError } from "../../../shared/hub";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import {
  projectStateWord,
  selectChat,
  selectLeadWorking,
  selectProjectRow,
  type ChatView,
} from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { selectStrip } from "../live/strip";
import type { ProjectRef } from "./slots";

// Status's own query (same input, so one cached read), only for what the hub alone knows (blocked and why, a warning); needs-you
// and working come from the project row the sidebar dot reads, so the dot, the top bar and Status agree.
const ALL = {} as const;

export interface ChatData {
  readonly view: ChatView | undefined;
  readonly leadWorking: boolean | undefined;
  /** Blocked (the state word, the sidebar's and Status's, says so): the hub's reason, "" when it gave none. */
  readonly blocked: string | undefined;
  /** What stops nothing but is worth knowing, in any state: a check red on main, and whether a fix is under way. */
  readonly warning: string | undefined;
  /** Blocked by this machine's usage pause, which Resume lifts. */
  readonly usagePausedOn: string | undefined;
  /** The newest page couldn't be read (before any page landed): the chat shows why, with retry. */
  readonly loadError: HubError | undefined;
  readonly retry: () => void;
  /** The live strip has agents to show. */
  readonly strip: boolean;
  readonly title: string | undefined;
  /** The hub has no such project (a stale link, or one removed): nothing will load. */
  readonly missing: boolean;
  readonly loadOlder: () => void;
}

export function useChatData(project: ProjectRef): ChatData {
  const key = projectKey(project);
  const layer = useDataLayer();
  const view = useData(selectChat(key));
  const projectRow = useData(selectProjectRow(key));
  const leadWorking = useData(selectLeadWorking(key));
  const strip = useData((s) => (selectStrip(project)(s)?.agents ?? 0) > 0);
  const title = useData((s) => s.projects[key]?.title);
  const missing = useData((s) => s.fresh && !(key in s.projects));
  const loadError = useData((s) => (s.chats[key]?.loaded === true ? undefined : s.chats[key]?.error));
  const status = useToolQuery("status_get", ALL);
  const row = status.data?.rows?.find((r) => r.projectRef.machineId === project.machineId && r.projectRef.projectId === project.projectId);
  const state = projectRow === undefined ? undefined : projectStateWord(projectRow.needsYou, projectRow.working, row?.state);
  const blocked = state === "blocked" ? (row?.blockedReason ?? "") : undefined;
  const usagePausedOn = state === "blocked" ? row?.usagePausedOn : undefined;
  const warning = row?.warning;
  const loadOlder = useCallback(() => layer.chat.loadOlder(key), [layer, key]);
  // open() reads the newest page again while none has landed.
  const retry = useCallback(() => layer.chat.open(key), [layer, key]);
  return { view, blocked, warning, usagePausedOn, leadWorking, loadError, retry, strip, title, missing, loadOlder };
}
