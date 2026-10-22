import { describe, expect, it } from "vitest";
import { setupSteps } from "./setup";

const states = (connected: boolean, project: boolean, saidHi: boolean) => setupSteps({ connected, project, saidHi }).map((s) => s.state);

describe("the first-run checklist", () => {
  it("ticks each step from its own fact and points at the first one left", () => {
    expect(states(false, false, false)).toEqual(["current", "todo", "todo"]);
    expect(states(true, false, false)).toEqual(["done", "current", "todo"]);
    expect(states(true, true, false)).toEqual(["done", "done", "current"]);
    expect(states(true, true, true)).toEqual(["done", "done", "done"]);
  });

  it("ticks a step done out of order, such as a project the hub already had", () => {
    expect(states(false, true, false)).toEqual(["current", "done", "todo"]);
  });
});
