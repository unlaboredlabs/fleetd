// The Train tab's model: a project's merge train from the hub's changes (changes_list) and its PRs (pr_list) — what
// merges now and at which stage, the queue in train order with what holds each one, and the merges and refusals of
// late. Pure, so the shape is tested on its own. No ETAs: only when each thing happened.
import type { Change, ChangesListInput, ChangesListOutput, ChangeState, ChecksSummary, PrCheck, PrRow, ProjectRef } from "../../../shared/contracts";

/** On the train: in line, then merging. The tab's count reads only these. */
export const LINE_STATES = ["queued", "reviewing", "ready", "rebasing", "ci", "merging"] as const satisfies readonly ChangeState[];
/** ...and sent back to its writer, which the queue lists last. */
export const OPEN_STATES = [...LINE_STATES, "needs_rebase", "ci_failed"] as const satisfies readonly ChangeState[];
/** The hub's most per read (changes_list's limit). */
const READ_MAX = 100;

const read = (project: ProjectRef, state: ChangeState, limit = READ_MAX): ChangesListInput => ({ projectRef: project, state, limit });

/** The tab's count's reads: the line, each state whole. The pane's first reads are these, so the two share them. */
export const lineReads = (project: ProjectRef): ChangesListInput[] => LINE_STATES.map((state) => read(project, state));

/**
 * The pane's changes_list reads: each open state whole, so the line is never cut by how many merged since, then the
 * newest merges and refusals for Recent.
 */
export const trainReads = (project: ProjectRef): ChangesListInput[] => [
  ...lineReads(project),
  read(project, "needs_rebase"),
  read(project, "ci_failed"),
  read(project, "merged", 24),
  read(project, "refused", RECENT_MAX),
];

/**
 * The reads' answers (in trainReads' order) as one list, each change once (one that moved between two reads, the
 * newer), and whether an open state had more than one read holds.
 */
export const changesOf = (answers: readonly ChangesListOutput[]): { readonly changes: Change[]; readonly cut: boolean } => {
  const byId = new Map<string, Change>();
  for (const c of answers.flatMap((a) => a.changes)) {
    const had = byId.get(c.changeId);
    if (had === undefined || had.updatedAt < c.updatedAt) byId.set(c.changeId, c);
  }
  const cut = answers.some((a, i) => a.truncated === true && i < OPEN_STATES.length);
  return { changes: [...byId.values()], cut };
};

/** The stage of what merges now: brought up to date with the base, its CI run, the merge itself. */
export type Stage = "rebasing" | "ci" | "merging";
/** A waiting PR: its review not started, under review, reviewed and next in line, or held with a reason. */
export type Waiting = "queued" | "reviewing" | "ready" | "blocked";

export interface TrainPr {
  readonly changeId: string;
  readonly repo: string;
  readonly number: number;
  /** GitHub's title, else its head branch (a PR closed long enough ago that the PR list no longer has it). */
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

export interface QueueRow {
  readonly pr: TrainPr;
  readonly state: Waiting;
  /** Why it is blocked: the conflict, the failing checks, the hold. */
  readonly why?: string;
  /** The train's own words under it, as it gave them: the conflicting paths, the failing checks and their output. */
  readonly detail?: string;
  /** 1-based place in line, for the PRs the train has put in order. */
  readonly place?: number;
  /** Conflicted or failed its checks: back with its writer, off the line until a new head comes. */
  readonly sentBack?: true;
}

export type Recent =
  | { readonly kind: "merged"; readonly prs: readonly TrainPr[]; readonly at: string }
  | { readonly kind: "refused"; readonly pr: TrainPr; readonly why?: string; readonly at: string };

/** One repo's train. A project nearly always has one. */
export interface TrainView {
  readonly repo: string;
  readonly moving?: Moving;
  readonly queue: readonly QueueRow[];
  readonly recent: readonly Recent[];
}

/** Merges and refusals shown under Recent. */
export const RECENT_MAX = 8;

const STAGES: readonly Stage[] = ["rebasing", "ci", "merging"];
const isStage = (s: string): s is Stage => (STAGES as readonly string[]).includes(s);
const WAITING = new Set(["queued", "reviewing", "ready"]);
/** Sent back to its writer: off the line until a new head comes. */
const SENT_BACK = new Set(["needs_rebase", "ci_failed"]);
/** The train's prefix on a hold it keeps a ready PR under (hub/train/batch.rs). */
const HELD = "held: ";

const repoKey = (repo: string): string => repo.toLowerCase();
const prKey = (repo: string, number: number): string => `${repoKey(repo)}#${number}`;

/** The why as the person reads it: the train's text, without its "held: " tag or its markdown code marks. */
const whyOf = (change: Change): string | undefined => {
  const e = change.lastError?.trim().replaceAll(/`([^`]*)`/gu, "$1");
  if (e === undefined || e === "") return undefined;
  return e.startsWith(HELD) ? e.slice(HELD.length) : e;
};

const blockedWhy = (change: Change): { readonly why: string; readonly detail?: string } => {
  const said = whyOf(change);
  const detail = said === undefined ? {} : { detail: said };
  switch (change.state) {
    case "needs_rebase":
      return { why: said === undefined ? "Conflicts with the base; back with its writer" : "Conflicts with the base", ...detail };
    case "ci_failed":
      return { why: said === undefined ? "Checks failed; back with its writer" : "Checks failed", ...detail };
    default:
      return { why: said ?? "Held" };
  }
};

const byPosition = (a: Change, b: Change): number =>
  (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.createdAt.localeCompare(b.createdAt);
const newestFirst = (a: { readonly at: string }, b: { readonly at: string }): number => b.at.localeCompare(a.at);

/**
 * The project's trains, one per repo, busiest first. `changes` as changes_list sends them; `prs` the project's PR list
 * (undefined while it loads or when it failed: the rows then read by branch, without checks).
 */
export const trainViews = (changes: readonly Change[], prs: readonly PrRow[] | undefined): TrainView[] => {
  const rows = new Map((prs ?? []).map((r) => [prKey(r.repo, r.number), r]));
  const trainPr = (c: Change): TrainPr => {
    const row = rows.get(prKey(c.repo, c.prNumber));
    const title = row?.title !== undefined && row.title !== "" ? row.title : c.branch;
    return { changeId: c.changeId, repo: c.repo, number: c.prNumber, title, at: c.updatedAt, ...(row?.checks === undefined ? {} : { checks: row.checks }) };
  };

  const byRepo = new Map<string, Change[]>();
  for (const c of changes) {
    const k = repoKey(c.repo);
    byRepo.set(k, [...(byRepo.get(k) ?? []), c]);
  }

  const views: TrainView[] = [];
  for (const of of byRepo.values()) {
    const repo = of[0]?.repo ?? "";
    // In flight together means one batch: a serial train has only its head in flight.
    const inFlight = of.filter((c) => isStage(c.state)).toSorted(byPosition);
    const moving: Moving | undefined =
      inFlight.length === 0
        ? undefined
        : {
            // A batch's members move together; mid-move, it is where the one furthest behind is.
            stage: STAGES.find((s) => inFlight.some((c) => c.state === s)) ?? "rebasing",
            prs: inFlight.map(trainPr),
            since: inFlight.map((c) => c.updatedAt).toSorted().at(-1) ?? "",
          };

    const lined = of.filter((c) => WAITING.has(c.state)).toSorted(byPosition);
    const back = of.filter((c) => SENT_BACK.has(c.state)).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    let place = 0;
    const queue: QueueRow[] = [
      ...lined.map((c): QueueRow => {
        const held = c.state === "ready" && c.lastError?.startsWith(HELD) === true;
        const state: Waiting = held ? "blocked" : (c.state as Waiting);
        const at = c.position === undefined ? {} : { place: ++place };
        return { pr: trainPr(c), state, ...at, ...(held ? blockedWhy(c) : {}) };
      }),
      ...back.map((c): QueueRow => ({ pr: trainPr(c), state: "blocked", ...blockedWhy(c), sentBack: true })),
    ];

    // A batch lands as one squash commit: its members share the merged sha.
    const merged = new Map<string, TrainPr[]>();
    for (const c of of.filter((c) => c.state === "merged")) {
      const k = c.mergedSha ?? c.changeId;
      merged.set(k, [...(merged.get(k) ?? []), trainPr(c)]);
    }
    const recent: Recent[] = [
      ...[...merged.values()].map((prs): Recent => {
        const sorted = prs.toSorted((a, b) => a.number - b.number);
        return { kind: "merged", prs: sorted, at: sorted.map((p) => p.at).toSorted().at(-1) ?? "" };
      }),
      ...of
        .filter((c) => c.state === "refused")
        .map((c): Recent => {
          const why = whyOf(c);
          return { kind: "refused", pr: trainPr(c), at: c.updatedAt, ...(why === undefined ? {} : { why }) };
        }),
    ]
      .toSorted(newestFirst)
      .slice(0, RECENT_MAX);

    if (moving === undefined && queue.length === 0 && recent.length === 0) continue;
    views.push({ repo, ...(moving === undefined ? {} : { moving }), queue, recent });
  }
  const busy = (v: TrainView) => (v.moving === undefined ? 0 : v.moving.prs.length) + v.queue.length;
  return views.toSorted((a, b) => busy(b) - busy(a) || a.repo.localeCompare(b.repo));
};

/** PRs on the train: merging now or in line. Those sent back to their writer are off it until they return. */
export const onTrain = (views: readonly TrainView[]): number =>
  views.reduce((n, v) => n + (v.moving?.prs.length ?? 0) + v.queue.filter((q) => q.sentBack !== true).length, 0);

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

export const WAITING_WORD: Readonly<Record<Waiting, { readonly word: string; readonly tone: "working" | "quiet" | "idle" | "failed" | "needs-you" }>> = {
  queued: { word: "waiting for review", tone: "idle" },
  reviewing: { word: "reviewing", tone: "working" },
  ready: { word: "ready", tone: "quiet" },
  blocked: { word: "blocked", tone: "failed" },
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
