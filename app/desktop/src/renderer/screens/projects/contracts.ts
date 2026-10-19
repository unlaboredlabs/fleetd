// The hub shapes these screens read, field for field from crates/fleetd-contracts (projects.rs, mcp.rs, model.rs,
// live.rs, node_link.rs, tasks.rs, events.rs). E1's generated types replace this file, same names; nothing here may
// carry a field the Rust side doesn't.

export type GitHubRepo = string;
export type MachineId = string;
export type ProjectId = string;
export type Timestamp = string;

export type ProjectProblemCode =
  | "machine_offline"
  | "no_worker"
  | "gh_unavailable"
  | "gh_no_access"
  | "path_missing"
  | "not_a_git_repo"
  | "dest_exists"
  | "clone_failed"
  | "node_too_old"
  | "other";

export interface ProjectProblem {
  readonly code: ProjectProblemCode;
  readonly message: string;
  readonly fix?: string;
}

export interface FoundRepo {
  readonly path: string;
  readonly name: string;
  readonly remote?: string;
  readonly repo?: GitHubRepo;
  readonly projectId?: ProjectId;
}

export interface MachineRepos {
  readonly machineId: MachineId;
  readonly online: boolean;
  readonly cloneRoot?: string;
  readonly repos: ReadonlyArray<FoundRepo>;
  readonly problem?: ProjectProblem;
}

export interface Checkout {
  readonly machineId: MachineId;
  readonly path: string;
  readonly projectId?: ProjectId;
}

export interface GitHubCandidate {
  readonly repo: GitHubRepo;
  readonly url: string;
  readonly private: boolean;
  readonly description?: string;
  readonly pushedAt?: string;
  readonly checkouts: ReadonlyArray<Checkout>;
}

export interface GitHubRepos {
  readonly ghOn?: string;
  readonly owners: ReadonlyArray<string>;
  readonly repos: ReadonlyArray<GitHubCandidate>;
  readonly problem?: ProjectProblem;
}

export interface ProjectDiscoverOutput {
  readonly machines: ReadonlyArray<MachineRepos>;
  readonly github: GitHubRepos;
  readonly best?: MachineId;
}

export interface CloneTarget {
  readonly machineId: MachineId;
  readonly path: string;
  readonly exists: boolean;
  readonly sameRemote: boolean;
  readonly projectId?: ProjectId;
}

export interface CiInfo {
  readonly workflows: ReadonlyArray<string>;
  readonly requiredChecks: ReadonlyArray<string>;
}

export interface MergeRules {
  readonly protected: boolean;
  readonly rulesets: ReadonlyArray<string>;
  readonly squashAllowed?: boolean;
  readonly requiredReviews?: number;
  readonly strict?: boolean;
}

export interface ProjectInspect {
  readonly repo?: GitHubRepo;
  readonly defaultBranch?: string;
  readonly ci: CiInfo;
  readonly merge: MergeRules;
  readonly leadNeeds: string;
  readonly notes: ReadonlyArray<string>;
}

export type ProjectInspectOutput = ProjectInspect & { readonly clone?: CloneTarget };

export interface ProjectAddInput {
  readonly machineId?: MachineId;
  readonly path?: string;
  readonly url?: string;
  readonly dest?: string;
  readonly useExisting?: boolean;
  readonly title?: string;
}

export interface ProjectAddOutput {
  readonly machineId: MachineId;
  readonly path: string;
  readonly projectId?: ProjectId;
  readonly created: boolean;
  readonly addId?: string;
  readonly inspect?: ProjectInspect;
}

export type ClonePhase = "starting" | "receiving" | "resolving" | "checking_out" | "inspecting";

export interface CloneProgressData {
  readonly addId: string;
  readonly repo?: GitHubRepo;
  readonly path: string;
  readonly phase: ClonePhase;
  readonly percent?: number;
  readonly detail?: string;
}

export interface ProjectAddedData {
  readonly addId?: string;
  readonly title: string;
  readonly path: string;
  readonly created: boolean;
  readonly inspect: ProjectInspect;
}

export type ProjectAddFailedData = ProjectProblem & {
  readonly addId: string;
  readonly repo?: GitHubRepo;
  readonly path: string;
};

export const ADD_EVENTS = ["project.clone_progress", "project.added", "project.add_failed"] as const;
export type AddEventType = (typeof ADD_EVENTS)[number];

/** HubEvent, with the fields these screens read. */
export interface HubEvent {
  readonly seq: number;
  readonly at: Timestamp;
  readonly type: string;
  readonly machineId?: MachineId;
  readonly projectId?: ProjectId;
  readonly summary: string;
  readonly data?: unknown;
}

export interface EventsWaitOutput {
  readonly events: ReadonlyArray<HubEvent>;
  readonly cursor: number;
  readonly more: boolean;
}

export type MachineStatus = "online" | "offline" | "degraded";

export interface SleptSpan {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface Machine {
  readonly machineId: MachineId;
  readonly name: string;
  readonly tags: ReadonlyArray<string>;
  readonly status: MachineStatus;
  readonly lastSeenAt: Timestamp;
  readonly nodeVersion: string;
  readonly degradedReason?: string;
  readonly lastSlept?: SleptSpan;
}

export interface LoginLimit {
  readonly limitType: string;
  readonly utilization?: number;
  readonly resetsAt?: Timestamp;
  readonly status: string;
  readonly observedAt?: Timestamp;
}

export interface NodeLoad {
  readonly cpus: number;
  readonly load1: number;
  readonly memUsedPct?: number;
  readonly limits: ReadonlyArray<LoginLimit>;
}

export interface MachineLive {
  readonly machineId: MachineId;
  readonly name: string;
  readonly status: MachineStatus;
  readonly load?: NodeLoad;
  readonly running: number;
  readonly asOf: Timestamp;
  readonly slept?: SleptSpan;
}

export interface SlotState {
  readonly cap: number;
  readonly used: number;
  readonly queued: number;
  readonly reservedBand: number;
  readonly perProject: ReadonlyArray<{ readonly projectRef: string; readonly share: number; readonly used: number }>;
}

export interface ThreadCounts {
  readonly running: number;
  readonly waiting: number;
  readonly idle: number;
  readonly failed: number;
}

export interface ProjectSummary {
  readonly machineId: MachineId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly threads: ThreadCounts;
  readonly lastActivityAt: Timestamp;
}

/** The snapshot (fleetd_status) fields these screens read. */
export interface FleetSnapshot {
  readonly machines: ReadonlyArray<Machine>;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly cursor: number;
  readonly slots?: SlotState;
}
