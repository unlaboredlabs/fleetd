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

// The retired wakes and digests were notes to the lead; "wake" and "digest" are fleetd's words, not the user's.
const NOTE = /^(?:wake|digest):\s*(.+)$/iu;
const NOTE_WORDS = /\b(?:wakes?|digests?)\b/iu;

/** A retired prompt's name in plain words: "Wake: task finished" is the lead's "task finished" note. */
export const oldPromptName = (o: RetiredPromptOverride): string => {
  const note = NOTE.exec(o.title.trim())?.[1];
  return note === undefined ? o.title : `the lead's "${note}" note`;
};

/** "Your edit to the lead's "task finished" note (hub-wide) no longer applies." fleetd never moves an edit itself. */
export const orphanHeadline = (o: RetiredPromptOverride, projects: ReadonlyArray<ProjectSummary> | undefined): string =>
  `Your edit to ${oldPromptName(o)} (${editScopeWords(o, projects)}) no longer applies.`;

/** What to do with it, in one line. */
export function orphanAdvice(o: RetiredPromptOverride): string {
  const target = targetName(o);
  if (target) return `fleetd doesn't send it any more. If you still want what it said, copy it into ${target}.`;
  return "fleetd doesn't send it any more, and no other prompt takes its place. Copy what you still need into your instructions.";
}

/** The hub's one-line reason, ending in one full stop; its reason for the retired notes, in plain words. */
export const whyLine = (o: RetiredPromptOverride): string => {
  if (NOTE_WORDS.test(o.why) || NOTE.test(o.title.trim())) return "Notes to the lead are now fixed event lines that fleetd writes.";
  const t = o.why.trim();
  const capital = t.charAt(0).toUpperCase() + t.slice(1);
  return capital === "" || /[.?!…]$/u.test(capital) ? capital : `${capital}.`;
};
