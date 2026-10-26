// Settings → Projects → Merge train, the parts with no React: a draft of the two lists of checks and the settings it
// saves. The hub checks the same rules (project_settings.rs TrainSettings); these only say so before a call.
import type { TrainSettings } from "../../../shared/contracts";

/** project_settings.rs TRAIN_CHECKS_MAX. */
export const TRAIN_CHECKS_MAX = 50;

/** The fields as typed: one check a line. */
export type TrainDraft = { readonly fast: string; readonly after: string };

export const trainDraftOf = (train: TrainSettings | undefined): TrainDraft => ({
  fast: (train?.fastChecks ?? []).join("\n"),
  after: (train?.afterMerge ?? []).join("\n"),
});

const checks = (text: string): string[] => [
  ...new Set(
    text
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .filter((l) => l !== ""),
  ),
];

export type TrainResult = { readonly ok: true; readonly train: Required<TrainSettings> } | { readonly ok: false; readonly problem: string };

/** The settings the draft saves, or why they can't be saved. */
export function trainFrom(draft: TrainDraft): TrainResult {
  const fastChecks = checks(draft.fast);
  const afterMerge = checks(draft.after);
  for (const list of [fastChecks, afterMerge]) {
    if (list.length > TRAIN_CHECKS_MAX) return { ok: false, problem: `At most ${TRAIN_CHECKS_MAX} checks a list.` };
    const long = list.find((c) => c.length > 200);
    if (long !== undefined) return { ok: false, problem: `${long.slice(0, 40)}… is over 200 characters.` };
  }
  return { ok: true, train: { fastChecks, afterMerge } };
}

/** The draft saves something other than `train`. */
export const trainChanged = (draft: TrainDraft, train: TrainSettings | undefined): boolean => {
  const next = trainFrom(draft);
  if (!next.ok) return true;
  const same = (a: string[], b: string[] | undefined) => a.join("\n") === (b ?? []).join("\n");
  return !same(next.train.fastChecks, train?.fastChecks) || !same(next.train.afterMerge, train?.afterMerge);
};
