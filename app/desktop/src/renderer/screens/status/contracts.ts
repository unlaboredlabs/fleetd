// Status reads the generated contracts (src/shared/contracts, from crates/fleetd-contracts). A project's series
// (status_get) is read only for a bar's hover (why it fell), so it is checked before use: a shape mismatch shows no
// drops rather than breaking the row.
import type { StatusGetOutput } from "../../../shared/contracts";

export type { ProgressPoint, StaleMark } from "../../../shared/contracts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export const asGetOutput = (v: unknown): StatusGetOutput | undefined =>
  isRecord(v) && isRecord(v.row) && Array.isArray(v.series) ? v : undefined;
