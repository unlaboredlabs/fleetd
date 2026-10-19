// The status doc's types are the generated contracts (src/shared/contracts, from crates/fleetd-contracts), with the
// progress model from #169. Wire enums there are open: a value this build doesn't know renders a generic fallback.
// No time estimates in the product (notes/no-time-product-brief.md): the doc's retired `eta` fields are never read.
import type { StatusDoc, StatusGetOutput, StatusScope } from "../../../shared/contracts";

export type {
  CiState,
  DoneRow,
  Gate,
  Headline,
  Health,
  HealthCi,
  HealthMachine,
  HealthUsage,
  InProgressRow,
  ItemStage,
  Marker,
  MoreCounts,
  NextRow,
  PlanningState,
  Progress,
  ProgressEstimate,
  ProgressPoint,
  Risk,
  RiskRule,
  ScopePart,
  Since,
  StaleMark,
  StaleSource,
  StatusDoc,
  StatusGetOutput,
  StatusScope,
  StatusSteer,
  Timestamp,
} from "../../../shared/contracts";

export const scopeKey = (scope: StatusScope): string => {
  switch (scope.kind) {
    case "fleet":
      return "fleet";
    case "project":
      return `project:${scope.projectRef.machineId}/${scope.projectRef.projectId}`;
    case "order":
      return `order:${scope.workstreamId}`;
  }
};

// The renderer never trusts a call's output blindly: these check the few fields the view's logic branches on, so a
// shape mismatch shows as a failed answer (with Retry) rather than a crash mid-render.
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export const asDoc = (v: unknown): StatusDoc | undefined =>
  isRecord(v) &&
  isRecord(v.scope) &&
  typeof v.version === "number" &&
  typeof v.seq === "number" &&
  typeof v.now === "string" &&
  isRecord(v.progress) &&
  isRecord(v.headline) &&
  isRecord(v.health) &&
  Array.isArray(v.stale)
    ? (v as unknown as StatusDoc)
    : undefined;

export const asGetOutput = (v: unknown): StatusGetOutput | undefined => {
  const doc = isRecord(v) ? asDoc(v.doc) : undefined;
  return doc ? { doc } : undefined;
};

