import { describe, expect, it } from "vitest";
import { bucketOf, pulled, stageChannel } from "./update-stage";

describe("update stage", () => {
  it("puts a bucket in its stage feed", () => {
    expect(stageChannel(0)).toBe("stage10");
    expect(stageChannel(9)).toBe("stage10");
    expect(stageChannel(10)).toBe("stage50");
    expect(stageChannel(49)).toBe("stage50");
    expect(stageChannel(50)).toBeNull();
    expect(bucketOf("a")).toBe(bucketOf("a"));
    expect(bucketOf("a")).toBeLessThan(100);
  });

  it("steps back only when every build that ships this app was pulled", () => {
    const v = "0.0.0-edge.202611231406.4+5877c50";
    expect(pulled({ builds: [{ appVersion: v, pulledAt: "2026-11-23T15:00:00Z" }] }, v)).toBe(true);
    expect(pulled({ builds: [{ appVersion: v, pulledAt: "2026-11-23T15:00:00Z" }, { appVersion: v }] }, v)).toBe(false);
    expect(pulled({ builds: [] }, v)).toBe(false);
    expect(pulled(null, v)).toBe(false);
  });
});
