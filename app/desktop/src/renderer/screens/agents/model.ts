// What the panel's agents show, as plain view data: one project's agents, the headline, and one line per step of an
// agent's work. Pure, so it is unit-tested.
import type { WorkStep } from "../../../shared/contracts";
import type { LiveAgent } from "../../src/data/selectors";

/**
 * One project's agents, those waiting on you first, then the data layer's order (oldest first), so a row moves only
 * when it starts or stops needing you. Not the lead: its chat is beside them.
 */
export const projectAgents = (agents: readonly LiveAgent[], project: string): readonly LiveAgent[] => {
  const mine = agents.filter((a) => a.project === project && a.row.role !== "lead");
  return [...mine.filter((a) => a.row.status === "waiting"), ...mine.filter((a) => a.row.status !== "waiting")];
};

/**
 * "18 working · 1 needs you · 1 queued", the leads not counted, so it agrees with the sidebar's count; empty
 * when none of the three.
 */
export const headline = (agents: readonly LiveAgent[]): string => {
  let working = 0;
  let waiting = 0;
  let queued = 0;
  for (const { row } of agents) {
    if (row.role === "lead") continue;
    if (row.status === "working" || row.status === "starting") working++;
    else if (row.status === "waiting") waiting++;
    else if (row.status === "queued") queued++;
  }
  return [working > 0 ? `${String(working)} working` : "", waiting > 0 ? `${String(waiting)} ${waiting === 1 ? "needs" : "need"} you` : "", queued > 0 ? `${String(queued)} queued` : ""]
    .filter((p) => p !== "")
    .join(" · ");
};

export interface StepLine {
  readonly words: string;
  /** The command, path or tool, set in mono. */
  readonly machine: string;
  readonly tone: "quiet" | "danger";
  /** After the machine text: "failed", "exit 1". */
  readonly outcome?: string | undefined;
}

const VERB: Readonly<Record<string, readonly [running: string, done: string]>> = {
  command: ["running", "ran"],
  file_change: ["editing", "edited"],
  tool_call: ["using", "used"],
};

/** One action as a quiet line in the past tense ("ran npm test"), or the present while it runs. */
export const actionLine = (step: Extract<WorkStep, { kind: "action" }>): StepLine => {
  const { action } = step;
  const [running, done] = VERB[action.kind] ?? ["", ""];
  const words = action.status === "running" ? running : done;
  if (!action.failed) return { words, machine: action.summary, tone: "quiet" };
  return { words, machine: action.summary, tone: "danger", outcome: action.exitCode === undefined ? "failed" : `failed, exit ${String(action.exitCode)}` };
};
