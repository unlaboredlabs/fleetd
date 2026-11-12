// The shapes of the vault's audit log (audit.ts keeps its rows): what each use records, never a value.

export type AuditAction =
  | "fill"
  | "fill_refused"
  | "inject"
  | "deliver"
  | "reveal"
  | "create"
  | "update"
  | "delete"
  | "restore"
  | "share"
  | "import"
  | "rotate"
  | "unlock"
  | "purchase"
  | "adopt";
export type AuditOutcome = "pending" | "ok" | "failed" | "refused";

export type AuditData = {
  label?: string;
  kind?: string;
  fields?: string[];
  site?: string;
  frame?: string;
  host?: string;
  sessionId?: string;
  message?: string;
  typed?: boolean;
  purchaseId?: string;
  names?: string[];
  via?: string;
  to?: string[];
  count?: number;
};

export type AuditEntry = {
  n: number;
  atMs: number;
  itemId: string;
  action: AuditAction;
  outcome: AuditOutcome;
  personId?: string;
  deviceId?: string;
  machineId?: string;
  projectId?: string;
  threadId?: string;
  taskId?: string;
  workstreamId?: string;
  data: AuditData;
};

export type NewAudit = Omit<AuditEntry, "n">;

export const AUDIT_KEEP_MS = 365 * 24 * 3600_000;
