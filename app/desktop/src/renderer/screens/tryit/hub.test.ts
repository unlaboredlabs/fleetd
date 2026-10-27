import { describe, expect, it } from "vitest";
import { isProjectsList, refusalWords } from "./hub";

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

describe("the hub's answer to Try it or End", () => {
  it("goes only into its own project's previews, not another project's or another tool's", () => {
    const preview = { projectRef: { machineId: "devbox", projectId: "p1" } };
    expect(isProjectsList(["call", "previews_list", { projectRef: { machineId: "devbox", projectId: "p1" } }], preview)).toBe(true);
    expect(isProjectsList(["call", "previews_list", { projectRef: { machineId: "devbox", projectId: "p1" }, of: { kind: "pr", repo: "acme/a", number: 1 } }], preview)).toBe(true);
    expect(isProjectsList(["call", "previews_list", { projectRef: { machineId: "devbox", projectId: "p2" } }], preview)).toBe(false);
    expect(isProjectsList(["call", "previews_list", { projectRef: { machineId: "laptop", projectId: "p1" } }], preview)).toBe(false);
    expect(isProjectsList(["call", "browser_sessions", { projectRef: { machineId: "devbox", projectId: "p1" } }], preview)).toBe(false);
    expect(isProjectsList(["call", "previews_list"], preview)).toBe(false);
  });
});
