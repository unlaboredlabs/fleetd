// The hub shapes Settings reads and writes, field for field from fleetd_contracts (prompts.rs, the prompt tools and
// time_retention_set in mcp.rs, ProjectSummary in model.rs). They stand in until E1's generated types land; then
// this file becomes re-exports of those, with the same names.

export type PromptId = string;
/** `<id>@<10 hex>`: one exact text of one prompt. */
export type PromptRef = string;

export type PromptKind = "start" | "wake" | "msg" | "oneshot" | "playbook" | "instructions";
export type PromptGroup =
  | "lead"
  | "tasks"
  | "reviews_and_checks"
  | "wakes_and_messages"
  | "one_shots"
  | "playbooks"
  | "instructions";
export type PromptScope = "default" | "global" | "project";
export type Enforcement = "code" | "prompt";
export type PromptWarningCode = "placeholder_missing" | "placeholder_unknown" | "safety_rule_missing" | "too_long";

export interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

export interface Placeholder {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

export interface SafetyRule {
  readonly id: string;
  readonly label: string;
  readonly needle: string;
  readonly enforced: Enforcement;
  readonly present?: boolean;
}

export interface PromptWarning {
  readonly code: PromptWarningCode;
  readonly message: string;
  readonly placeholder?: string;
  readonly rule?: string;
  readonly enforced?: Enforcement;
}

export interface PromptVersion {
  readonly ref: PromptRef;
  readonly text: string;
}

export interface PromptOverride {
  readonly ref: PromptRef;
  readonly text: string;
  readonly base?: PromptRef;
}

export interface StalePrompt {
  readonly scope: PromptScope;
  readonly base?: PromptVersion;
  readonly current: PromptVersion;
  readonly yours: PromptVersion;
  /** A line 3-way merge of base → current into yours, with `<<<<<<<` markers where they conflict. */
  readonly merged: string;
  readonly conflicts: boolean;
}

export interface PromptSummary {
  readonly id: PromptId;
  readonly title: string;
  readonly kind: PromptKind;
  readonly group: PromptGroup;
  readonly sentWhen: string;
  readonly scope: PromptScope;
  readonly defaultRef: PromptRef;
  readonly overrideRef?: PromptRef;
  readonly stale: boolean;
}

export interface PromptDetail {
  readonly id: PromptId;
  readonly title: string;
  readonly kind: PromptKind;
  readonly group: PromptGroup;
  readonly sentWhen: string;
  /** False for playbooks, router and retro: they have the hub-wide level only. */
  readonly perProject: boolean;
  readonly default: PromptVersion;
  readonly global?: PromptOverride;
  readonly project?: PromptOverride;
  readonly scope: PromptScope;
  readonly effective: PromptVersion;
  readonly placeholders: ReadonlyArray<Placeholder>;
  readonly safetyRules: ReadonlyArray<SafetyRule>;
  readonly warnings: ReadonlyArray<PromptWarning>;
  readonly stale?: StalePrompt;
}

export interface PromptsListInput {
  readonly projectRef?: ProjectRef;
}
export interface PromptsListOutput {
  readonly prompts: ReadonlyArray<PromptSummary>;
}
export interface PromptGetInput {
  readonly id: PromptId;
  readonly projectRef?: ProjectRef;
}
/** The detail, flattened (`#[serde(flatten)] prompt`). */
export type PromptGetOutput = PromptDetail;
export interface PromptSetInput {
  readonly id: PromptId;
  readonly scope: PromptScope;
  readonly projectRef?: ProjectRef;
  readonly text: string;
  readonly base?: PromptRef;
  readonly dryRun?: boolean;
}
export interface PromptSetOutput {
  readonly ref: PromptRef;
  readonly warnings: ReadonlyArray<PromptWarning>;
}
export interface PromptResetInput {
  readonly id: PromptId;
  readonly scope: PromptScope;
  readonly projectRef?: ProjectRef;
}
export interface PromptResetOutput {
  readonly effective: PromptVersion;
  readonly scope: PromptScope;
}

/** The fields of model.rs ProjectSummary the picker uses. */
export interface ProjectSummary {
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
}
export interface ProjectsListOutput {
  readonly projects: ReadonlyArray<ProjectSummary>;
}

/** The two fields of TimeBreakdownOutput Settings shows. */
export interface TimeStore {
  readonly retentionDays: number;
  /** The hub's span tables on disk. */
  readonly storedBytes: number;
}
export interface TimeRetentionSetOutput {
  readonly retentionDays: number;
}

/** The registry id of the human's own instructions; they have their own page, not a row in the prompt list. */
export const INSTRUCTIONS: PromptId = "instructions";

/** Hub events that change what the prompt pages show. */
export const PROMPT_EVENTS: ReadonlySet<string> = new Set(["prompt.changed", "prompt.default_changed"]);
