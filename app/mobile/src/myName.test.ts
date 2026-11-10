import { describe, expect, it } from "vitest";
import { atRest, kept, left, NameField, refused, shownName, toSave, typed, type NameEdit, type NameSaved } from "./myName";

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

/** A field on a hub that answers each save when the test says so; by default it keeps the name, trimmed. */
const rig = (saved = SAVED) => {
  const sent: string[] = [];
  const shown: NameEdit[] = [];
  const lost: string[] = [];
  const answers: Array<(r?: NameSaved) => Promise<void>> = [];
  const field = new NameField(saved, {
    save: (name) => {
      sent.push(name);
      return new Promise<NameSaved>((resolve) =>
        answers.push(async (r = { ok: true, name: name.trim() }) => {
          resolve(r);
          await Promise.resolve();
        }),
      );
    },
    show: (edit) => shown.push(edit),
    lost: (error) => lost.push(error),
  });
  return { field, sent, shown, lost, answer: (r?: NameSaved) => answers.shift()?.(r) };
};

describe("The field, as the screen drives it", () => {
  it("saves on leaving the field, shows the hub's cleaned name, and rests once the hub says it too", async () => {
    const { field, sent, shown, answer } = rig();
    field.typed(" Sam R. Rivera ");
    field.left();
    expect(sent).toEqual([" Sam R. Rivera "]);
    expect(shown.at(-1)).toEqual({ draft: " Sam R. Rivera ", error: null, busy: true });
    await answer();
    expect(shown.at(-1)).toEqual(kept("Sam R. Rivera"));
    field.named("Sam R. Rivera");
    expect(shown.at(-1)).toBe(atRest);
    // Left again with nothing typed: nothing more to send.
    field.left();
    expect(sent).toEqual([" Sam R. Rivera "]);
  });

  it("keeps what was typed with the hub's refusal, and drops both for a name changed on another device", async () => {
    const { field, shown, lost, answer } = rig();
    field.typed("");
    field.left();
    await answer({ ok: false, error: "The name is empty. Type the name you go by." });
    expect(shown.at(-1)).toEqual({ draft: "", error: "The name is empty. Type the name you go by.", busy: false });
    expect(lost).toEqual([]);
    field.named("Sam from the laptop");
    expect(shown.at(-1)).toBe(atRest);
  });

  it("saves what was typed when the screen goes away with the field never left: Back, with the keyboard still up", async () => {
    const { field, sent, shown, lost, answer } = rig();
    field.typed("Samuel Rivera");
    const drawn = shown.length;
    field.gone();
    expect(sent).toEqual(["Samuel Rivera"]);
    await answer();
    // Nothing is drawn on a screen that is gone, and a name the hub kept needs no word.
    expect(shown.length).toBe(drawn);
    expect(lost).toEqual([]);
  });

  it("sends it once when the field is left and the screen goes in the same moment", async () => {
    const { field, sent, lost, answer } = rig();
    field.typed("Samuel Rivera");
    field.left();
    field.gone();
    field.gone();
    expect(sent).toEqual(["Samuel Rivera"]);
    await answer();
    expect(lost).toEqual([]);
  });

  it("sends nothing as the screen goes when nothing was typed, the name is the same, or the field was left empty", () => {
    for (const text of [undefined, ` ${SAVED} `, "", "   "]) {
      const { field, sent } = rig();
      if (text !== undefined) field.typed(text);
      field.gone();
      expect(sent).toEqual([]);
    }
  });

  it("says why in an alert's words when the hub refuses a save the screen is gone for", async () => {
    // Sent as the screen went.
    const going = rig();
    going.field.typed("Samuel Rivera");
    going.field.gone();
    await going.answer({ ok: false, error: "The hub can't be reached." });
    expect(going.lost).toEqual(["The hub can't be reached."]);

    // Sent on leaving the field, and still on its way as the screen went.
    const sentBefore = rig();
    sentBefore.field.typed("Samuel Rivera");
    sentBefore.field.left();
    const drawn = sentBefore.shown.length;
    sentBefore.field.gone();
    await sentBefore.answer({ ok: false, error: "The hub can't be reached." });
    expect(sentBefore.lost).toEqual(["The hub can't be reached."]);
    expect(sentBefore.shown.length).toBe(drawn);
  });
});
