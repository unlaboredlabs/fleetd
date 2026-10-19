// The chat's data, from E1's layer (one source of hub data): the chat view, the project's state words, its
// agents for the strip, and the actions that open the chat and page back through its history.
import { useCallback, useEffect } from "react";
import type { AgentLane } from "../../../shared/contracts";
import { useData, useDataLayer } from "../../src/data/react";
import { selectChat, selectLeadWorking, selectNeedsYou, selectProjectAgents, type ChatView } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import type { ProjectRef } from "./slots";

export interface ChatData {
  readonly view: ChatView | undefined;
  readonly needsYou: boolean | undefined;
  readonly leadWorking: boolean | undefined;
  readonly agents: readonly AgentLane[] | undefined;
  readonly title: string | undefined;
  readonly loadOlder: () => void;
}

export function useChatData(project: ProjectRef): ChatData {
  const key = projectKey(project);
  const layer = useDataLayer();
  const view = useData(selectChat(key));
  const needsYou = useData(selectNeedsYou(key));
  const leadWorking = useData(selectLeadWorking(key));
  const agents = useData(selectProjectAgents(key));
  const title = useData((s) => s.projects[key]?.title);
  // Idempotent: loads the newest page once per connection.
  useEffect(() => {
    layer.chat.open(key);
  }, [layer, key]);
  const loadOlder = useCallback(() => layer.chat.loadOlder(key), [layer, key]);
  return { view, needsYou, leadWorking, agents, title, loadOlder };
}
