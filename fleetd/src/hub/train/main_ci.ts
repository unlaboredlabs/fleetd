// What Status needs from GitHub beyond the train's own reads: main-branch CI
// per train repo, read in the train's pass at most once a minute.
import type { CiState } from "../../shared/contracts.ts";
import { type CheckRun, workflowRun } from "./checks.ts";
import { checks } from "./rules.ts";

export const MAIN_CI_EVERY_MS = 60_000;

/** The events of workflow runs a person or a schedule started (a release build, a nightly), not a push or a merge. */
export const NOT_THE_MERGES = ["workflow_dispatch", "schedule"];

/**
 * The base's own checks among `runs` on its head: without those of the workflow runs a person or a schedule started
 * there (`events`, the commit's runs and their events), which check nothing the merges did.
 */
export function mergesOwn(runs: CheckRun[], events: [number, string][]): CheckRun[] {
  const theirs = new Set(events.filter(([, event]) => NOT_THE_MERGES.includes(event)).map(([id]) => id));
  return runs.filter((r) => {
    const run = workflowRun(r);
    return run === undefined || !theirs.has(run);
  });
}

/** Main-branch CI of one repo as last read. */
export type MainCi = {
  sha: string;
  state: CiState;
  /** Failing check names, at most 10. */
  failing: string[];
  /** When `state` last changed. */
  sinceMs: number;
  /** The last answer from GitHub for it. */
  asOfMs: number;
};

/** The train's rule for a head, applied to the base: no runs yet is pending. */
export function ciState(runs: CheckRun[]): [CiState, string[]] {
  const c = checks(runs);
  if (c.kind === "red") return ["red", c.runs.map((r) => r.name).slice(0, 10)];
  if (c.kind === "green") return ["green", []];
  return ["pending", []];
}

type RepoCi = { base?: string; lastTryMs?: number; latest?: MainCi };

export class GithubSync {
  private readonly ci = new Map<string, RepoCi>();

  private entry(repo: string): RepoCi {
    let e = this.ci.get(repo);
    if (!e) {
      e = {};
      this.ci.set(repo, e);
    }
    return e;
  }

  /** Whether this pass reads main CI; marks the try when it does. */
  takeDue(repo: string, nowMs: number): boolean {
    const e = this.entry(repo);
    const due = e.lastTryMs === undefined || nowMs - e.lastTryMs >= MAIN_CI_EVERY_MS;
    if (due) e.lastTryMs = nowMs;
    return due;
  }

  base(repo: string): string | undefined {
    return this.ci.get(repo)?.base;
  }

  setBase(repo: string, base: string): void {
    this.entry(repo).base = base;
  }

  /** Keeps a read; true when the state changed. */
  record(repo: string, sha: string, state: CiState, failing: string[], nowMs: number): boolean {
    const e = this.entry(repo);
    const changed = e.latest === undefined || e.latest.state !== state;
    const sinceMs = e.latest && !changed ? e.latest.sinceMs : nowMs;
    e.latest = { sha, state, failing, sinceMs, asOfMs: nowMs };
    return changed;
  }

  mainCi(repo: string): MainCi | undefined {
    return this.ci.get(repo)?.latest;
  }
}
