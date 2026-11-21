// What a worktree's setup ran and the words its agent hears about it (setup.ts runs it): no file or process, so a hosted
// box tells its agent the same.
import type { WorktreeSetup } from "../../shared/contracts.ts";
import { tailUtf16 } from "../text.ts";

export const SETUP_TIMEOUT_SEC = 600;

/** What a worktree is set up with: the hub's setup, or a reader's own (warm.ts `readerSetup`) with a shorter limit. */
export type Plan = WorktreeSetup & { timeoutSec?: number };

export type Ran = { command: string; exitCode: number | null; outputTail: string; timedOut: boolean; tookMs: number };
export type Outcome = { kind: "done"; ran: Ran[] } | { kind: "reused" } | { kind: "image"; builtAt: string } | { kind: "failed"; ran: Ran[]; skipped: string[] };

/** The computer image a session's box starts from (../place/image.ts Choice). */
export type FromImage = { builtAt: string; worktree: boolean };

/** "exited 1 after 12 s", "passed its 600 s limit", "ended by a signal after 3 s". */
export const how = (r: Ran, timeoutSec: number) =>
  r.timedOut ? `passed its ${timeoutSec} s limit` : r.exitCode !== null ? `exited ${r.exitCode} after ${Math.floor(r.tookMs / 1000)} s` : `ended by a signal after ${Math.floor(r.tookMs / 1000)} s`;

export const timeoutOf = (plan: Plan) => plan.timeoutSec ?? SETUP_TIMEOUT_SEC;

const code = (command: string) => (command.includes("`") ? `\`\`${command}\`\`` : `\`${command}\``);
const tail = (text: string, max: number) => tailUtf16(text.trimEnd(), max);

/** What the agent hears first about setup. `again`: it ran before the agent went on, not before it started. */
export function note(outcome: Outcome, timeoutSec: number, again: boolean): string | undefined {
  const when = again ? "before you went on" : "before you started";
  if (outcome.kind === "reused") return "Setup did not run again: this worktree was set up before with the same commands and inputs.";
  if (outcome.kind === "image") return `Setup did not run: your machine started from the bot's computer image, built at ${outcome.builtAt} by these setup commands with the same inputs.`;
  if (outcome.kind === "done")
    return outcome.ran.length ? `Setup ran in this worktree ${when}: ${outcome.ran.map((r) => `${code(r.command)} (${how(r, timeoutSec)})`).join(", ")}.` : undefined;
  const last = outcome.ran[outcome.ran.length - 1];
  if (!last) return undefined;
  let text = `Setup failed in this worktree ${when}, and you were started anyway: ${code(last.command)} ${how(last, timeoutSec)}.`;
  if (outcome.skipped.length) text += ` Not run after it: ${outcome.skipped.map(code).join(", ")}.`;
  return `${text} The end of its output:\n\`\`\`\n${tail(last.outputTail, 1500)}\n\`\`\`\nFix what you need, or tell your lead if you can't.`;
}
