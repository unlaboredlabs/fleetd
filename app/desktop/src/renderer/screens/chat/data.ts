// The chat's data, from E1's layer (one source of hub data): the chat view, the project's state word, its
// agents for the strip, and the actions that open the chat and page back through its history.
import { useCallback, useEffect } from "react";
import type { AgentLane } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { selectChat, selectLeadWorking, selectNeedsYou, selectProjectAgents, type ChatView } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { stateWord, type StateWord } from "../status/rows";
import type { ProjectRef } from "./slots";

// Status's own query (same input, so one cached read): the header's state word is the Status row's.
const ALL = {} as const;

export interface ChatData {
  readonly view: ChatView | undefined;
  /** The project's state word, as its Status row says it; from the chat's state until Status has read. */
  readonly state: StateWord | undefined;
  readonly leadWorking: boolean | undefined;
  /** The newest page couldn't be read (before any page landed): the chat shows why, with retry. */
  readonly loadError: HubError | undefined;
  readonly retry: () => void;
  readonly agents: readonly AgentLane[] | undefined;
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
  const needsYou = useData(selectNeedsYou(key));
  const leadWorking = useData(selectLeadWorking(key));
  const agents = useData(selectProjectAgents(key));
  const title = useData((s) => s.projects[key]?.title);
  const missing = useData((s) => s.fresh && !(key in s.projects));
  const loadError = useData((s) => (s.chats[key]?.loaded === true ? undefined : s.chats[key]?.error));
  const status = useToolQuery("status_projects", ALL);
  const row = status.data?.rows.find((r) => r.projectRef.machineId === project.machineId && r.projectRef.projectId === project.projectId);
  const state: StateWord | undefined =
    row !== undefined ? stateWord(row.state) : needsYou === true ? "waiting_on_you" : leadWorking === true ? "working" : needsYou === false && leadWorking === false ? "idle" : undefined;
  // Idempotent: loads the newest page once per connection.
  useEffect(() => {
    layer.chat.open(key);
  }, [layer, key]);
  const loadOlder = useCallback(() => layer.chat.loadOlder(key), [layer, key]);
  const loadNewer = useCallback(() => layer.chat.loadNewer(key), [layer, key]);
  const jumpToLatest = useCallback(() => layer.chat.jumpToLatest(key), [layer, key]);
  // open() reads the newest page again while none has landed.
  const retry = useCallback(() => layer.chat.open(key), [layer, key]);
  return { view, state, leadWorking, loadError, retry, agents, title, missing, loadOlder, loadNewer, jumpToLatest };
}
