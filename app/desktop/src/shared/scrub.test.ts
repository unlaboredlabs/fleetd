import { describe, expect, it } from "vitest";
import { errorText, routeShape, scrub } from "./scrub";

describe("scrubbing what an error says", () => {
  it("takes out keys, tokens, codes and a URL's query, and shows the home directory as ~", () => {
    expect(scrub(`connect failed for fld_${"abcdefghijklmnopqrstuvwxyz".repeat(2)}`)).toBe("connect failed for [redacted]");
    expect(scrub("got 8f3a9c2e7b1d4f6a0c5e9b2d7f1a3c8e back")).toBe("got [redacted] back");
    expect(scrub("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [redacted]");
    expect(scrub('{"agentKey":"s3cr3t"} token=xyz')).toBe('{"agentKey":"[redacted]"} token=[redacted]');
    expect(scrub("fleetd://pair?hub=http%3A%2F%2Fbox&code=WXYZ-6789")).toBe("fleetd://pair?[redacted]");
    expect(scrub("https://user:pw@hub.example/x")).toBe("https://[redacted]@hub.example/x");
    expect(scrub("at f (/home/dev/src/app.js:1:2)", "/home/dev")).toBe("at f (~/src/app.js:1:2)");
  });

  it("keeps plain words, file names and line numbers", () => {
    const line = "RangeError: Invalid time value at dayKey (app://fleetd/assets/ChatScreen-Bq3x.js:12:345)";
    expect(scrub(line)).toBe(line);
  });

  it("keeps an error's first line and its frames, not the lines of text around them", () => {
    const error = new RangeError("Invalid time value");
    error.stack = "RangeError: Invalid time value\n    at dayKey (app://fleetd/a.js:1:2)\n  some pasted text\n    at chatRows (app://fleetd/a.js:3:4)";
    expect(errorText(error)).toBe("RangeError: Invalid time value\n    at dayKey (app://fleetd/a.js:1:2)\n    at chatRows (app://fleetd/a.js:3:4)");
    expect(errorText({ message: "x".repeat(1000) }).length).toBeLessThan(320);
  });

  it("names a route without its ids or query", () => {
    expect(routeShape("#/project/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22?message=m4")).toBe("#/project/…");
    expect(routeShape("#/onboarding?hub=http%3A%2F%2Fbox&code=WXYZ-6789")).toBe("#/onboarding");
    expect(routeShape("#/settings/prompts")).toBe("#/settings/prompts");
  });
});
