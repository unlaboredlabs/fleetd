// Review tiers, the readiness gate, and the text reviewers and authors get. Pure; Reviews.ts feeds them the Change,
// its review tasks and what those recorded.
import type { Change, Task, Tier } from "@fleetd/contracts";

export type ReviewRole = "reviewer" | "verifier";
export type ReviewProvider = "claude" | "codex";

export interface PlannedReview {
  readonly role: ReviewRole;
  readonly provider: ReviewProvider;
}

/** S: none. M: one reviewer. L: two reviewers from fresh sessions, the second on Codex when there is one, plus a verifier. */
export const reviewPlan = (tier: Tier, codexAvailable: boolean): ReadonlyArray<PlannedReview> => {
  switch (tier) {
    case "S":
      return [];
    case "M":
      return [{ role: "reviewer", provider: "claude" }];
    case "L":
      return [
        { role: "reviewer", provider: "claude" },
        { role: "reviewer", provider: codexAvailable ? "codex" : "claude" },
        { role: "verifier", provider: "claude" },
      ];
  }
};

/** The planned reviews not yet spawned for this patch, given the roles already spawned for it. */
export const missingReviews = (plan: ReadonlyArray<PlannedReview>, spawned: ReadonlyArray<ReviewRole>): ReadonlyArray<PlannedReview> => {
  const left = new Map<ReviewRole, number>();
  for (const role of spawned) left.set(role, (left.get(role) ?? 0) + 1);
  return plan.filter((p) => {
    const n = left.get(p.role) ?? 0;
    if (n === 0) return true;
    left.set(p.role, n - 1);
    return false;
  });
};

/** A recorded verdict of one of the Change's review tasks, with its role. */
export interface RoleReview {
  readonly taskId: string;
  readonly role: ReviewRole;
  readonly patchId: string;
  readonly blocking: number;
  /** Verifiers only: their task ended with commands run, so the verdict rests on receipts. */
  readonly receipts: boolean;
}

export type Gate =
  | { readonly ready: true; readonly why: string }
  | { readonly ready: false; readonly waitingForHead: boolean; readonly why: string };

/**
 * The tier is satisfied for `patchId` when its required clean verdicts are bound to exactly that patch: M one reviewer,
 * L two distinct reviewers plus a verifier with receipts. Any blocking verdict on the patch holds it until a new head
 * changes the patch. `waived` is set when the polish-loop rule ended review for this patch.
 */
export const gate = (tier: Tier, patchId: string | undefined, reviews: ReadonlyArray<RoleReview>, waived?: string): Gate => {
  if (tier === "S") return { ready: true, why: "tier S needs no review" };
  if (patchId === undefined) return { ready: false, waitingForHead: false, why: "the patch id is not known yet" };
  const current = reviews.filter((r) => r.patchId === patchId);
  const blocked = current.filter((r) => r.blocking > 0);
  if (blocked.length > 0) {
    const by = blocked.map((r) => `${r.taskId} (${r.blocking})`).join(", ");
    return { ready: false, waitingForHead: true, why: `blocking findings from ${by}; waiting for a new head` };
  }
  if (waived !== undefined) return { ready: true, why: waived };
  const reviewers = new Set(current.filter((r) => r.role === "reviewer").map((r) => r.taskId)).size;
  const verified = current.some((r) => r.role === "verifier" && r.receipts);
  const needed = tier === "M" ? 1 : 2;
  if (reviewers < needed) return { ready: false, waitingForHead: false, why: `${reviewers}/${needed} clean reviews on this patch` };
  if (tier === "L" && !verified) return { ready: false, waitingForHead: false, why: "waiting for the verifier's clean verdict with receipts" };
  return { ready: true, why: `tier ${tier} reviews are clean on patch ${patchId.slice(0, 12)}` };
};

/** A verifier's verdict counts once its task ended done with commands run and no unverified claim. */
export const hasReceipts = (task: Task | undefined): boolean =>
  task?.state === "done" && (task.result?.receipts?.commands ?? 0) > 0 && task.result?.claimsUnverified !== true;

type ChangeRef = Pick<Change, "changeId" | "repo" | "prNumber" | "prUrl" | "tier" | "headSha" | "serves">;

const verdictLine = (sha: string, summary: string) =>
  `fleetd review verdict --task <your task id, from the first line> --sha ${sha} --blocking <n> --non-blocking <n> --summary "${summary}"`;

/**
 * A reviewer's or verifier's prompt: the PR diff ref and the tier rules. Tasks adds the brief's goal and done-when.
 * Never the author's narrative, so the PR description and comments are off limits too.
 */
export const reviewPrompt = (change: ChangeRef, role: ReviewRole): string => {
  const n = change.prNumber;
  const fetch = `git fetch origin pull/${n}/head`;
  if (role === "verifier") {
    return [
      `Verify pull request ${change.prUrl} (${change.repo}#${n}, tier ${change.tier}) at head ${change.headSha} by running the repo's tests on exactly that commit.`,
      "",
      `1. \`${fetch}\`, then \`git worktree add --detach "$(mktemp -d)" ${change.headSha}\` and work only in that worktree; never check anything out in the project's own checkout.`,
      "2. Find the repo's test command (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, package.json scripts, Makefile, the CI workflow) and run it with any install step it needs.",
      "3. Remove the worktree with `git worktree remove --force <dir>`.",
      "",
      "blocking = the number of test commands that failed, 0 when all passed. The hub counts the commands you ran and their exit codes; a verdict without them does not count.",
      "Do not read the PR description or comments. Do not change, commit or push anything.",
      "Finish with exactly one command, filled in:",
      verdictLine(change.headSha, "<the commands you ran and their exit codes; for failures, the failing tests>"),
    ].join("\n");
  }
  return [
    `Review pull request ${change.prUrl} (${change.repo}#${n}, tier ${change.tier}) at head ${change.headSha}. You are an independent reviewer: you get the diff and the brief, not the author's account.`,
    "",
    `Read the change yourself: \`gh pr diff ${n} --repo ${change.repo}\`, and files at that head with \`${fetch}\` then \`git show ${change.headSha}:<path>\`. Do not read the PR description or its comments; judge the diff against the goal and done-when below.`,
    "",
    `Rules for tier ${change.tier}:`,
    `- Blocking means the change is wrong, unsafe, or fails the done-when it serves (${change.serves}). Style, naming, polish and nice-to-haves are non-blocking.`,
    `- It serves ${change.serves} only: the other done-when checks are other PRs' work, never a finding here.`,
    "- One round: report everything you find now. A verdict with 0 blocking ends review for this patch.",
    "- Do not change, commit or push anything.",
    "Finish with exactly one command, filled in:",
    verdictLine(change.headSha, "<each blocking finding as path:line and what is wrong, then the non-blocking ones>"),
  ].join("\n");
};

/** The message that sends blocking findings back to the task that wrote the code. */
export const findingsMessage = (
  change: Pick<Change, "prUrl" | "branch">,
  verdict: { readonly taskId: string; readonly prHeadSha: string; readonly blocking: number; readonly nonBlocking: number; readonly summary: string },
): string =>
  [
    `Review ${verdict.taskId} of ${change.prUrl} at ${verdict.prHeadSha.slice(0, 12)} found ${verdict.blocking} blocking finding${verdict.blocking === 1 ? "" : "s"} (${verdict.nonBlocking} non-blocking):`,
    "",
    verdict.summary.trim(),
    "",
    `Fix the blocking findings on ${change.branch}, commit and push to the same PR. It is reviewed again once its patch changes, and the train will not merge it before then. Do not merge it yourself.`,
  ].join("\n");

/** One line, at most `max` characters. */
export const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
