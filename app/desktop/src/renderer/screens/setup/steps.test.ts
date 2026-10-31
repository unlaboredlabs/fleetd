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
    expect(requiredLeft([step("address", { status: "done" }), step("machines"), step("claude"), step("people")])).toBe(2);
    // The fixtures agree with the hub's count.
    for (const [name, scenario] of Object.entries(fixtures.scenarios)) {
      const steps = Object.entries(scenario.list).map(([id, read]) => step(id, read as Partial<SetupStep>));
      expect(requiredLeft(steps), name).toBe(scenario.requiredLeft);
    }
  });

  it("says each need and status in words", () => {
    expect(needWords(step("address").need)).toBe("Required");
    expect(needWords(step("github").need)).toBe("Before the first PR");
    expect(needWords(step("people").need)).toBe("Optional");
    expect([statusWords("done"), statusWords("look"), statusWords("todo")]).toEqual(["Done", "Needs a look", undefined]);
  });

  it("opens where each step's result is saved: a Hub page, and for Claude and GitHub your own accounts too", () => {
    // Claude and GitHub share Hub accounts, each landing on its own part of it.
    expect(placesOf(step("people"))).toEqual([{ label: "Open Hub › People", screen: { id: "settings", tab: "hub.people" } }]);
    expect(placesOf(step("claude")).map((p) => p.label)).toEqual(["Open Hub accounts", "Open Your accounts"]);
    expect(placesOf(step("claude"))[1]).toEqual({ label: "Open Your accounts", screen: { id: "settings", tab: "accounts" }, reveal: "claude" });
    expect(placesOf(step("claude"))[0]?.reveal).toBe("admin.claude");
    expect(placesOf(step("people")).map((p) => p.screen)).toEqual([{ id: "settings", tab: "hub.people" }]);
    expect(placesOf(step("github")).map((p) => p.label)).toEqual(["Open Hub accounts", "Open Your accounts"]);
    expect(placesOf(step("github"))[0]?.reveal).toBe("admin.github");
    // A place this app doesn't know opens nothing.
    expect(placesOf(step("github", { place: "github_app" }))).toEqual([]);
  });
});
