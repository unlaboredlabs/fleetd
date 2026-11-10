// The person's own name as Settings edits it in place (screens/Settings.tsx), with no UI: what the field shows, what
// leaving it sends the hub (person_name_set), and what each answer leaves in it. The hub cleans and checks the name, so
// nothing is judged here: what it refuses shows under the field in its own words, with what was typed kept.
//
// `NameField` is the field as the screen drives it. A screen that goes away with the keyboard still up (Back in its
// header, the system's back) never hears its field blur, so the screen says `gone` and what was typed is saved all the
// same.

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

/** The hub's answer to a save: its cleaned name, or why it refused, in words. */
export type NameSaved = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly error: string };

export interface NameFieldDeps {
  /** person_name_set. */
  readonly save: (name: string) => Promise<NameSaved>;
  /** The field changed: draw it. Never called once the screen is gone. */
  readonly show: (edit: NameEdit) => void;
  /** A save failed with the screen gone, so no field can say why: tell the person. */
  readonly lost: (error: string) => void;
}

export class NameField {
  readonly #deps: NameFieldDeps;
  /** The name the hub has. */
  #saved: string;
  #edit: NameEdit = atRest;
  #gone = false;

  constructor(saved: string, deps: NameFieldDeps) {
    this.#saved = saved;
    this.#deps = deps;
  }

  typed(text: string): void {
    this.#set(typed(this.#edit, text));
  }

  /** The hub says the person's name: a new one (ours kept, or a change made on another device) shows in the field. */
  named(saved: string): void {
    if (saved === this.#saved) return;
    this.#saved = saved;
    this.#set(atRest);
  }

  /** The field was left, or Done pressed. */
  left(): void {
    const name = toSave(this.#edit, this.#saved);
    this.#set(left(this.#edit, this.#saved));
    if (name !== undefined) this.#send(name);
  }

  /**
   * The screen went away. What was typed is saved as leaving the field saves it, but for a field left empty: that
   * changes nothing, the hub would only refuse it.
   */
  gone(): void {
    if (this.#gone) return;
    const name = toSave(this.#edit, this.#saved);
    this.#gone = true;
    if (name !== undefined && name.trim() !== "") this.#send(name);
  }

  #set(edit: NameEdit): void {
    this.#edit = edit;
    if (!this.#gone) this.#deps.show(edit);
  }

  #send(name: string): void {
    void this.#deps.save(name).then((r) => {
      if (!this.#gone) this.#set(r.ok ? kept(r.name) : refused(this.#edit, r.error));
      else if (!r.ok) this.#deps.lost(r.error);
    });
  }
}
