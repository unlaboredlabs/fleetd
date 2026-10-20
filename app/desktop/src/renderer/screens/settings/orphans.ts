// Edits of prompts fleetd no longer has: how the Prompts page words them. Pure, so it is tested without a screen.
import { describe } from "./catalog";
import type { ProjectSummary, RetiredPromptOverride } from "./contracts";

/** Where an edit applied: hub-wide, or one project by its title. */
export function editScopeWords(o: RetiredPromptOverride, projects: ReadonlyArray<ProjectSummary> | undefined): string {
  if (o.scope !== "project" || !o.projectRef) return "hub-wide";
  const ref = o.projectRef;
  const p = projects?.find((x) => x.machineId === ref.machineId && x.projectId === ref.projectId);
  return `for ${p?.title ?? ref.projectId}`;
}

/** The prompt the edit's intent now belongs in, by its plain name. */
export const targetName = (o: RetiredPromptOverride): string | null =>
  o.suggestedTarget ? describe({ id: o.suggestedTarget, title: o.suggestedTarget, sentWhen: "" }).name : null;

/** "Your edit to Wake: task finished (hub-wide) no longer applies." fleetd never moves an edit itself. */
export const orphanHeadline = (o: RetiredPromptOverride, projects: ReadonlyArray<ProjectSummary> | undefined): string =>
  `Your edit to ${o.title} (${editScopeWords(o, projects)}) no longer applies.`;

/** What to do with it, in one line. */
export function orphanAdvice(o: RetiredPromptOverride): string {
  const target = targetName(o);
  if (target) return `fleetd doesn't send it any more. If you still want what it said, copy it into ${target}.`;
  return "fleetd doesn't send it any more, and no other prompt takes its place. Copy what you still need into your instructions.";
}

/** The hub's one-line reason, ending in one full stop. */
export const whyLine = (o: RetiredPromptOverride): string => {
  const t = o.why.trim();
  const capital = t.charAt(0).toUpperCase() + t.slice(1);
  return capital === "" || /[.?!…]$/u.test(capital) ? capital : `${capital}.`;
};
