import { describe, expect, it } from "vitest";
import { completions, namedSkills, pick, skillToken, SKILLS_PER_MESSAGE } from "./skillPickerModel";

const skills = [
  { name: "release", description: "Cut a release." },
  { name: "pr-review", description: "Review a PR." },
  { name: "release", description: "The global one, outranked." },
  { name: "triage", description: "Sort issues." },
];

describe("the composer's $", () => {
  it("opens on a $ that starts a word, up to the caret", () => {
    expect(skillToken("$", 1)).toEqual({ start: 0, query: "" });
    expect(skillToken("use $rel", 8)).toEqual({ start: 4, query: "rel" });
    expect(skillToken("use $rel now", 8)).toEqual({ start: 4, query: "rel" });
    expect(skillToken("price a$b", 9)).toBeNull();
    expect(skillToken("use $rel now", 12)).toBeNull();
    expect(skillToken("$Rel", 4)).toBeNull();
  });

  it("offers names that start with what is typed, then ones that contain it, each once", () => {
    expect(completions("", skills).map((s) => s.name)).toEqual(["release", "pr-review", "triage"]);
    expect(completions("re", skills).map((s) => s.name)).toEqual(["release", "pr-review"]);
    expect(completions("view", skills).map((s) => s.name)).toEqual(["pr-review"]);
    expect(completions("zzz", skills)).toEqual([]);
  });

  it("puts the picked name in place of what was typed, the caret after it", () => {
    expect(pick("use $rel", 8, 4, "release")).toEqual({ text: "use $release ", caret: 13 });
    expect(pick("use $rel today", 8, 4, "release")).toEqual({ text: "use $release today", caret: 13 });
  });

  it("names each skill the message mentions, once, and nothing that is not a skill", () => {
    const known = new Set(["release", "triage"]);
    expect(namedSkills("Run $release, then $triage. Again $release; $nope and a$release", known)).toEqual(["release", "triage"]);
    expect(namedSkills("costs $5", known)).toEqual([]);
    const many = new Set(Array.from({ length: 12 }, (_, i) => `s${i}`));
    expect(namedSkills([...many].map((n) => `$${n}`).join(" "), many)).toHaveLength(SKILLS_PER_MESSAGE);
  });
});
