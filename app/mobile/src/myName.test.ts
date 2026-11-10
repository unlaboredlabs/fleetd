import { describe, expect, it } from "vitest";
import { atRest, kept, left, refused, shownName, toSave, typed, type NameEdit } from "./myName";

const SAVED = "Sam Rivera";

describe("The person's own name, edited in place", () => {
  it("holds the saved name until something is typed, then what was typed", () => {
    expect(shownName(atRest, SAVED)).toBe(SAVED);
    expect(shownName(typed(atRest, "Sam R"), SAVED)).toBe("Sam R");
    expect(shownName(typed(atRest, ""), SAVED)).toBe("");
  });

  it("sends the hub what was typed on leaving the field, as typed: the hub cleans it", () => {
    const edit = typed(atRest, "  Sam R. Rivera ");
    expect(toSave(edit, SAVED)).toBe("  Sam R. Rivera ");
    expect(left(edit, SAVED)).toEqual({ draft: "  Sam R. Rivera ", error: null, busy: true });
    // An empty one goes too: the hub refuses it in its own words.
    expect(toSave(typed(atRest, ""), SAVED)).toBe("");
  });

  it("sends nothing when nothing was typed, or the name is the same again", () => {
    expect(toSave(atRest, SAVED)).toBeUndefined();
    expect(left(atRest, SAVED)).toBe(atRest);
    const same = typed(atRest, ` ${SAVED} `);
    expect(toSave(same, SAVED)).toBeUndefined();
    expect(left(same, SAVED)).toBe(atRest);
  });

  it("sends nothing more while a save is on its way", () => {
    const saving = left(typed(atRest, "Samuel"), SAVED);
    expect(toSave(saving, SAVED)).toBeUndefined();
    expect(left(saving, SAVED)).toBe(saving);
  });

  it("shows the hub's cleaned name once kept, which is nothing to save once the hub says it too", () => {
    const edit = kept("Sam R. Rivera");
    expect(shownName(edit, SAVED)).toBe("Sam R. Rivera");
    expect(edit.busy).toBe(false);
    expect(toSave(edit, "Sam R. Rivera")).toBeUndefined();
  });

  it("keeps what was typed with the hub's refusal, and typing the saved name again clears it", () => {
    const saving = left(typed(atRest, "   "), SAVED);
    const edit: NameEdit = refused(saving, "The name is empty. Type the name you go by.");
    expect(edit).toEqual({ draft: "   ", error: "The name is empty. Type the name you go by.", busy: false });
    // Leaving it again asks again; the saved name typed back puts the field at rest.
    expect(toSave(edit, SAVED)).toBe("   ");
    expect(left(typed(edit, SAVED), SAVED)).toBe(atRest);
  });
});
