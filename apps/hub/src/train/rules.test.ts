import type { Workstream } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { checkSource, checkTier, freezeKey, sourceOf } from "./rules.ts";

const ws = { workstreamId: "W1", brief: { doneWhen: [{}, {}, {}] } } as unknown as Workstream;

describe("train rules", () => {
  it("reads the Source: line, with or without markdown around it", () => {
    expect(sourceOf("Adds docs.\n\nSource: done:2\n")).toBe("done:2");
    expect(sourceOf("**Source:** `issue:#4`")).toBe("issue:#4");
    expect(sourceOf("No source here")).toBeUndefined();
    expect(sourceOf(null)).toBeUndefined();
  });

  it("refuses a missing, malformed, mismatched or out-of-range Source with the fix", () => {
    expect(checkSource("Source: done:2", "done:2", ws)).toEqual({ serves: "done:2" });
    expect(checkSource("Source: ask:A3", undefined, ws)).toEqual({ serves: "ask:A3" });
    expect(checkSource("nothing", "done:2", ws)).toMatchObject({ fix: "add 'Source: done:2' to the PR body" });
    expect(checkSource("Source: stuff", undefined, ws)).toMatchObject({ message: "'Source: stuff' is not a valid serves form." });
    expect(checkSource("Source: done:1", "done:2", ws)).toMatchObject({ fix: "change the PR body's line to 'Source: done:2'" });
    expect(checkSource("Source: done:3", undefined, ws)).toMatchObject({ fix: "add 'Source: done:<n>' to the PR body; use done:0 to done:2" });
  });

  it("takes the highest of the brief's, task's and caller's tier, and refuses a caller lowering it", () => {
    expect(checkTier("M", undefined, undefined)).toEqual({ tier: "M" });
    expect(checkTier("S", "L", "M")).toEqual({ tier: "L" });
    expect(checkTier("M", undefined, "L")).toEqual({ tier: "L" });
    expect(checkTier("M", "S", undefined)).toMatchObject({ fix: "omit --tier, or pass --tier M or higher" });
  });

  it("keys the freeze on the lowercased repo", () => {
    expect(freezeKey("Wynn-Dev/Fleetd-Testbed")).toBe("policy.freeze.wynn-dev.fleetd-testbed");
  });
});
