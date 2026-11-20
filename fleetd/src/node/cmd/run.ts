// A command run confined to a directory, on this machine (./index.ts runConfined) or in a box (../sandbox/box.ts run):
// what it asks and how it went. Box side (docs/CONTRIBUTING.md "The package").
export type ConfinedRun = {
  cwd: string;
  argv: string[];
  timeoutSec: number;
  /** The child's whole environment. Default: the scrubbed node environment. */
  env?: Record<string, string>;
  /** Values replaced by `[secret]` in the output, so they never leave the node. */
  scrub?: string[];
  /** Kills the run's process group: a lost link takes its commands with it. */
  signal?: AbortSignal;
};

export type RunOutcome = { exitCode: number | null; outputTail: string; timedOut: boolean; notRun?: string };
