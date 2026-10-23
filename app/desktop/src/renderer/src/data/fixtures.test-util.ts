// Small builders for the data layer's tests (acme/storefront on devbox; no personal data).
import type { AgentLane, FleetStatus, HubEvent, LiveLane, OrderCard } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";

export const AT = "2026-10-19T10:00:00.000Z";
export const project = { machineId: "devbox", projectId: "storefront" } as const;

export const snapshot = (cursor: number): HubFrame => {
  const snap: FleetStatus = {
    cursor,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }],
    projects: [
      {
        ...project,
        title: "storefront",
        workspaceRoot: "/srv/storefront",
        lastActivityAt: AT,
        threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
      },
    ],
  };
  return { t: "snapshot", snapshot: snap };
};

export const live = (): HubFrame => ({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });

export const event = (seq: number, type: string, data?: Record<string, unknown>): HubFrame => {
  const e: HubEvent = { seq, at: AT, type, summary: type, ...project, ...(data === undefined ? {} : { data }) };
  return { t: "event", event: e };
};

export const lane = (laneId: string, status: AgentLane["status"], role: AgentLane["role"] = "implementer"): AgentLane => ({
  laneId,
  role,
  status,
  title: `Lane ${laneId}`,
  taskId: laneId,
});

export const card = (workstreamId: string, patch: Partial<OrderCard> = {}): OrderCard => ({
  workstreamId,
  projectRef: project,
  title: `Order ${workstreamId}`,
  state: "open",
  phase: "working",
  needsYou: 0,
  settled: 0,
  total: 1,
  lanes: [lane("T1", "working")],
  prs: [],
  createdAt: AT,
  updatedAt: AT,
  ...patch,
});

export const liveLane = (laneId: string, status: LiveLane["status"], patch: Partial<LiveLane> = {}): LiveLane => ({
  laneId,
  status,
  ...patch,
});
