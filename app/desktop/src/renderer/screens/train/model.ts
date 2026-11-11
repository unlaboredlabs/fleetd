// What merges now on a project's merge train, from the hub's changes (changes_list) and its PRs (pr_list): the head of
// each repo's train, one PR or a batch, and the stage it is at, with its checks' lines. The line behind it and what
// landed are the Shipping list's own rows (prs/listModel), from pr_list. Pure, so the shape is tested on its own. No
// ETAs: only when each thing happened.
import type { Change, ChangesListInput, ChangesListOutput, ChangeState, ChecksSummary, PrCheck, PrRow, ProjectRef } from "../../../shared/contracts";

/** On the train: in line, then merging. What merges now is among these. */
export const LINE_STATES = ["queued", "reviewing", "ready", "rebasing", "ci", "merging"] as const satisfies readonly ChangeState[];
/** The hub's most per read (changes_list's limit). */
const READ_MAX = 100;

/** The card's changes_list reads: the line, each state whole, so what merges now is never cut by how many wait. */
export const lineReads = (project: ProjectRef): ChangesListInput[] => LINE_STATES.map((state) => ({ projectRef: project, state, limit: READ_MAX }));

/** The reads' answers as one list, each change once (one that moved between two reads, the newer). */
export const changesOf = (answers: readonly ChangesListOutput[]): Change[] => {
  const byId = new Map<string, Change>();
  for (const c of answers.flatMap((a) => a.changes)) {
    const had = byId.get(c.changeId);
    if (had === undefined || had.updatedAt < c.updatedAt) byId.set(c.changeId, c);
  }
  return [...byId.values()];
};

/** The stage of what merges now: brought up to date with the base, its CI run, the merge itself. */
export type Stage = "rebasing" | "ci" | "merging";

export interface TrainPr {
  readonly changeId: string;
  readonly repo: string;
  readonly number: number;
  /** GitHub's title, else its head branch (a PR the PR list doesn't have). */
  readonly title: string;
  /** When the train last moved it. */
  readonly at: string;
  readonly checks?: ChecksSummary;
}

/** What merges now: one PR, or a batch of them that goes through one CI run together. */
export interface Moving {
  readonly stage: Stage;
  readonly prs: readonly TrainPr[];
  /** When it entered this stage. */
  readonly since: string;
}

const STAGES: readonly Stage[] = ["rebasing", "ci", "merging"];
const isStage = (s: string): s is Stage => (STAGES as readonly string[]).includes(s);

const repoKey = (repo: string): string => repo.toLowerCase();
const prKey = (repo: string, number: number): string => `${repoKey(repo)}#${number}`;

const byPosition = (a: Change, b: Change): number =>
  (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.createdAt.localeCompare(b.createdAt);

/**
 * What merges now, one per repo whose train has something in flight, the biggest batch first. `changes` as
 * changes_list sends them; `prs` the project's PR list (undefined while it loads or when it failed: the PRs then read
 * by branch, without checks).
 */
export const movingNow = (changes: readonly Change[], prs: readonly PrRow[] | undefined): { readonly repo: string; readonly moving: Moving }[] => {
  const rows = new Map((prs ?? []).map((r) => [prKey(r.repo, r.number), r]));
  const trainPr = (c: Change): TrainPr => {
    const row = rows.get(prKey(c.repo, c.prNumber));
    const title = row?.title !== undefined && row.title !== "" ? row.title : c.branch;
    return { changeId: c.changeId, repo: c.repo, number: c.prNumber, title, at: c.updatedAt, ...(row?.checks === undefined ? {} : { checks: row.checks }) };
  };
  const byRepo = new Map<string, Change[]>();
  // In flight together means one batch: a serial train has only its head in flight.
  for (const c of changes.filter((c) => isStage(c.state))) {
    const k = repoKey(c.repo);
    byRepo.set(k, [...(byRepo.get(k) ?? []), c]);
  }
  return [...byRepo.values()]
    .map((of) => {
      const inFlight = of.toSorted(byPosition);
      return {
        repo: inFlight[0]?.repo ?? "",
        moving: {
          // A batch's members move together; mid-move, it is where the one furthest behind is.
          stage: STAGES.find((s) => inFlight.some((c) => c.state === s)) ?? "rebasing",
          prs: inFlight.map(trainPr),
          since: inFlight.map((c) => c.updatedAt).toSorted().at(-1) ?? "",
        },
      };
    })
    .toSorted((a, b) => b.moving.prs.length - a.moving.prs.length || a.repo.localeCompare(b.repo));
};

export const STAGE_WORD: Readonly<Record<Stage, string>> = {
  rebasing: "Rebasing",
  ci: "Running CI",
  merging: "Merging",
};

/** One line under the stage: what the train is doing at it. */
export const stageLine = (m: Moving): string => {
  const one = m.prs.length === 1;
  switch (m.stage) {
    case "rebasing":
      return one ? "Bringing it up to date with the base." : `Building one branch from ${m.prs.length} PRs on the base.`;
    case "ci":
      return one ? "CI runs on it as it would land." : `One CI run for all ${m.prs.length}; green, they land together.`;
    case "merging":
      return one ? "CI passed; it is landing now." : `CI passed; all ${m.prs.length} land as one commit.`;
  }
};

export type CheckTone = "failed" | "working" | "done" | "idle";
export interface CheckLine {
  readonly name: string;
  readonly word: string;
  readonly tone: CheckTone;
}

/** A check run's state as a word and tone: failed, running, passed, or GitHub's own word for the rest. */
const checkLine = (c: PrCheck): CheckLine => {
  const conclusion = c.conclusion?.replaceAll("_", " ");
  if (c.state === "failing") return { name: c.name, word: conclusion !== undefined && conclusion !== "failure" ? conclusion : "failed", tone: "failed" };
  if (c.state === "pending") return { name: c.name, word: "running", tone: "working" };
  if (c.state === "passing") {
    return conclusion === undefined || conclusion === "success" ? { name: c.name, word: "passed", tone: "done" } : { name: c.name, word: conclusion, tone: "idle" };
  }
  return { name: c.name, word: conclusion ?? "", tone: "idle" };
};

const CHECK_ORDER: Readonly<Record<CheckTone, number>> = { failed: 0, working: 1, done: 2, idle: 3 };

/** The head's checks, failed first, then running, then passed; `max` of them, and how many more passed or were skipped. */
export const checkLines = (checks: readonly PrCheck[], max = 6): { readonly shown: readonly CheckLine[]; readonly more: number } => {
  const lines = checks.map(checkLine).toSorted((a, b) => CHECK_ORDER[a.tone] - CHECK_ORDER[b.tone] || a.name.localeCompare(b.name));
  // Failed and running ones always show; passed ones fill what is left of `max`.
  const must = lines.filter((l) => l.tone === "failed" || l.tone === "working").length;
  const shown = lines.slice(0, Math.max(max, must));
  return { shown, more: lines.length - shown.length };
};
