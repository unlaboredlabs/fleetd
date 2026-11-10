// The person's own name as Settings edits it in place (screens/Settings.tsx), with no UI: what the field shows, what
// leaving it sends the hub (person_name_set), and what each answer leaves in it. The hub cleans and checks the name, so
// nothing is judged here: what it refuses shows under the field in its own words, with what was typed kept.

/** The hub's own limit (person_name_set), an invite's too. */
export const MY_NAME_MAX = 80;

export interface NameEdit {
  /** What is typed and not the hub's yet; null shows the saved name. */
  readonly draft: string | null;
  /** Why the hub refused the last save, in its words. */
  readonly error: string | null;
  /** A save is on its way. */
  readonly busy: boolean;
}

export const atRest: NameEdit = { draft: null, error: null, busy: false };

/** What the field holds. */
export const shownName = (edit: NameEdit, saved: string): string => edit.draft ?? saved;

export const typed = (edit: NameEdit, text: string): NameEdit => ({ ...edit, draft: text });

/**
 * What leaving the field (or Done, which leaves it) sends the hub: nothing when nothing was typed, when it is the saved
 * name again but for spaces around it, and while a save is on its way.
 */
export const toSave = (edit: NameEdit, saved: string): string | undefined => (edit.draft === null || edit.busy || edit.draft.trim() === saved ? undefined : edit.draft);

/** The field as leaving it leaves it: saving what `toSave` gives, else at rest (a save on its way goes on). */
export const left = (edit: NameEdit, saved: string): NameEdit => (toSave(edit, saved) !== undefined ? { ...edit, busy: true } : edit.busy ? edit : atRest);

/** The hub kept it: its cleaned name stands in the field until the hub says who the person is again. */
export const kept = (name: string): NameEdit => ({ draft: name, error: null, busy: false });

/** The hub refused it: what was typed stays, with why. */
export const refused = (edit: NameEdit, error: string): NameEdit => ({ draft: edit.draft, error, busy: false });
