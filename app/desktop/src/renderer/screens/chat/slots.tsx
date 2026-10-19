// STAND-INS for the other slices' parts of the chat screen, so this one builds alone. At integration each becomes
// one import of the real component (names agreed with its owner), and its stand-in here is deleted.
import { Text } from "../../ui";
import type { ChatItem } from "../../src/data/chat";

export interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

/** F5 (A5): `import { InlineChatItem } from "../inline"`: a secret field or a gated command with Approve / Deny. */
export function InlineChatItem({ item }: { item: ChatItem; project: ProjectRef }) {
  return (
    <Text size="xs" tone="quiet">
      {item.kind === "secret" ? "The lead needs a secret here." : "The lead wants to run a command that needs your approval."}
    </Text>
  );
}

/** F9: `import { AgentsCapControl } from "../settings"`: "agents 6 / 12", the project's agent cap in place. */
export function AgentsCapControl(_props: { projectRef: ProjectRef }) {
  return null;
}
