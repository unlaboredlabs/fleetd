import { describe, expect, it } from "vitest";
import { exactRuns, FSI, LRI, markRuns, PDI } from "./exact";

/** The runs as one string, marks bracketed, for reading a test. */
const drawn = (runs: ReturnType<typeof exactRuns>): string => runs.map((r) => (r.mark ? `[${r.text}]` : r.text)).join("");

describe("a field drawn exactly on the phone", () => {
  it("marks each class the hub's push::plain refuses, each mark in its own left-to-right isolate", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["right-to-left override", "ls ‮fr- mr", "ls ⟨U+202E⟩fr- mr"],
      ["pop directional formatting", "x‬", "x⟨U+202C⟩"],
      ["isolates", "⁦x⁧y⁨z⁩", "⟨U+2066⟩x⟨U+2067⟩y⟨U+2068⟩z⟨U+2069⟩"],
      ["marks", "a‎b‏c؜d", "a⟨U+200E⟩b⟨U+200F⟩c⟨U+061C⟩d"],
      ["zero-width", "r​m r‌m r‍m r⁠m ﻿x", "r⟨U+200B⟩m r⟨U+200C⟩m r⟨U+200D⟩m r⟨U+2060⟩m ⟨U+FEFF⟩x"],
      ["soft hyphen and fillers", "a­bㅤcᅟd", "a⟨U+00AD⟩b⟨U+3164⟩c⟨U+115F⟩d"],
      ["variation and tag characters", "a️\u{E0041}", "a⟨U+FE0F⟩⟨U+E0041⟩"],
      ["line and paragraph separators", "a b c", "a⟨U+2028⟩b⟨U+2029⟩c"],
      ["control characters", "a\tb\rc\nd\u001Be\u007Ff\u0085", "a⟨U+0009⟩b⟨U+000D⟩c⟨U+000A⟩d⟨U+001B⟩e⟨U+007F⟩f⟨U+0085⟩"],
    ];
    for (const [what, text, shown] of cases) {
      const runs = markRuns(text);
      expect(runs.map((r) => (r.mark ? r.text.slice(1, -1) : r.text)).join(""), what).toBe(shown);
      for (const r of runs.filter((m) => m.mark)) {
        expect(r.text.startsWith(LRI) && r.text.endsWith(PDI), what).toBe(true);
      }
    }
  });

  it("isolates the whole field: by its own first strong letter, or left to right for machine text", () => {
    expect(drawn(exactRuns("שלום.txt"))).toBe(`${FSI}שלום.txt${PDI}`);
    expect(drawn(exactRuns("שלום.txt", { ltr: true }))).toBe(`${LRI}שלום.txt${PDI}`);
    expect(drawn(exactRuns("ls ‮x", { ltr: true }))).toBe(`${LRI}ls [${LRI}⟨U+202E⟩${PDI}]x${PDI}`);
    // Every isolate it draws is closed, so nothing it holds reaches the next field.
    const runs = exactRuns("‮⁦⁧ a ‫");
    const text = runs.map((r) => r.text).join("");
    expect([...text].filter((c) => c === LRI || c === FSI).length).toBe([...text].filter((c) => c === PDI).length);
  });

  it("draws ordinary writing as written", () => {
    for (const text of ["naïve café", "会議は明日の10時です", "مرحبا بالعالم", "שלום עולם", "می‌خواهم", "👋🏽 ❤️ 👨‍👩‍👧 1️⃣"]) {
      expect(markRuns(text), text).toEqual([{ text, mark: false }]);
    }
  });

  it("breaks a body's lines as written", () => {
    expect(markRuns("Hi,\n\nSam", true)).toEqual([{ text: "Hi,\n\nSam", mark: false }]);
    expect(markRuns("Hi,\nSam").some((r) => r.mark)).toBe(true);
  });
});
