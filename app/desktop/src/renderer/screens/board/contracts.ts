// The hub shapes the board reads: the generated contracts (src/shared/contracts), plus the constants they carry.
export type {
  Activity,
  AgentLane,
  AgentRole,
  Ask,
  ChangeState,
  IntakeRef,
  LaneStatus,
  LiveFrame,
  LiveLane,
  LoginLimit,
  MachineLive,
  OrderCard,
  OrderPhase,
  OrdersBoardOutput,
  PlaybookName,
  PrChip,
  PrRef,
  ProjectRef,
  SlotState,
  Spark,
  TrainLive,
} from "../../../shared/contracts";
import type { OrderPhase } from "../../../shared/contracts";

/** fleetd_contracts::live::SPARK_BUCKET_SECS / SPARK_BUCKETS. */
export const SPARK_BUCKET_SECS = 2;
export const SPARK_BUCKETS = 30;

/** The board's sort order: the first match wins on the hub, and the board sorts by it. */
export const PHASE_ORDER: readonly OrderPhase[] = [
  "waiting_on_you",
  "failed",
  "stopped",
  "working",
  "reviewing",
  "merging",
  "verifying",
  "queued",
  "planning",
  "idle",
  "done",
];
