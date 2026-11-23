import { describe, expect, it } from "vitest";
import { bucketOf, channelNow, feedFile, pulled, stageChannel } from "./update-stage";

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

  it("reads its stage's feed only once that feed is out, else latest", async () => {
    expect(feedFile("stage10", "darwin")).toBe("stage10-mac.yml");
    expect(feedFile("stage50", "linux")).toBe("stage50-linux.yml");
    const there = (files: string[]) => (url: string) => Promise.resolve(files.some((f) => url === `https://feed/${f}`));
    expect(await channelNow("stage50", "https://feed", "linux", there(["stage50-linux.yml"]))).toBe("stage50");
    // No build has reached the stage yet (or a test's feed has only latest): latest, never a 404.
    expect(await channelNow("stage50", "https://feed", "linux", there(["latest-linux.yml"]))).toBe("latest");
    expect(await channelNow(null, "https://feed", "darwin", there(["stage10-mac.yml"]))).toBe("latest");
  });

  it("steps back only when every build that ships this app was pulled", () => {
    const v = "0.0.0-edge.202611231406.4+5877c50";
    expect(pulled({ builds: [{ appVersion: v, pulledAt: "2026-11-23T15:00:00Z" }] }, v)).toBe(true);
    expect(pulled({ builds: [{ appVersion: v, pulledAt: "2026-11-23T15:00:00Z" }, { appVersion: v }] }, v)).toBe(false);
    expect(pulled({ builds: [] }, v)).toBe(false);
    expect(pulled(null, v)).toBe(false);
  });
});
