// A ready PR on the train by its label: one no task opened (Renovate's, Dependabot's, a workflow's) that carries
// `fleetd-train` opens its own order in the bot that has the repo, its brief made from the PR, and goes on the train as
// a writer's does: reviewed against that brief, CI-gated, merged as the bot's Who merges says. The order closes when
// the PR merges or closes (service.ts `update`). A fork's PR never goes, label or not.
import type { Brief } from "../../shared/contracts.ts";

export const TRAIN_LABEL = "fleetd-train";
/** The labelled order's one done-when: also how the train knows the order is one it opened for a label. */
export const LABEL_DONE_WHEN = "This pull request merges with its CI green (it carries the fleetd-train label).";
/** At most this much of the PR's description goes in the brief. */
const WHY_CHARS = 4_000;

export const trainLabelled = (labels: string[]) => labels.some((l) => l.toLowerCase() === TRAIN_LABEL);

/** The order's brief, from the PR's title and description: no person or lead wrote it. */
export function labelBrief(pull: { title: string; body: string }, prUrl: string): Brief {
  const body = pull.body.trim();
  return {
    goal: pull.title.trim() || prUrl,
    why: body ? [...body].slice(0, WHY_CHARS).join("") : "The pull request has no description.",
    pointers: [prUrl],
    constraints: ["The pull request's own title and description are its brief: judge it by them, its diff and its CI."],
    doneWhen: [LABEL_DONE_WHEN],
  };
}

/** Whether a brief is a labelled PR's order's (`labelBrief`). */
export const isLabelBrief = (brief: Brief | undefined | null) => brief?.doneWhen.length === 1 && brief.doneWhen[0] === LABEL_DONE_WHEN;
