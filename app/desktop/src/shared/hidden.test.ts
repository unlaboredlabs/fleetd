import { describe, expect, it } from "vitest";
import { hasHidden, isHidden, marked, markOf, pieces } from "./hidden";

describe("hidden characters on an approval card", () => {
  it("marks each class push::plain refuses", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      // Lines that break or return.
      ["carriage return", "ls\rrm -rf ~", "ls⟨U+000D⟩rm -rf ~"],
      ["newline", "ls\nrm -rf ~", "ls⟨U+000A⟩rm -rf ~"],
      ["next line", "ls\u0085rm -rf ~", "ls⟨U+0085⟩rm -rf ~"],
      ["line separator", "ls rm -rf ~", "ls⟨U+2028⟩rm -rf ~"],
      ["paragraph separator", "ls rm -rf ~", "ls⟨U+2029⟩rm -rf ~"],
      // Bidi controls that reorder what shows.
      ["right-to-left override", "ls ‮fr- mr", "ls ⟨U+202E⟩fr- mr"],
      ["left-to-right embedding", "ls ‪x", "ls ⟨U+202A⟩x"],
      ["pop directional formatting", "ls ‬x", "ls ⟨U+202C⟩x"],
      ["right-to-left isolate", "ls ⁧x⁩", "ls ⟨U+2067⟩x⟨U+2069⟩"],
      ["first strong isolate", "ls ⁨x", "ls ⟨U+2068⟩x"],
      ["left-to-right mark", "ls‎ x", "ls⟨U+200E⟩ x"],
      ["right-to-left mark", "ls‏ x", "ls⟨U+200F⟩ x"],
      ["arabic letter mark", "ls؜ x", "ls⟨U+061C⟩ x"],
      // Other control characters.
      ["bell", "ls\u0007", "ls⟨U+0007⟩"],
      ["escape", "ls \u001B[2K", "ls ⟨U+001B⟩[2K"],
      ["tab", "ls\tx", "ls⟨U+0009⟩x"],
      ["delete", "ls\u007F", "ls⟨U+007F⟩"],
      ["null", "a\u0000b", "a⟨U+0000⟩b"],
      // Zero-width and invisible characters that hide text.
      ["zero-width space", "r​m -rf ~", "r⟨U+200B⟩m -rf ~"],
      ["zero-width joiner", "r‍m", "r⟨U+200D⟩m"],
      ["zero-width non-joiner", "r‌m", "r⟨U+200C⟩m"],
      ["word joiner", "r⁠m", "r⟨U+2060⟩m"],
      ["invisible times", "a⁢b", "a⟨U+2062⟩b"],
      ["byte order mark", "﻿rm", "⟨U+FEFF⟩rm"],
      ["soft hyphen", "pass­wd", "pass⟨U+00AD⟩wd"],
      ["mongolian vowel separator", "a᠎b", "a⟨U+180E⟩b"],
      ["combining grapheme joiner", "a͏b", "a⟨U+034F⟩b"],
      ["hangul filler", "aㅤb", "a⟨U+3164⟩b"],
      ["variation selector on a letter", "a️b", "a⟨U+FE0F⟩b"],
      ["variation selector 1", "a︀", "a⟨U+FE00⟩"],
      ["tag characters", "ls\u{E0041}\u{E0042}", "ls⟨U+E0041⟩⟨U+E0042⟩"],
    ];
    for (const [what, text, shown] of cases) {
      expect(marked(text), what).toBe(shown);
      expect(hasHidden(text), what).toBe(true);
    }
  });

  it("keeps the character itself next to its mark, and the text around it whole", () => {
    expect(pieces("ls ‮fr")).toEqual([{ text: "ls " }, { text: "‮", mark: "⟨U+202E⟩" }, { text: "fr" }]);
    expect(markOf("\u{E0041}")).toBe("⟨U+E0041⟩");
    expect(isHidden("a")).toBe(false);
    expect(isHidden("⁦")).toBe(true);
  });

  it("shows ordinary writing as written: accents, emoji, CJK, Arabic, Hebrew, Persian and Hindi", () => {
    const plain = [
      "git push origin release",
      "echo 'naïve café ✓' > notes.txt",
      "Grüße, Ærøskøbing, Ελληνικά, Привет",
      "会議は明日の10時です",
      "회의는 내일입니다",
      "مرحبا بالعالم",
      "שלום עולם",
      // Persian and Hindi words written with ZWNJ and ZWJ.
      "می‌خواهم",
      "क्‍ष",
      // Emoji: a thumbs up, a skin tone, a heart with its selector, ZWJ families and professions, a keycap, a flag.
      "👍 👋🏽 ❤️ 👨‍👩‍👧 👩🏽‍💻 ❤️‍🔥 1️⃣ 🇫🇷",
      "©️ ™",
    ];
    for (const text of plain) {
      expect(hasHidden(text), text).toBe(false);
      expect(pieces(text), text).toEqual([{ text }]);
    }
  });

  it("marks a joiner or selector outside the writing it belongs to", () => {
    // A joiner between Latin letters, or after an emoji but before a letter, hides that the words differ.
    expect(marked("👍‍rm")).toBe("👍⟨U+200D⟩rm");
    expect(marked("rm‍👍")).toBe("rm⟨U+200D⟩👍");
    // ZWNJ never joins emoji; a digit's selector only counts in a keycap.
    expect(marked("👍‌👍")).toBe("👍⟨U+200C⟩👍");
    expect(marked("rm file1️")).toBe("rm file1⟨U+FE0F⟩");
    // A joiner between an Arabic letter and a Latin one.
    expect(marked("م‌m")).toBe("م⟨U+200C⟩m");
  });

  it("breaks a body's lines as written, and marks every other break", () => {
    expect(hasHidden("Hi Ana,\n\nSee you there.", true)).toBe(false);
    expect(marked("Hi\r\nAna x", true)).toBe("Hi⟨U+000D⟩\nAna⟨U+2028⟩x");
    expect(hasHidden("Hi Ana,\nSee you.")).toBe(true);
  });
});
