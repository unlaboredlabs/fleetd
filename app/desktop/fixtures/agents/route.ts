// The agent the agents-work fixture opens (many-agents' first storefront writer), shared with the QA registry.
export const AGENT = {
  machineId: "devbox",
  projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22",
  laneId: "T1",
  threadId: "6aacd21e-ee9a-45f1-b2d1-55ced592d265",
} as const;

export const AGENT_ROUTE = `#/agents/${AGENT.machineId}/${AGENT.projectId}/${AGENT.laneId}`;
