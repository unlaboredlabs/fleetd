import { describe, expect, it } from "vitest";
import { chipLabel, chipOf, countLabel, dayFrom, findInput, offers, suggestions, withChip, type Chip } from "./model";

const who = { people: [{ personId: "p_adaadaad", name: "Ada Okafor" }, { personId: "p_benbenbe", name: "Ben" }], me: "p_benbenbe" };
const now = new Date(2026, 9, 14, 15, 0).getTime();
const projectRef = { machineId: "devbox", projectId: "storefront" };

describe("the search field's filters", () => {
  it("reads typed filters into chips: who, what it holds, a day", () => {
    expect(chipOf("from:lead", who, now)).toEqual({ kind: "from", who: "lead" });
    expect(chipOf("from:me", who, now)).toEqual({ kind: "from", who: "me" });
    expect(chipOf("FROM:ada", who, now)).toEqual({ kind: "from", who: who.people[0] });
    expect(chipOf("has:links", who, now)).toEqual({ kind: "has", has: "link" });
    expect(chipOf("is:pinned", who, now)).toEqual({ kind: "has", has: "pinned" });
    expect(chipOf("on:today", who, now)).toEqual({ kind: "on", day: "2026-10-14" });
    expect(chipOf("before:2026-2-30", who, now)).toBeUndefined();
    expect(chipOf("from:nobody", who, now)).toBeUndefined();
    expect(chipOf("deploy", who, now)).toBeUndefined();
    expect(dayFrom("yesterday", now)).toBe("2026-10-13");
  });

  it("turns words and chips into chat_find's input, a day in local time", () => {
    const chips: Chip[] = [{ kind: "from", who: "me" }, { kind: "has", has: "link" }, { kind: "on", day: "2026-10-14" }];
    expect(findInput(projectRef, "  staging pass ", chips, who.me)).toEqual({
      projectRef,
      words: "staging pass",
      personId: "p_benbenbe",
      has: ["link"],
      since: new Date(2026, 9, 14).toISOString(),
      until: new Date(2026, 9, 15).toISOString(),
    });
    expect(findInput(projectRef, "", [{ kind: "from", who: "lead" }, { kind: "after", day: "2026-10-01" }], undefined)).toEqual({
      projectRef,
      author: "lead",
      since: new Date(2026, 9, 2).toISOString(),
    });
  });

  it("one person and one day at a time; what it holds adds up", () => {
    let chips = withChip([], { kind: "from", who: "lead" });
    chips = withChip(chips, { kind: "from", who: "me" });
    chips = withChip(chips, { kind: "has", has: "link" });
    chips = withChip(chips, { kind: "has", has: "image" });
    chips = withChip(chips, { kind: "before", day: "2026-10-01" });
    chips = withChip(chips, { kind: "on", day: "2026-09-01" });
    expect(chips.map(chipLabel)).toEqual(["From me", "Links", "Images", expect.stringMatching(/^1 Sept? 2026$|^Sep 1, 2026$/u)]);
  });

  it("offers the filters on an empty field, and those a typed key could become", () => {
    expect(suggestions("", who).map(chipLabel)).toEqual(["From the lead", "From me", "Links", "Images", "Files", "Pull requests", "Pinned"]);
    expect(suggestions("has:p", who).map(chipLabel)).toEqual(["Pull requests", "Pinned"]);
    expect(suggestions("from:a", who).map(chipLabel)).toEqual(["From Ada Okafor"]);
    expect(suggestions("fr", who)).toEqual([]);
  });

  it("the list under the field: the filters on an empty field, hits once there are words or a filter", () => {
    const lead: Chip = { kind: "from", who: "lead" };
    expect(offers("", [], who)).toHaveLength(7);
    expect(offers("   ", [], who)).toHaveLength(7);
    // A word, then a space before the next: still its hits.
    expect(offers("deploy ", [], who)).toEqual([]);
    expect(offers("workspace deploy", [], who)).toEqual([]);
    // A filter alone: its hits, not the filters left.
    expect(offers("", [lead], who)).toEqual([]);
    // A filter being typed, after words or not; one already picked isn't offered again.
    expect(offers("deploy has:p", [], who).map(chipLabel)).toEqual(["Pull requests", "Pinned"]);
    expect(offers("from:", [lead], who).map(chipLabel)).toEqual(["From me", "From Ada Okafor"]);
  });

  it("counts: all of them, where you are in them, more than counted", () => {
    expect(countLabel(48, false, undefined)).toBe("48");
    expect(countLabel(48, false, 2)).toBe("3 of 48");
    expect(countLabel(10_000, true, 0)).toBe("1 of 10,000+");
    expect(countLabel(0, false, undefined)).toBe("No results");
    expect(countLabel(undefined, false, undefined)).toBeUndefined();
  });
});
