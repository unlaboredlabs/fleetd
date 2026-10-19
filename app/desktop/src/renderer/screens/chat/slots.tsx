// STAND-INS for the other slices' parts of the chat screen, so this one builds alone. At integration each becomes
// one import of the real component (names agreed with its owner), and its stand-in here is deleted.

export interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

/** F9: `import { AgentsCapControl } from "../settings"`: "agents 6 / 12", the project's agent cap in place. */
export function AgentsCapControl(_props: { projectRef: ProjectRef }) {
  return null;
}
