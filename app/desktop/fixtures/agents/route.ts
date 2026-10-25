// The agent the agents-work fixture opens in the panel (many-agents' first storefront writer), shared with the QA registry.
export const AGENT = {
  machineId: "devbox",
  projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22",
  laneId: "T1",
  threadId: "6aacd21e-ee9a-45f1-b2d1-55ced592d265",
} as const;

export const AGENT_ROUTE = `#/project/${AGENT.machineId}/${AGENT.projectId}/agents/${AGENT.laneId}`;

// A project on the same repo as storefront with no agents of its own (typical's checkout): agents-elsewhere shows its
// Elsewhere group under a note.
export const ELSEWHERE_IDLE = { machineId: "devbox", projectId: "7a9a4d2f-7656-4a38-a750-56ac34e9f090" } as const;

export const ELSEWHERE_IDLE_ROUTE = `#/project/${ELSEWHERE_IDLE.machineId}/${ELSEWHERE_IDLE.projectId}/agents`;
