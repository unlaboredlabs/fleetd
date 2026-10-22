// The live agents view's two reads, as the hub's contracts name them (crates/fleetd-contracts/src/agents.rs on
// feat/hub-agents-prs). Until that lands in this branch's generated contracts, the types are copied here and added to
// the tool map, so every call, query and fixture is already typed and named as the hub's. When it lands, this file
// becomes `export type { AgentRow, AgentWorkInput, AgentWorkOutput, AgentsListInput, AgentsListOutput, WorkStep }
// from "../../../shared/contracts"` and nothing else changes.
import type {
  ActionItem,
  AgentRole,
  Effort,
  LaneStatus,
  LiveLane,
  MachineId,
  PrRef,
  ProjectRef,
  Receipts,
  TailRole,
  TaskId,
  ThreadId,
  ThreadRef,
  Timestamp,
  WorkstreamId,
} from "../../../shared/contracts";

/** One agent: a task, or a project's lead, with its project. */
export type AgentRow = {
  branch?: string;
  effort?: Effort;
  endedAt?: Timestamp;
  laneId: string;
  /** Live values at snapshot time. */
  live?: LiveLane;
  model?: string;
  pr?: PrRef;
  projectRef: ProjectRef;
  projectTitle: string;
  receipts?: Receipts;
  role: AgentRole;
  startedAt?: Timestamp;
  status: LaneStatus;
  statusReason?: string;
  taskId?: TaskId;
  threadRef?: ThreadRef;
  title: string;
  /** The work it belongs to; `live { focus }` with it streams this agent's text too. Absent for a lead. */
  workstreamId?: WorkstreamId;
};

export type AgentsListInput = {
  endedSince?: Timestamp;
  projectRef?: ProjectRef;
};

export type AgentsListOutput = {
  agents: AgentRow[];
  at: Timestamp;
  next?: string;
  truncated?: boolean;
};

export type AgentWorkInput = {
  before?: string;
  limit?: number;
  machineId: MachineId;
  threadId: ThreadId;
};

export type AgentWorkOutput = {
  /** Pass back as `before` for the page before this one; absent when there is nothing older. */
  before?: string;
  next?: string;
  /** A run of it is active now. */
  running: boolean;
  steps: WorkStep[];
  truncated?: boolean;
};

export type WorkStep =
  | { kind: "message"; id: string; at: Timestamp; role: TailRole; text: string }
  | { kind: "action"; id: string; at: Timestamp; action: ActionItem };

declare module "../../../shared/contracts/generated/contracts" {
  interface ToolMap {
    agents_list: { input: AgentsListInput; output: AgentsListOutput };
    agent_work: { input: AgentWorkInput; output: AgentWorkOutput };
  }
}
