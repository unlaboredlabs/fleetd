import { describe, expect, it } from "vitest";
import fixtures from "../../../../fixtures/setup/steps.json" with { type: "json" };
import { doneWords, isRequiredLeft, needsNow, needWords, placesOf, requiredLeft, setupLayout, statusWords, testMs, type SetupStep } from "./steps";

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
    // The hub's side of Claude and GitHub is the step's own page on Hub › Setup, which holds the account's controls.
    expect(placesOf(step("people"))).toEqual([{ label: "Open Hub › People", screen: { id: "settings", tab: "hub.people" } }]);
    expect(placesOf(step("claude")).map((p) => p.label)).toEqual(["Open Hub › Setup › Claude", "Open Your accounts"]);
    expect(placesOf(step("claude"))[1]).toEqual({ label: "Open Your accounts", screen: { id: "settings", tab: "accounts" }, reveal: "claude" });
    expect(placesOf(step("claude"))[0]).toEqual({ label: "Open Hub › Setup › Claude", screen: { id: "settings", tab: "hub.setup" }, reveal: "admin.claude" });
    expect(placesOf(step("people")).map((p) => p.screen)).toEqual([{ id: "settings", tab: "hub.people" }]);
    expect(placesOf(step("github")).map((p) => p.label)).toEqual(["Open Hub › Setup › GitHub", "Open Your accounts"]);
    expect(placesOf(step("github"))[0]).toEqual({ label: "Open Hub › Setup › GitHub", screen: { id: "settings", tab: "hub.setup" }, reveal: "admin.github" });
    // On that page the hub's side is already here: only yours is left to open. Other steps open what they did.
    expect(placesOf(step("claude"), true).map((p) => p.label)).toEqual(["Open Your accounts"]);
    expect(placesOf(step("github"), true).map((p) => p.label)).toEqual(["Open Your accounts"]);
    expect(placesOf(step("people"), true)).toEqual(placesOf(step("people")));
    expect(placesOf(step("machines"), true).map((p) => p.label)).toEqual(["Open Hub › Machines"]);
    // 1Password is each person's own: only Your accounts.
    expect(placesOf(step("onepassword"))).toEqual([
      { label: "Open Your accounts › 1Password", screen: { id: "settings", tab: "accounts" }, reveal: "onepassword" },
    ]);
    // 1Password's first Test on a machine installs the SDK: the Test waits for it.
    expect(testMs(step("onepassword"))).toBe(300_000);
    expect(testMs(step("github"))).toBe(120_000);
    // A place this app doesn't know opens nothing.
    expect(placesOf(step("github", { place: "github_app" }))).toEqual([]);
  });

  it("lays Settings › Hub › Setup out as the hub's accounts, every one always, then the other steps left, what needs someone first", () => {
    const ids = (steps: ReadonlyArray<SetupStep>) => steps.map((st) => st.id);
    const scenario = (name: keyof typeof fixtures.scenarios) =>
      (fixtures.guides as ReadonlyArray<SetupStep>).map((g) => step(g.id, (fixtures.scenarios[name].list as Record<string, Partial<SetupStep>>)[g.id]));
    // A fresh hub: Claude is failing, so it leads the accounts; the hub's own steps left follow, the done ones fold.
    const fresh = setupLayout(scenario("setup-fresh"));
    expect(ids(fresh.accounts)).toEqual(["claude", "github", "onepassword"]);
    expect(ids(fresh.others)).toEqual(["people", "mac"]);
    expect(ids(fresh.done)).toEqual(["address", "machines"]);
    expect(fresh.othersFirst).toBe(false);
    // An account that is done stays listed, where it was; one that needs someone now comes first.
    expect(ids(setupLayout(scenario("setup-github")).accounts)).toEqual(["claude", "github", "onepassword"]);
    expect(ids(setupLayout(scenario("setup-github").map((st) => (st.id === "github" ? { ...st, status: "look" as const } : st))).accounts)).toEqual(["github", "claude", "onepassword"]);
    // Every step done: the accounts are still there, each a row; the rest is the one line.
    const all = setupLayout(scenario("setup-all"));
    expect([ids(all.accounts), ids(all.others), ids(all.done)]).toEqual([["claude", "github", "onepassword"], [], ["address", "machines", "people", "mac"]]);
    // Only a step that isn't an account needs someone now (a machine went offline): it comes before the accounts.
    const offline = setupLayout(scenario("setup-done").map((st) => (st.id === "machines" ? { ...st, status: "look" as const, failing: true } : st)));
    expect(ids(offline.others)).toEqual(["machines", "people", "mac"]);
    expect(offline.othersFirst).toBe(true);
    // With an account asking too, the accounts keep their place.
    const both = setupLayout(scenario("setup-fresh").map((st) => (st.id === "machines" ? { ...st, status: "look" as const } : st)));
    expect(ids(both.others)).toEqual(["machines", "people", "mac"]);
    expect(both.othersFirst).toBe(false);
  });

  it("says what a set-up account runs on, and which steps want the admin now", () => {
    expect(doneWords(step("claude", { status: "done", way: "the hub's API key" }))).toBe("Uses the hub's API key");
    expect(doneWords(step("github", { status: "done", way: "gh on the hub" }))).toBe("Uses gh on the hub");
    expect(doneWords(step("onepassword", { status: "done" }))).toBe("Done");
    // Only once it is done: a step that needs a look says that instead, and one to do says when it is needed.
    expect(doneWords(step("claude", { status: "look", way: "each machine's own login" }))).toBeUndefined();
    expect(doneWords(step("github"))).toBeUndefined();
    expect(needsNow(step("claude"))).toBe(true);
    expect(needsNow(step("github"))).toBe(false);
    expect(needsNow(step("github", { status: "look" }))).toBe(true);
    expect(needsNow(step("claude", { status: "done" }))).toBe(false);
  });
});
