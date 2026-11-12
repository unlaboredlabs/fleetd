// The review gate's retries and how an approval carries to a new patch, without gh or the database (service.ts reads
// the diffs and records the outcome): the reviewer retries and their waits, and the outcome's decision and record.
import type { Rebase } from "./rebase.ts";

export const RETRIES = 1;
export const TOOLS_RETRIES = 6;
export const TOOLS_RETRY_FIRST_MS = 60_000;
export const TOOLS_RETRY_MAX_MS = 15 * 60_000;

/** How a patch after an approved head is re-reviewed, as `review_rebases` records it. */
export type Rebased = { fromTask: string; fromHead: string; fromBase: string; base: string; outcome: Rebase };

/** The wait before a new reviewer after the `failed`th whose tools failed. */
export function toolsWait(failed: number): number {
  const doublings = Math.min(Math.max(failed - 1, 0), 10);
  return Math.min(TOOLS_RETRY_FIRST_MS * 2 ** doublings, TOOLS_RETRY_MAX_MS);
}

/**
 * A new patch's outcome against its approved head, from the diffs' comparison: conflicts with more commits than the
 * approved head had is a change; with commits dropped, it is unchanged only when `samePatch` says the patch id, context
 * and all, is the approved one (asked only then).
 */
export async function carryOutcome(
  compared: Rebase,
  ownCommits: number,
  revCommits: number,
  dropped: number,
  samePatch: () => Promise<boolean>,
): Promise<Rebase> {
  if (compared.kind === "conflicts" && ownCommits > revCommits) return { kind: "changed" };
  if (compared.kind === "unchanged" && dropped > 0 && !(await samePatch())) return { kind: "changed" };
  return compared;
}

/** Whether the outcome carries the approval to the new patch. */
export const carries = (outcome: Rebase) => outcome.kind === "unchanged";

/** The conflicting files as `review_rebases.files` keeps them: one a line. */
export const filesOf = (outcome: Rebase) => (outcome.kind === "conflicts" ? outcome.files.join("\n") : "");

/** An outcome as `review_rebases` keeps it, read back. */
export const outcomeOfRow = (outcome: string, files: string): Rebase =>
  outcome === "unchanged" ? { kind: "unchanged" } : outcome === "conflicts" ? { kind: "conflicts", files: files.split("\n").filter(Boolean) } : { kind: "changed" };
