// The hub shapes the live strip reads: the generated contracts (src/shared/contracts), plus the constants they carry.
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

/** fleetd_contracts::live::SPARK_BUCKET_SECS / SPARK_BUCKETS. */
export const SPARK_BUCKET_SECS = 2;
export const SPARK_BUCKETS = 30;
