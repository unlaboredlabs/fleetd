// The prompt texts the train and the review gate send (src/hub/prompts: `PromptSet.render`). `HubHost` hands the
// train the hub's prompts; without a hub (tests), the shipped texts.
import type { Change, ProjectRef } from "../../shared/contracts.ts";
import { PromptSet } from "../prompts/set.ts";

export type Vars = Record<string, string | number>;

/** One resolved set of texts: `render(id, vars)` fills each `{{name}}`. */
export interface PromptSetLike {
  render(id: string, vars: Vars): string;
}

export interface PromptsLike {
  /** The texts for a message to the task's session: what it pinned at its start. */
  forTask(project: ProjectRef, taskId: string): PromptSetLike;
  /** The project's current texts (the hub's, without a project). */
  current(project?: ProjectRef): PromptSetLike;
}

/** The shipped texts, for every project and task. */
export const SHIPPED_PROMPTS: PromptsLike = { forTask: () => PromptSet.defaults(), current: () => PromptSet.defaults() };

/** The one message that sends a PR back to its author: what is wrong, a review's findings if any. */
export function fixYourPr(set: PromptSetLike, change: Change, problem: string, findings: string): string {
  const f = findings.trim() === "" ? "" : `\n\n${findings.trim()}\n`;
  return set.render("pr.fix", { pr: `${change.prUrl} (${change.changeId})`, problem, findings: f, branch: change.branch });
}
