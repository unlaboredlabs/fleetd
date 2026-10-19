// Done when: the brief's checks, each with the latest claim's result. A judge check carries the judge's verdict
// and its reason; any check that didn't pass carries its evidence.

import type { CheckOutcome, CheckSpec, Claim } from "../../../shared/contracts";

export type CheckState = "pending" | "passed" | "failed" | "error";

export interface DoneRow {
  readonly index: number;
  /** "Judge", "PR", "CI", "HTTP", "Command", "Test", "You confirm". */
  readonly kind: string;
  /** The check in words, wrapped in full. */
  readonly text: string;
  readonly state: CheckState;
  /** "passed", "failed", "could not run": the judge's word, or the check's. */
  readonly verdict?: string;
  /** The judge's reason, or the evidence of a check that didn't pass. */
  readonly reason?: string;
  readonly at?: string;
}

export function describeCheck(spec: CheckSpec): { kind: string; text: string } {
  switch (spec.type) {
    case "pr_merged":
      return { kind: "PR", text: spec.pr === undefined ? `A PR merged in ${spec.repo}` : `PR #${spec.pr} merged in ${spec.repo}` };
    case "ci_green":
      return { kind: "CI", text: `CI green on ${spec.repo}${spec.ref ? ` at ${spec.ref}` : ""}` };
    case "http":
      return { kind: "HTTP", text: `GET ${spec.url} answers ${spec.status}${spec.contains ? ` containing “${spec.contains}”` : ""}` };
    case "cmd":
      return { kind: "Command", text: `\`${spec.argv.join(" ")}\` on ${spec.machineId} exits ${spec.expectExit}` };
    case "test":
      return { kind: "Test", text: `\`${spec.testId}\` passes in ${spec.repo}` };
    case "judge":
      return { kind: "Judge", text: spec.criteria };
    case "human":
      return { kind: "You confirm", text: spec.question };
  }
}

const STATE: Readonly<Record<CheckOutcome, CheckState>> = { pass: "passed", fail: "failed", error: "error" };
const VERDICT: Readonly<Record<CheckOutcome, string>> = { pass: "passed", fail: "failed", error: "could not run" };

/** `claim` is the newest claim on the order, if any. */
export function doneRows(checks: readonly CheckSpec[], claim: Claim | undefined): DoneRow[] {
  return checks.map((spec, index) => {
    const { kind, text } = describeCheck(spec);
    const r = claim?.results.find((x) => x.checkIndex === index);
    if (r === undefined) return { index, kind, text, state: "pending" };
    const evidence = r.evidence.trim();
    const showReason = evidence !== "" && (r.result !== "pass" || spec.type === "judge" || spec.type === "human");
    return {
      index,
      kind,
      text,
      state: STATE[r.result],
      verdict: VERDICT[r.result],
      ...(showReason ? { reason: evidence } : {}),
      at: r.at,
    };
  });
}

/** "2 of 3 passed" / "not checked yet". */
export function doneSummary(rows: readonly DoneRow[]): string {
  const checked = rows.filter((r) => r.state !== "pending").length;
  if (checked === 0) return "not checked yet";
  return `${rows.filter((r) => r.state === "passed").length} of ${rows.length} passed`;
}
