// The train's pure rules (the top of service.rs): the refusal shape, and how
// a head's checks read: green, pending or red, gated by the fast set, the checks that must report, and stalls.
import { parseMs } from "../store/time.ts";
import { type CheckRun, type CommitStatus, workflowRun } from "./checks.ts";
import { afterMergeOnly, fastSet, type TrainSettings } from "./settings.ts";
import { TRAIN_CONTEXT } from "./text.ts";

/** An enqueue refusal: what is wrong, and its fix. */
export type Refusal = { message: string; fix: string };

const GREEN = ["success", "neutral", "skipped"];

export const isRed = (run: CheckRun) => run.status === "completed" && !GREEN.includes(run.conclusion ?? "");

export type Checks = { kind: "none" } | { kind: "pending" } | { kind: "green" } | { kind: "red"; runs: CheckRun[] };

/** One read of a head's checks. A cancelled check is red only once nothing else is still running. */
export function checks(runs: CheckRun[]): Checks {
  if (runs.length === 0) return { kind: "none" };
  const running = runs.some((r) => r.status !== "completed");
  const red = runs.filter(isRed).filter((r) => !(running && r.conclusion === "cancelled"));
  if (red.length > 0) return { kind: "red", runs: red };
  return running ? { kind: "pending" } : { kind: "green" };
}

/** The checks the train judges a head by: its base's required checks and the repo's own additions. */
export class Fast {
  /** The base's required checks, the train's own status left out. */
  readonly required: string[];
  /** The fast set: `required` and the repo's `fastChecks`. */
  set: string[];

  constructor(
    required: string[],
    readonly settings: TrainSettings,
  ) {
    this.required = required.filter((n) => n !== TRAIN_CONTEXT);
    this.set = fastSet(settings, this.required);
  }

  holds(name: string): boolean {
    return this.set.includes(name);
  }
}

/**
 * The runs of `runs` the train waits on: those in the fast set, a cancelled one that is not required left out, and
 * any other that already failed, unless it is left for after the merge. An empty fast set is judged by every check;
 * `fast` undefined when the base's rules or the repo's settings can't be read: every check.
 */
export function gated(runs: CheckRun[], fast: Fast | undefined): CheckRun[] {
  if (!fast || fast.set.length === 0) return [...runs];
  const cancelled = (r: CheckRun) => r.conclusion === "cancelled";
  return runs.filter((r) =>
    fast.holds(r.name) ? !cancelled(r) || fast.required.includes(r.name) : isRed(r) && !cancelled(r) && !afterMergeOnly(fast.settings, r.name),
  );
}

/** The checks that must report on a head before it counts as green: its fast set, else the base's required checks. */
export function mustReport(fast: Fast | undefined, required: string[] | undefined): string[] | undefined {
  return fast ? [...fast.set] : required ? [...required] : undefined;
}

/**
 * Whether GitHub refused a merge for required checks that haven't reported on the head yet, or still run, rather than
 * for red ones or anything else. Read from GitHub's own words, the quoted check names left out.
 */
export function awaitsChecks(message: string): boolean {
  const words = message
    .split('"')
    .filter((_, i) => i % 2 === 0)
    .join('""')
    .toLowerCase();
  const about = words
    .split(/[.\n]/)
    .map((s) => s.trim())
    .filter((s) => s.includes("status check"));
  return (
    about.length > 0 &&
    about.every((s) => ["is ", "are "].some((verb) => ["expected", "in progress", "pending", "queued"].some((state) => s.endsWith(`${verb}${state}`))))
  );
}

/**
 * The checks `required` names that `runs` and `statuses` don't show green on a head, but the train's own status:
 * pending while one has no run or status yet, or its status is pending; red with each failed status.
 */
export function requiredChecks(runs: CheckRun[], statuses: CommitStatus[], required: string[]): Checks {
  const red: CheckRun[] = [];
  let waiting = false;
  for (const name of required.filter((n) => n !== TRAIN_CONTEXT)) {
    if (runs.some((r) => r.name === name)) continue;
    const s = statuses.find((x) => x.context === name);
    if (s?.state === "success") continue;
    if (s && (s.state === "failure" || s.state === "error")) {
      red.push({ id: 0, name, status: "completed", conclusion: s.state, html_url: s.target_url ?? null, started_at: null, completed_at: null, head_sha: null });
    } else waiting = true;
  }
  if (red.length > 0) return { kind: "red", runs: red };
  return waiting ? { kind: "pending" } : { kind: "green" };
}

/**
 * A head's commit statuses as check runs, for a head no check run reports on: CI another provider reports (CircleCI,
 * Buildkite, Jenkins). Those of the fast set where there is one, else every status; never the train's own.
 */
export function statusRuns(statuses: CommitStatus[], fast: Fast): CheckRun[] {
  return statuses
    .filter((s) => s.context !== TRAIN_CONTEXT && (fast.set.length === 0 || fast.holds(s.context)))
    .map((s) => {
      const pending = s.state === "pending";
      return { id: 0, name: s.context, status: pending ? "in_progress" : "completed", conclusion: pending ? null : s.state, html_url: s.target_url ?? null, started_at: null, completed_at: null, head_sha: null };
    });
}

/**
 * GitHub's words for a refusal on one line: a ruleset's come as a heading and a line per rule, blank lines between.
 */
export function oneLine(message: string): string {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.map((l, i) => (i < lines.length - 1 && !/[.:;!?]$/.test(l) ? `${l}:` : l)).join(" ");
}

/** GitHub's words for a merge it refuses by a rule no retry of the train's satisfies; each lowercase. */
const RULE_REFUSALS = ["merge queue", "verified signature", "must be resolved", "not authorized to push"];

/**
 * Whether GitHub refused a merge for a rule the train can't satisfy and never will by trying again: GitHub's merge
 * queue, signed commits, unresolved conversations, a push restriction.
 */
export function ruleRefusal(message: string): boolean {
  const words = message.toLowerCase();
  return RULE_REFUSALS.some((r) => words.includes(r));
}

/** How many times the train re-runs one job whose required check reads cancelled before it counts it red. */
export const CANCELLED_RERUNS = 2;

/**
 * The checks on a head GitHub's ruleset may read as cancelled: in some workflow run, the newest run of a check
 * `required` names. All of `runs` as GitHub lists them; `required` undefined when the base's rules can't be read.
 */
export function cancelledRequired(runs: CheckRun[], required: string[] | undefined): CheckRun[] {
  const newest = new Map<string, CheckRun>();
  for (const r of runs) {
    const key = `${workflowRun(r) ?? ""}\u0000${r.name}`;
    const seen = newest.get(key);
    if (!seen || r.id > seen.id) newest.set(key, r);
  }
  return [...newest.values()]
    .filter((r) => r.conclusion === "cancelled")
    .filter((r) => required === undefined || required.includes(r.name))
    .sort((a, b) => a.id - b.id);
}

export const short = (sha: string) => sha.slice(0, 12);

/** Every check in `red` was cancelled: no failure, but a run superseded or stopped (D191). */
export const allCancelled = (red: CheckRun[]) => red.every((r) => r.conclusion === "cancelled");

/** How CI on a head ran out of time. */
export type Stall =
  /** No check reported within `ciTimeout`. */
  | { kind: "no_checks" }
  /** Its checks, this many, all waited `ciQueueCeiling` for runners and none started. */
  | { kind: "queued"; count: number }
  /** It ran for `ciTimeout` from its first check's start without finishing. */
  | { kind: "running" }
  /** Its checks finished green, but these of its fast set never reported; `all` when all are required ones. */
  | { kind: "unreported"; names: string[]; all: boolean }
  /** These checks the project or the repo added to its fast set never ran: their jobs were renamed or removed. */
  | { kind: "never_ran"; names: string[] }
  /** These checks the base requires have no job in its tree. */
  | { kind: "removed"; names: string[] };

/** Whether a check run has a runner. */
const taken = (run: CheckRun) => run.status === "in_progress" || run.status === "completed";

/** When a head's CI started running: the earliest start on a check a runner took; `fallback` without stamps. */
export function runningSince(runs: CheckRun[], fallback: number): number | undefined {
  const took = runs.filter(taken);
  if (took.length === 0) return undefined;
  const starts = took.map((r) => (r.started_at ? parseMs(r.started_at) : undefined)).filter((s): s is number => s !== undefined);
  return starts.length > 0 ? Math.min(...starts) : fallback;
}
