import { describe, expect, it } from "vitest";
import { refusalWords } from "./hub";

describe("a refused Try it", () => {
  it("says it in plain words: a read key is told what would start one, the hub's own words otherwise", () => {
    expect(refusalWords({ code: "forbidden", message: "This key lacks the operate role." })).toBe(
      "This device’s key can open a preview that is running, but not start one. A key with admin or operate access can.",
    );
    expect(refusalWords({ code: "offline", message: "Not connected." })).toBe("The hub couldn’t be reached. Try again once you’re connected.");
    expect(refusalWords({ code: "invalid", message: "storefront has no Try it setting.", fix: "Approve the lead’s proposal, or set one in Settings." })).toBe(
      "storefront has no Try it setting. Approve the lead’s proposal, or set one in Settings.",
    );
    expect(refusalWords({ code: "failed", message: "No machine can host it now." })).toBe("No machine can host it now.");
  });
});
