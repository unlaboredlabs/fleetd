// The claim lines a lead reads in its wake. Pure.
import type { CheckResult, ClaimId, WorkstreamId } from "@fleetd/contracts";
import { describeCheck } from "../leads/digest.ts";

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** `done:<i>` matches CheckResult.checkIndex and `--serves done:<i>`. */
export const checkLabel = (r: Pick<CheckResult, "checkIndex" | "spec">) => `done:${r.checkIndex} (${oneLine(describeCheck(r.spec), 120)})`;

const failureLines = (r: CheckResult) => [
  `  ${checkLabel(r)}: ${r.result}${r.exitCode === undefined ? "" : `, exit ${r.exitCode}`}`,
  ...r.evidence
    .trim()
    .split("\n")
    .map((line) => `    > ${line}`.trimEnd()),
];

export const claimFailedLines = (t: {
  readonly claimId: ClaimId;
  readonly workstreamId: WorkstreamId;
  readonly failures: ReadonlyArray<CheckResult>;
}): string => {
  const first = t.failures[0]?.checkIndex ?? 0;
  return [
    `- Claim ${t.claimId} on ${t.workstreamId} failed; ${t.workstreamId} stays verifying. Checks that did not pass:`,
    ...t.failures.flatMap(failureLines),
    `  next: fix what failed (e.g. a task with --serves done:${first}), then \`fleetd claim done --workstream ${t.workstreamId}\` again.`,
  ].join("\n");
};

export const claimPassedLine = (t: { readonly claimId: ClaimId; readonly workstreamId: WorkstreamId }) =>
  `- Claim ${t.claimId} on ${t.workstreamId} passed: every done-when check passed, so ${t.workstreamId} is done.`;

/** One evidence line per failed claim, for the false-claim incident. */
export const failedClaimEvidence = (claimId: ClaimId, results: ReadonlyArray<CheckResult>) =>
  `${claimId} failed: ${results
    .filter((r) => r.result !== "pass")
    .map((r) => `done:${r.checkIndex} ${r.result}${r.exitCode === undefined ? "" : ` (exit ${r.exitCode})`}: ${oneLine(r.evidence, 200)}`)
    .join("; ")}`.slice(0, 2000);
