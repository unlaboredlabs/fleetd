import { describe, expect, it } from "vitest";
import { trainChanged, trainDraftOf, trainFrom } from "./trainModel";

describe("merge train checks", () => {
  const saved = { fastChecks: ["integration", "test (ubuntu-latest, 18)"], afterMerge: ["e2e (macos-latest)"] };

  it("reads one check a line, keeps commas in names, and round-trips", () => {
    const draft = trainDraftOf(saved);
    expect(draft.fast).toBe("integration\ntest (ubuntu-latest, 18)");
    expect(trainFrom(draft)).toEqual({ ok: true, train: saved });
    expect(trainChanged(draft, saved)).toBe(false);
    expect(trainChanged({ ...draft, fast: `${draft.fast}\n  \nintegration` }, saved)).toBe(false);
    expect(trainChanged({ ...draft, after: "" }, saved)).toBe(true);
  });

  it("defaults to no checks of its own and refuses what the hub would", () => {
    expect(trainDraftOf(undefined)).toEqual({ fast: "", after: "" });
    expect(trainFrom({ fast: "", after: "" })).toEqual({ ok: true, train: { fastChecks: [], afterMerge: [] } });
    expect(trainFrom({ fast: "x".repeat(201), after: "" })).toMatchObject({ ok: false });
    expect(trainFrom({ fast: Array.from({ length: 51 }, (_, i) => `check ${i}`).join("\n"), after: "" })).toMatchObject({ ok: false });
  });
});
