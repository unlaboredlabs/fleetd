// STAND-IN until E1's chat data layer lands (fix/desktop-chat-data): its selectors and actions by the names it
// announced. Everything is undefined (the skeleton) until then; the swap is: selectChat / selectNeedsYou /
// selectLeadWorking / selectProjectAgents through useData, and useDataLayer().chat.open / loadOlder.
import type { AgentLane } from "../../../shared/contracts";
import type { ChatView } from "./contract";
import type { ProjectRef } from "./slots";

export interface ChatData {
  readonly view: ChatView | undefined;
  readonly needsYou: boolean | undefined;
  readonly leadWorking: boolean | undefined;
  readonly agents: readonly AgentLane[] | undefined;
  readonly title: string | undefined;
  readonly loadOlder: () => void;
}

export function useChatData(_project: ProjectRef): ChatData {
  return { view: undefined, needsYou: undefined, leadWorking: undefined, agents: undefined, title: undefined, loadOlder: () => undefined };
}
