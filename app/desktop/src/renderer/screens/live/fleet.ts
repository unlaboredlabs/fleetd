// A project's agents as structure, not a log: the writers without a PR, then one group per PR, then anyone else.
// Pure, so every count the strip shows comes from one place: the lanes and the PRs.
import type { AgentLane, ChangeState, PrRef } from "./contracts";
import { STAGE_WORD, isChecker, isFinal } from "./words";

export interface Group {
  readonly pr: PrRef;
  /** The writer that opened it, once known (finished, it names the PR without being drawn). */
  readonly writer?: AgentLane;
  readonly checksDone: number;
  readonly checksNeeded: number;
}

export interface Fleet {
  /** Writers without a PR yet, in row order. */
  readonly writers: readonly AgentLane[];
  readonly groups: readonly Group[];
  /** Anyone else drawn: a checker whose PR the card doesn't list. */
  readonly others: readonly AgentLane[];
}

const pastReview = (s: ChangeState): boolean =>
  s === "ready" || s === "rebasing" || s === "ci" || s === "merging" || s === "merged";

/** "review 1/3", "ready · 2/3 checks", "reviewed", "CI", "merged". */
export const groupLabel = (g: Group): string => {
  const all = g.checksDone >= g.checksNeeded;
  switch (g.pr.state) {
    case "queued":
    case "reviewing":
      return `review ${g.checksDone}/${g.checksNeeded}`;
    case "ready":
      return all ? "reviewed" : `ready · ${g.checksDone}/${g.checksNeeded} checks`;
    default:
      return STAGE_WORD[g.pr.state];
  }
};

/**
 * Groups `rows` (the lanes drawn now) under `prs`; `seen` is every lane the order has had, finished ones included,
 * for the counts and the writers that already left the rows.
 */
export const fleet = (rows: readonly AgentLane[], seen: readonly AgentLane[], prs: readonly PrRef[]): Fleet => {
  const prOf = (l: AgentLane) => l.pr?.number;
  const groups: Group[] = [...prs]
    .sort((a, b) => a.number - b.number)
    .map((pr) => {
      const wrote = (l: AgentLane) =>
        !isChecker(l.role) && ((pr.taskId !== undefined && l.taskId === pr.taskId) || prOf(l) === pr.number);
      // A row drawn now is fresher than one remembered.
      const writer = rows.find(wrote) ?? seen.find(wrote);
      const checkers = seen.filter((l) => isChecker(l.role) && prOf(l) === pr.number);
      // The PR's reviews, one count wherever it shows: what it needs (the hub's word, one for a PR fleetd lands),
      // done as the larger of the hub's clean verdicts and the reviewers seen finishing (the verdict count lags a
      // finished review). QA (and a verifier from an older hub) are checkers drawn under the PR, not reviews.
      const reviewers = checkers.filter((l) => l.role === "reviewer");
      const done = Math.max(pr.reviewsDone, reviewers.filter((l) => l.status === "done").length);
      const working = reviewers.filter((l) => !isFinal(l.status)).length;
      const needed = pr.reviewsNeeded > 0 ? pr.reviewsNeeded : reviewers.length;
      // Past review with no reviewer left at work (or none seen: the app joined late): every review is in.
      const checksDone = pastReview(pr.state) && working === 0 ? needed : Math.min(done, needed);
      return {
        pr,
        ...(writer ? { writer } : {}),
        checksDone,
        checksNeeded: needed,
      };
    });
  const grouped = (l: AgentLane) =>
    groups.some((g) => g.pr.number === prOf(l) || g.writer?.laneId === l.laneId);
  return {
    writers: rows.filter((l) => !isChecker(l.role) && !grouped(l)),
    groups,
    others: rows.filter((l) => isChecker(l.role) && !grouped(l)),
  };
};
