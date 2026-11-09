import { describe, expect, it } from "vitest";
import { anchorOf, GLIDE, glideOf, type Place } from "./glide";
import type { Row } from "./model";
import type { ChatItem } from "../../src/data/chat";

const message = (key: string, author: ChatItem["author"]): Row => ({ kind: "message", key, item: { id: key, author } as ChatItem, run: true, end: true, head: false, history: false });
// At the end: 1,000 px of conversation in a 600 px view, scrolled to the bottom, its last rows starting at 880 and 940.
const was: Place = { height: 1000, top: 400, view: 600, width: 700, tail: [{ key: "z", start: 880 }, { key: "a", start: 940 }] };
const grown = { height: 1060, view: 600, width: 700 };
const starts = new Map([["z", 880], ["a", 940]]);
const at = (rows: readonly Row[], moved: Record<string, number> = {}) => anchorOf(was, rows, (k) => moved[k] ?? starts.get(k));
const z = message("z", "human");
const a = message("a", "lead");

describe("the conversation making room", () => {
  it("glides on a reply's spring, or your send's, as a message comes in under the end", () => {
    expect(glideOf(was, grown, at([z, a, message("b", "lead")]))).toBe(GLIDE.theirs);
    expect(glideOf(was, grown, at([z, a, message("b", "human")]))).toBe(GLIDE.mine);
  });

  it("glides on the growing spring as the last message grows", () => {
    expect(glideOf(was, grown, at([z, a]))).toBe(GLIDE.grow);
  });

  it("holds still scrolled up, and for anything that isn't a message coming in at the end", () => {
    // Scrolled up past the follow threshold.
    expect(glideOf({ ...was, top: 300 }, grown, at([z, a, message("b", "lead")]))).toBeUndefined();
    // An older page landing above moved the rows that were last.
    expect(glideOf(was, grown, at([z, a], { a: 1000 }))).toBeUndefined();
    // The window resized; the list shrank.
    expect(glideOf(was, { ...grown, width: 600 }, at([z, a]))).toBeUndefined();
    expect(glideOf(was, { ...grown, height: 980 }, at([z, a]))).toBeUndefined();
    // None of the rows that were last is left.
    expect(glideOf(was, grown, at([message("b", "lead")]))).toBeUndefined();
  });
});
