// The ask card's helpers, mirroring fleetd_contracts::ledger (Ask::choices, AskOption::display_label,
// humanize_key, AskAnswer::display) so the app and the hub word an ask the same way.
import type { Ask, AskAnswer, AskOption } from "./generated/contracts";

/** "a-monthly-vs-week" → "A monthly vs week". Text that is not a slug (spaces or capitals already) stays as it is. */
export const humanizeKey = (key: string): string => {
  if (!/^[a-z0-9._-]+$/u.test(key)) return key;
  const words = key.replace(/[-_.]/gu, " ").trim();
  return words === "" ? key : words.charAt(0).toUpperCase() + words.slice(1);
};

/** What the human reads for an option: its label, or the humanized key on an ask stored before labels. */
export const displayLabel = (option: AskOption): string => option.label ?? humanizeKey(option.key);

/**
 * The options as the card lists them: the recommended one first, then the rest, never twice. A recommendation that
 * is not one of the options (old free-text asks) becomes a bare first option.
 */
export const choices = (ask: Ask): AskOption[] => {
  const options = ask.options ?? [];
  const rec = ask.recommendation;
  if (rec === undefined) return options;
  const recommended = options.find((o) => o.key === rec) ?? { key: rec };
  return [recommended, ...options.filter((o) => o.key !== rec)];
};

/** "You chose: …": the picked option's label, the human's own words, or the recommendation a skip kept. */
export const answerDisplay = (answer: AskAnswer, ask: Ask): string => {
  const label = (key: string): string => {
    const option = ask.options?.find((o) => o.key === key);
    return option === undefined ? humanizeKey(key) : displayLabel(option);
  };
  switch (answer.kind) {
    case "text":
      return answer.value;
    case "skip":
      return `Skipped for now (lead keeps: ${label(answer.value)})`;
    default:
      return label(answer.value);
  }
};
