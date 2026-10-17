import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Change, ChangeId, GitHubPrUrl, GitHubRepo, LeadCall, PatchId, TrainState, parsePrUrl } from "./index.ts";

const accepts = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown>)(value)._tag === "Success";
const at = "2026-10-17T10:00:00.000Z";
const sha = "0123456789abcdef0123456789abcdef01234567";
const change = {
  changeId: "X1",
  projectRef: { machineId: "forge", projectId: "p1" },
  repo: "unlaboredlabs/fleetd-testbed",
  prNumber: 7,
  prUrl: "https://github.com/unlaboredlabs/fleetd-testbed/pull/7",
  branch: "fleetd/T1-add-file",
  taskId: "T1",
  workstreamId: "W1",
  serves: "done:0",
  tier: "M",
  headSha: sha,
  state: "queued",
  reviews: [{ taskId: "T2", prHeadSha: sha, patchId: "f".repeat(40), blocking: 0, nonBlocking: 1 }],
  createdAt: at,
  updatedAt: at,
};

describe("ChangeId", () => {
  it("is X plus a positive integer", () => {
    for (const id of ["X1", "X42"]) expect(accepts(ChangeId, id), id).toBe(true);
    for (const id of ["X0", "X01", "x1", "C1", "X", "X1a"]) expect(accepts(ChangeId, id), id).toBe(false);
  });
});

describe("GitHub repo and PR URL", () => {
  it("takes owner/name", () => {
    for (const repo of ["unlaboredlabs/fleetd", "Microsoft/TypeScript", "o/r.js", "o/.github", "o/a_b-c"]) expect(accepts(GitHubRepo, repo), repo).toBe(true);
    for (const repo of ["fleetd", "o/", "/r", "o/r/x", "-o/r", "o/.", "o/..", "o/r s", `${"o".repeat(40)}/r`, "https://github.com/o/r"]) {
      expect(accepts(GitHubRepo, repo), repo).toBe(false);
    }
  });

  it("takes only https://github.com/<owner>/<name>/pull/<n>", () => {
    expect(parsePrUrl("https://github.com/unlaboredlabs/fleetd/pull/12")).toEqual({ repo: "unlaboredlabs/fleetd", prNumber: 12 });
    for (const url of [
      "http://github.com/o/r/pull/1",
      "https://github.com/o/r/pull/0",
      "https://github.com/o/r/pull/01",
      "https://github.com/o/r/issues/1",
      "https://github.com/o/r/pull/1/files",
      "https://github.com/o/r/pull/1#discussion",
      "https://github.com.evil.io/o/r/pull/1",
      "https://ghe.example.com/o/r/pull/1",
      "https://github.com/o/../pull/1",
      "o/r#1",
    ]) {
      expect(accepts(GitHubPrUrl, url), url).toBe(false);
    }
  });
});

describe("Change", () => {
  it("needs prUrl to name the same repo and PR number", () => {
    expect(accepts(Change, change)).toBe(true);
    expect(accepts(Change, { ...change, prUrl: "https://github.com/UnlaboredLabs/fleetd-testbed/pull/7" })).toBe(true);
    expect(accepts(Change, { ...change, prNumber: 8 })).toBe(false);
    expect(accepts(Change, { ...change, repo: "unlaboredlabs/fleetd" })).toBe(false);
    expect(accepts(Change, { ...change, prNumber: 0, prUrl: "https://github.com/unlaboredlabs/fleetd-testbed/pull/0" })).toBe(false);
  });

  it("binds reviews and merges to full lowercase SHAs and patch ids", () => {
    expect(accepts(Change, { ...change, patchId: "a".repeat(64), mergedSha: "b".repeat(40), state: "merged" })).toBe(true);
    for (const bad of [sha.slice(0, 12), sha.toUpperCase(), `${sha}0`]) {
      expect(accepts(Change, { ...change, headSha: bad }), bad).toBe(false);
      expect(accepts(PatchId, bad), bad).toBe(false);
      expect(accepts(Change, { ...change, reviews: [{ ...change.reviews[0], patchId: bad }] }), bad).toBe(false);
    }
  });
});

describe("TrainState", () => {
  it("lists each Change once", () => {
    expect(accepts(TrainState, { repo: "o/r", frozen: false, head: "X1", queue: ["X2", "X3"] })).toBe(true);
    expect(accepts(TrainState, { repo: "o/r", frozen: true, queue: ["X2", "X2"] })).toBe(false);
  });
});

describe("change lead calls", () => {
  it("enqueue a GitHub PR URL with an optional valid serves", () => {
    const enqueue = { op: "change_enqueue", prUrl: "https://github.com/o/r/pull/3" };
    expect(accepts(LeadCall, enqueue)).toBe(true);
    expect(accepts(LeadCall, { ...enqueue, taskId: "T1", workstreamId: "W1", serves: "done:2", tier: "L" })).toBe(true);
    expect(accepts(LeadCall, { ...enqueue, prUrl: "https://example.com/o/r/pull/3" })).toBe(false);
    expect(accepts(LeadCall, { ...enqueue, serves: "fix it" })).toBe(false);
    expect(accepts(LeadCall, { op: "change_status", changeId: "X1" })).toBe(true);
    expect(accepts(LeadCall, { op: "change_status", changeId: "T1" })).toBe(false);
  });
});
