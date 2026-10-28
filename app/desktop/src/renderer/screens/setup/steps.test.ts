import { describe, expect, it } from "vitest";
import fixtures from "../../../../fixtures/setup/steps.json" with { type: "json" };
import { isRequiredLeft, needWords, placesOf, requiredLeft, statusWords, type SetupStep } from "./steps";

/** The hub's own steps (hub/setup's catalog, as the fixtures carry it), read as `read` says. */
const step = (id: string, read: Partial<SetupStep> = {}): SetupStep => {
  const guide = (fixtures.guides as ReadonlyArray<SetupStep>).find((g) => g.id === id);
  if (guide === undefined) throw new Error(`no step ${id}`);
  return { ...guide, ...read };
};

describe("setup steps", () => {
  it("counts what is required as the hub does: not set up, or failing, never a warning", () => {
    expect(isRequiredLeft(step("machines"))).toBe(true);
    expect(isRequiredLeft(step("machines", { status: "look", failing: true }))).toBe(true);
    // A degraded machine warns: agents still run.
    expect(isRequiredLeft(step("machines", { status: "look" }))).toBe(false);
    expect(isRequiredLeft(step("machines", { status: "done" }))).toBe(false);
    // Optional and "before" steps never hold agents back.
    expect(isRequiredLeft(step("github", { status: "look", failing: true }))).toBe(false);
    expect(requiredLeft([step("address", { status: "done" }), step("machines"), step("claude"), step("google")])).toBe(2);
    // The fixtures agree with the hub's count.
    for (const [name, scenario] of Object.entries(fixtures.scenarios)) {
      const steps = Object.entries(scenario.list).map(([id, read]) => step(id, read as Partial<SetupStep>));
      expect(requiredLeft(steps), name).toBe(scenario.requiredLeft);
    }
  });

  it("says each need and status in words", () => {
    expect(needWords(step("address").need)).toBe("Required");
    expect(needWords(step("github").need)).toBe("Before the first PR");
    expect(needWords(step("google").need)).toBe("Optional");
    expect([statusWords("done"), statusWords("look"), statusWords("skipped"), statusWords("todo")]).toEqual(["Done", "Needs a look", "Later", undefined]);
  });

  it("opens where each step's result is saved: Administration, and for Claude your own Settings too", () => {
    expect(placesOf(step("google")).map((p) => p.screen)).toEqual([{ id: "admin", section: "google" }]);
    expect(placesOf(step("claude")).map((p) => p.label)).toEqual(["Open Administration › Claude", "Open Settings › Claude"]);
    expect(placesOf(step("people")).map((p) => p.screen)).toEqual([{ id: "admin", section: "invites" }]);
    // GitHub has nowhere in the app to save to yet, and a place this app doesn't know opens nothing.
    expect(placesOf(step("github"))).toEqual([]);
    expect(placesOf(step("github", { place: "github_app" }))).toEqual([]);
  });
});
