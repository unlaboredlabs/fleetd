// The task profiles' page (Settings › Hub › Every project › Profiles) and a project's allowed ones, kept free of
// React: a profile's draft, what it checks before the hub does, and the calls it makes.
import type { Effort, Profile, ProfileCreateInput, ProfileModel, ProfileUpdateInput } from "../../../shared/contracts";

/** The name `spawn_agent` takes: as the hub checks it. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
export const NOTE_MAX = 300;

export const EFFORT_WORD: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

export interface ProfileDraft {
  readonly name: string;
  readonly note: string;
  readonly model: string;
  readonly effort: Effort;
  readonly fast: boolean;
  readonly default: boolean;
}

/** A new profile starts on the list's first model, at high, not fast. */
export const newDraft = (models: ReadonlyArray<ProfileModel>): ProfileDraft => ({
  name: "",
  note: "",
  model: models[0]?.id ?? "claude-opus-5-5",
  effort: "high",
  fast: false,
  default: false,
});

export const draftOf = (p: Profile): ProfileDraft => ({ name: p.name, note: p.note, model: p.model, effort: p.effort, fast: p.fast, default: p.default });

/** Whether Claude Code offers fast mode on `model`. */
export const hasFast = (models: ReadonlyArray<ProfileModel>, model: string): boolean => models.some((m) => m.id === model && m.fast);

/** The models to pick from: the list, and the one a profile already runs on when the list lacks it. */
export const modelChoices = (models: ReadonlyArray<ProfileModel>, current: string | undefined): ReadonlyArray<ProfileModel> =>
  current === undefined || models.some((m) => m.id === current) ? models : [...models, { id: current, fast: false }];

/** A model as a person reads it: its display name, else its id. */
export const modelWord = (models: ReadonlyArray<ProfileModel>, model: string): string => models.find((m) => m.id === model)?.displayName ?? model;

/** One line under a profile's name: its model, effort and fast mode. */
export const runsLine = (models: ReadonlyArray<ProfileModel>, p: Pick<Profile, "model" | "effort" | "fast">): string =>
  `${modelWord(models, p.model)} · ${EFFORT_WORD[p.effort].toLowerCase()} effort${p.fast ? " · fast" : ""}`;

/** What is wrong with the draft before the hub says it, and in which field, or nothing. `taken` are the other
 * profiles' names. */
export function problem(draft: ProfileDraft, taken: ReadonlyArray<string>): { field: "name" | "note"; text: string } | undefined {
  if (draft.name === "") return { field: "name", text: "Give it a name." };
  if (!NAME.test(draft.name)) return { field: "name", text: "Lowercase letters, digits, - _ and ., up to 32." };
  if (taken.includes(draft.name)) return { field: "name", text: `A profile is already named ${draft.name}.` };
  if (draft.note.includes("\n")) return { field: "note", text: "Keep it to one line." };
  if (draft.note.length > NOTE_MAX) return { field: "note", text: `Keep it to ${NOTE_MAX} characters.` };
  return undefined;
}

/** A draft as it is saved: fast mode only where the model has it. */
const settled = (models: ReadonlyArray<ProfileModel>, d: ProfileDraft): ProfileDraft => ({ ...d, fast: d.fast && hasFast(models, d.model) });

export function createInput(models: ReadonlyArray<ProfileModel>, draft: ProfileDraft): ProfileCreateInput {
  const d = settled(models, draft);
  return { name: d.name, note: d.note.trim(), model: d.model, effort: d.effort, fast: d.fast, ...(d.default ? { default: true } : {}) };
}

/** Only what changed, so the hub keeps a refusal while the model stays; none when nothing did. */
export function updateInput(models: ReadonlyArray<ProfileModel>, saved: Profile, draft: ProfileDraft): ProfileUpdateInput | undefined {
  const d = settled(models, draft);
  const input: ProfileUpdateInput = {
    id: saved.id,
    ...(d.name !== saved.name ? { name: d.name } : {}),
    ...(d.note.trim() !== saved.note ? { note: d.note.trim() } : {}),
    ...(d.model !== saved.model ? { model: d.model } : {}),
    ...(d.effort !== saved.effort ? { effort: d.effort } : {}),
    ...(d.fast !== saved.fast ? { fast: d.fast } : {}),
    ...(d.default && !saved.default ? { default: true } : {}),
  };
  return Object.keys(input).length > 1 ? input : undefined;
}

/** project_set's `profiles` once `name` is checked or not: the allowed ones but the default. */
export function allowedAfter(allowed: ReadonlyArray<string>, defaultName: string | undefined, name: string, on: boolean): string[] {
  const rest = allowed.filter((n) => n !== defaultName && n !== name);
  return on ? [...rest, name].sort() : rest;
}
