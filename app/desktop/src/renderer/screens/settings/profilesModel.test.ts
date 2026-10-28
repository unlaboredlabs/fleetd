import { describe, expect, it } from "vitest";
import type { Profile, ProfileModel } from "../../../shared/contracts";
import { allowedAfter, createInput, draftOf, modelChoices, problem, runsLine, updateInput } from "./profilesModel";

const MODELS: ProfileModel[] = [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", fast: true },
  { id: "claude-sonnet-5-5", fast: false },
];
const medium: Profile = {
  id: 2,
  name: "medium",
  note: "Mechanical work.",
  model: "claude-opus-5-5",
  effort: "medium",
  fast: true,
  default: false,
  refused: "claude refused it",
  updatedAt: "2026-10-28T10:00:00.000Z",
};

describe("a task profile's draft", () => {
  it("checks the name and the note before the hub does", () => {
    const d = { ...draftOf(medium), name: "chores" };
    expect(problem(d, ["high"])).toBeUndefined();
    expect(problem({ ...d, name: "" }, [])).toEqual({ field: "name", text: "Give it a name." });
    expect(problem({ ...d, name: "Chores" }, [])?.field).toBe("name");
    expect(problem({ ...d, name: "high" }, ["high"])?.text).toBe("A profile is already named high.");
    expect(problem({ ...d, note: "two\nlines" }, [])?.field).toBe("note");
    expect(problem({ ...d, note: "x".repeat(301) }, [])?.text).toBe("Keep it to 300 characters.");
  });

  it("drops fast mode on a model without it", () => {
    expect(createInput(MODELS, { ...draftOf(medium), name: "s", model: "claude-sonnet-5-5" })).toEqual({
      name: "s",
      note: "Mechanical work.",
      model: "claude-sonnet-5-5",
      effort: "medium",
      fast: false,
    });
  });

  it("sends only what changed, so a refusal stays while the model does", () => {
    expect(updateInput(MODELS, medium, draftOf(medium))).toBeUndefined();
    expect(updateInput(MODELS, medium, { ...draftOf(medium), effort: "low", note: " Chores. " })).toEqual({ id: 2, effort: "low", note: "Chores." });
    expect(updateInput(MODELS, medium, { ...draftOf(medium), model: "claude-sonnet-5-5" })).toEqual({ id: 2, model: "claude-sonnet-5-5", fast: false });
  });

  it("reads as its model, effort and fast mode, and keeps a model the list lacks", () => {
    expect(runsLine(MODELS, medium)).toBe("Claude Opus 5.5 · medium effort · fast");
    expect(runsLine(MODELS, { model: "claude-sonnet-5-5", effort: "xhigh", fast: false })).toBe("claude-sonnet-5-5 · extra high effort");
    expect(modelChoices(MODELS, "gw-opus").map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "gw-opus"]);
    expect(modelChoices(MODELS, "claude-opus-5-5")).toBe(MODELS);
  });
});

describe("a project's allowed profiles", () => {
  it("leave the default out of project_set and keep the rest sorted", () => {
    expect(allowedAfter(["high", "medium"], "high", "quick", true)).toEqual(["medium", "quick"]);
    expect(allowedAfter(["high", "medium", "quick"], "high", "medium", false)).toEqual(["quick"]);
  });
});
