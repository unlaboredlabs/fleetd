import { describe, expect, it } from "vitest";
import { answerDisplay, choices, displayLabel, humanizeKey } from "./asks";
import type { Ask, AskOption } from "./index";

const decide = (options: AskOption[], recommendation: string): Ask => ({
  askId: "A1",
  projectRef: { machineId: "devbox", projectId: "storefront" },
  kind: "decide",
  key: "share.link",
  class: "product",
  text: "What does the share link show?",
  options,
  recommendation,
  blocks: "nothing",
  proceededOnRec: false,
  state: "open",
  createdAt: "2026-10-19T00:00:00.000Z",
});

describe("ask choices", () => {
  it("puts the recommendation first, once, and humanizes old bare keys", () => {
    const ask = decide([{ key: "image-only" }, { key: "public-snapshot" }], "public-snapshot");
    expect(choices(ask).map(displayLabel)).toEqual(["Public snapshot", "Image only"]);
  });

  it("lists a free-text recommendation that is not an option as the first choice", () => {
    const ask = decide([{ key: "a-monthly-vs-week" }], "a weekly plan, prorated");
    expect(choices(ask).map(displayLabel)).toEqual(["a weekly plan, prorated", "A monthly vs week"]);
    expect(humanizeKey("Keep the old URL")).toBe("Keep the old URL");
  });

  it("words an answer by its kind", () => {
    const ask = decide(
      [
        { key: "image-only", label: "Image only" },
        { key: "public-snapshot", label: "Public snapshot" },
      ],
      "public-snapshot",
    );
    const at = "2026-10-19T00:00:01.000Z";
    const answer = { by: "human:mac", at, raw: "1" };
    expect(answerDisplay({ ...answer, value: "image-only", kind: "option" }, ask)).toBe("Image only");
    expect(answerDisplay({ ...answer, value: "public-snapshot", kind: "skip" }, ask)).toBe(
      "Skipped for now (lead keeps: Public snapshot)",
    );
    expect(answerDisplay({ ...answer, value: "Ship both", kind: "text" }, ask)).toBe("Ship both");
  });
});
