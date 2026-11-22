// How onboarding (ConnectComputer) and Get started (start/state.ts) wait on hosted sandboxes coming up: a bounded wait,
// after which the screen says why in the hub's words, its fix, and offers Try again (the provider's key tested again,
// sandbox_test), rather than a spinner that never ends. Both read the runner's `degradedCause`, never its English.
import { useEffect, useState } from "react";
import { hostedRow, type HostedRunner } from "../../../shared/hostedRow";
import { specOf } from "../../../shared/providers";
import { settingsPath } from "../../../shared/settingsPages";

/** How long the screens wait for hosted sandboxes to be ready before they say they aren't. Tests set it; the QA build
 * waits a few seconds, so its screens reach the failure. */
export const HOSTED_WAIT = { ms: import.meta.env.VITE_FLEETD_QA === "1" ? 3_000 : 2 * 60_000 };

/** The hub's runner for hosted sandboxes, as the screens read it. */
export type RunnerState = HostedRunner;

/** The provider as the screens read it (sandbox_get). */
export type HostedProvider = Parameters<typeof hostedRow>[0];

/** Its sandboxes wait on a Claude account of the team's: the hub's cause, not its words. */
export const runnerNeedsClaude = (m: RunnerState | undefined): boolean => m?.status === "degraded" && m.degradedCause === "claude_login";

/** True once `waiting` has held for HOSTED_WAIT.ms without a break; `again` starts the wait over. */
export function useWaitedOut(waiting: boolean): { readonly over: boolean; readonly again: () => void } {
  // Each wait is a round; the one whose time ran out is `fired`. A break in the wait starts a new round.
  const [round, setRound] = useState(0);
  const [fired, setFired] = useState<number | null>(null);
  const [was, setWas] = useState(waiting);
  if (was !== waiting) {
    setWas(waiting);
    setRound((r) => r + 1);
  }
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setTimeout(() => setFired(round), HOSTED_WAIT.ms);
    return () => window.clearTimeout(timer);
  }, [waiting, round]);
  return { over: waiting && fired === round, again: () => setRound((r) => r + 1) };
}

/** Why the provider's sandboxes aren't ready after the wait, and what fixes it: the words its row in Hub › Machines
 * says (shared/hostedRow.ts) when it says what went wrong, else that they didn't come up. */
export function hostedProblem(p: HostedProvider, runner: RunnerState | undefined, cloud = false): { readonly reason: string; readonly fix: string } {
  const name = specOf(p.provider).name;
  const fallback = `If it keeps failing, check ${name} in ${settingsPath(cloud, "Machines")}.`;
  const row = hostedRow(p, runner);
  if (row.state === "failed" && row.text !== null) return { reason: row.text, fix: row.fix ?? fallback };
  return { reason: `${name}'s sandboxes didn't get ready.`, fix: fallback };
}
