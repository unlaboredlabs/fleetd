// Status reads the generated contracts (src/shared/contracts, from crates/fleetd-contracts). The project status doc
// is read only for a bar's hover (why it fell), so it is checked before use: a shape mismatch shows no drops rather
// than breaking the row.
import type { StatusDoc, StatusGetOutput } from "../../../shared/contracts";

export type { ProgressPoint, StaleMark, StatusDoc } from "../../../shared/contracts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export const asGetOutput = (v: unknown): StatusGetOutput | undefined => {
  const doc = isRecord(v) ? v.doc : undefined;
  return isRecord(doc) && isRecord(doc.progress) && typeof doc.now === "string" ? { doc: doc as unknown as StatusDoc } : undefined;
};
