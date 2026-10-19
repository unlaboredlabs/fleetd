// The hub shapes the inbox reads, copied field for field from crates/fleetd-contracts (ledger.rs Ask/AskOption/
// AskAnswer, mcp.rs AsksList/InboxReply/InboxUndo, model.rs ProjectSummary, live.rs OrderCard) as of PR #167.
// E1's generated types replace this file; keep the names identical so the swap is an import change.

export type AskKind = "decide" | "do" | "secret" | "approve";
export type AskClass = "product" | "money" | "credential" | "irreversible";
export type AskState = "open" | "auto" | "answered" | "defaulted" | "withdrawn";
export type AskAnswerKind = "option" | "text" | "skip";

export interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

export interface AskOption {
  /** Internal: what gets recorded. Never shown when a label exists. */
  readonly key: string;
  /** Absent only on asks stored before labels. */
  readonly label?: string;
  readonly consequence?: string;
}

export interface AskAnswer {
  readonly value: string;
  readonly by: string;
  readonly at: string;
  readonly raw: string;
  readonly kind?: AskAnswerKind;
  readonly undoUntil?: string;
  readonly deliveredAt?: string;
}

export interface Step {
  readonly text: string;
  /** A machineId or "browser". */
  readonly where: string;
  readonly command?: string;
  readonly expect?: string;
}

export interface GatedRunSpec {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly class: "irreversible" | "money" | "credential";
  readonly reason: string;
  readonly timeoutSec: number;
}

export interface ToolPermission {
  readonly threadId: string;
  readonly requestId: string;
  readonly toolName: string;
  readonly summary: string;
}

export interface Ask {
  readonly askId: string;
  readonly batchId?: string;
  readonly number?: number;
  readonly projectRef?: ProjectRef;
  readonly workstreamId?: string;
  readonly kind: AskKind;
  readonly key: string;
  readonly class: AskClass;
  readonly text: string;
  readonly context?: string;
  readonly options?: readonly AskOption[];
  readonly recommendation?: string;
  readonly recommendationWhy?: string;
  readonly steps?: readonly Step[];
  /** do: the check the hub runs once ticked done (a CheckSpec; the card only needs to know there is one). */
  readonly verify?: { readonly type: string };
  readonly gated?: GatedRunSpec;
  readonly permission?: ToolPermission;
  /** secret: `env:<machineId>:<path>` or `file:<machineId>:<path>`. */
  readonly sink?: string;
  /** secret with an env: sink, when the variable is not the one its key names. */
  readonly envName?: string;
  readonly evidence?: string;
  readonly blocks: string;
  readonly proceededOnRec: boolean;
  readonly state: AskState;
  readonly answer?: AskAnswer;
  readonly decisionId?: string;
  readonly createdAt: string;
}

export interface AsksListOutput {
  readonly asks: readonly Ask[];
}

export type InboxReplyOutcome = "answered" | "skipped" | "withdrawn" | "later" | "retired" | "pref";

export interface InboxReplyApplied {
  readonly number?: number;
  readonly askId?: string;
  readonly outcome: InboxReplyOutcome;
  readonly value?: string;
  readonly label?: string;
  readonly kind?: AskAnswerKind;
  readonly decisionId?: string;
  readonly undoUntil?: string;
}

export interface InboxReplyOutput {
  readonly parsed: boolean;
  readonly batchId?: string;
  readonly echo?: string;
  readonly applied: readonly InboxReplyApplied[];
  readonly hint?: string;
}

export interface InboxUndoOutput {
  readonly ask: Ask;
}

export interface ProjectSummary {
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
}

export interface OrderCard {
  readonly workstreamId: string;
  readonly projectRef: ProjectRef;
  readonly title: string;
}

export interface OrdersBoardOutput {
  readonly orders: readonly OrderCard[];
}

export type MachineStatus = "online" | "offline" | "degraded";

/** The snapshot's machines, as far as secret asks need them. */
export interface Machine {
  readonly machineId: string;
  readonly name: string;
  readonly status: MachineStatus;
  /** Absent: the node takes no secrets (yet). */
  readonly boxPubKey?: string;
}
