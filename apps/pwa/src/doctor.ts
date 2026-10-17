import type { DoctorCheck } from "@fleetd/contracts";

// The Doctor section: the hub's setup checks, what needs attention first.

const RANK: Record<DoctorCheck["status"], number> = { fail: 0, warn: 1, unknown: 2, ok: 3 };

/** Failing checks first, then warnings, unknowns and passes, each in the hub's order. */
export const doctorOrder = (checks: ReadonlyArray<DoctorCheck>) =>
  checks.map((check, i) => ({ check, i })).toSorted((a, b) => RANK[a.check.status] - RANK[b.check.status] || a.i - b.i).map(({ check }) => check);

/** "Doctor: 2 need attention", "Doctor: all 12 checks pass", "Doctor: 10 pass, 2 not checked". */
export const doctorTitle = (checks: ReadonlyArray<DoctorCheck> | undefined) => {
  if (checks === undefined) return "Doctor";
  const attention = checks.filter((c) => c.status === "fail" || c.status === "warn").length;
  if (attention > 0) return `Doctor: ${attention} need${attention === 1 ? "s" : ""} attention`;
  const unknown = checks.filter((c) => c.status === "unknown").length;
  return unknown === 0 ? `Doctor: all ${checks.length} checks pass` : `Doctor: ${checks.length - unknown} pass, ${unknown} not checked`;
};

/** The list with a fixed check's fresh result in its place. */
export const withFixed = (checks: ReadonlyArray<DoctorCheck>, fixed: DoctorCheck) => checks.map((c) => (c.id === fixed.id ? fixed : c));
