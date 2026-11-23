// "Merge, then verify"'s parts on their own: the bisect over a check's runs on the base's commits, how a run reads,
// the repo's `ciAtOnce`, and the texts the culprit's writer, its revert and the lead get.
import { expect, test } from "bun:test";
import type { CheckRun } from "../src/hub/train/github.ts";
import { CI_AT_ONCE, ciAtOnce, parse } from "../src/hub/train/settings.ts";
import { bisect, type Culprit, leadLine, revertBody, type Seen, seenOf, writerText } from "../src/hub/train/verify.ts";
import { deliberate } from "../src/hub/train/reverts.ts";
import { behind, NONE, required, upToDateFrom, upToDateLine, withoutUpToDate } from "../src/hub/train/up_to_date.ts";

const run = (id: number, status: string, conclusion: string | null, name = "fleetd"): CheckRun => ({ id, name, status, conclusion }) as CheckRun;

test("the culprit is the first red commit after the last green one", () => {
  expect(bisect(["green", "red"])).toEqual({ kind: "culprit", at: 1 });
  expect(bisect(["green", "green", "red", "red", "red"])).toEqual({ kind: "culprit", at: 2 });
  // A commit the check has no run on counts as its parent: a check scoped to some paths skipped it.
  expect(bisect(["green", "none", "none", "red"])).toEqual({ kind: "culprit", at: 3 });
  expect(bisect(["green", "none", "red", "none", "red"])).toEqual({ kind: "culprit", at: 2 });
});

test("with no green run to start from, nothing is blamed", () => {
  expect(bisect(["red", "red"])).toEqual({ kind: "unknown" });
  expect(bisect(["none", "cancelled", "red"])).toEqual({ kind: "unknown" });
  expect(bisect(["green", "green"])).toEqual({ kind: "unknown" });
});

test("a run still going between the last green and the first red is waited for", () => {
  expect(bisect(["green", "cancelled", "pending", "red"])).toEqual({ kind: "wait" });
});

test("cancelled runs between are re-run from the middle, halving what is left each time", () => {
  // Seven merges between the last green and the red one, every run cancelled: the culprit is the 5th.
  const truth: Seen[] = ["green", "green", "green", "green", "green", "red", "red", "red", "red"];
  const seen: Seen[] = ["green", "cancelled", "cancelled", "cancelled", "cancelled", "cancelled", "cancelled", "cancelled", "red"];
  let probes = 0;
  for (;;) {
    const step = bisect(seen);
    if (step.kind === "culprit") {
      expect(step.at).toBe(5);
      break;
    }
    expect(step.kind).toBe("probe");
    if (step.kind !== "probe") return;
    seen[step.at] = truth[step.at]!;
    probes++;
  }
  // A binary search: ⌈log2(7 + 1)⌉ re-runs, never one per merge.
  expect(probes).toBeLessThanOrEqual(Math.ceil(Math.log2(7 + 1)));
});

test("the number of re-runs grows with the log of the merges between, not with them", () => {
  const probesFor = (between: number, culprit: number) => {
    const seen: Seen[] = ["green", ...Array<Seen>(between).fill("cancelled"), "red"];
    let probes = 0;
    for (;;) {
      const step = bisect(seen);
      if (step.kind !== "probe") return probes;
      seen[step.at] = step.at >= culprit ? "red" : "green";
      probes++;
    }
  };
  const small = Math.max(...[1, 2, 3, 4].map((c) => probesFor(4, c)));
  const large = Math.max(...Array.from({ length: 28 }, (_, i) => probesFor(28, i + 1)));
  // Seven times the merges costs at most three more re-runs: a ratio, not a count of merges.
  expect(large / small).toBeLessThan(28 / 4);
  expect(large - small).toBeLessThanOrEqual(3);
});

test("a check's newest run reads as green, red, pending, cancelled or none", () => {
  expect(seenOf([], "fleetd")[0]).toBe("none");
  expect(seenOf([run(1, "completed", "success", "lint")], "fleetd")[0]).toBe("none");
  expect(seenOf([run(1, "completed", "skipped")], "fleetd")[0]).toBe("none");
  expect(seenOf([run(1, "in_progress", null)], "fleetd")[0]).toBe("pending");
  expect(seenOf([run(1, "completed", "cancelled")], "fleetd")[0]).toBe("cancelled");
  expect(seenOf([run(1, "completed", "failure")], "fleetd")[0]).toBe("red");
  // A re-run that passed is the newest: a flake on that commit reads green.
  expect(seenOf([run(1, "completed", "failure"), run(2, "completed", "success")], "fleetd")[0]).toBe("green");
  expect(seenOf([run(2, "completed", "success"), run(3, "queued", null)], "fleetd")[0]).toBe("pending");
});

test("a repo sets how many PRs are in CI at once; 4 when it doesn't", () => {
  expect(ciAtOnce(parse("{}"))).toBe(CI_AT_ONCE);
  expect(CI_AT_ONCE).toBe(4);
  expect(ciAtOnce(undefined)).toBe(4);
  expect(ciAtOnce(parse('{"ciAtOnce": 2, "fastChecks": ["lint"]}'))).toBe(2);
  expect(() => parse('{"ciAtOnce": 0}')).toThrow(/ciAtOnce/);
  expect(() => parse('{"ciAtOnce": 1.5}')).toThrow(/ciAtOnce/);
  expect(() => parse('{"ciAtOnce": "4"}')).toThrow(/ciAtOnce/);
  expect(() => parse('{"ciAtonce": 4}')).toThrow(/unknown field `ciAtonce`/);
});

test("the revert says it reverts on purpose, and the writer and the lead hear what happened", () => {
  const culprit: Culprit = { sha: "a".repeat(40), prNumber: 12, prUrl: "https://github.com/acme/storefront/pull/12" };
  const check = { ...run(9, "completed", "failure"), html_url: "https://github.com/acme/storefront/actions/runs/9" } as CheckRun;
  const w = { repo: "acme/storefront", sha: "b".repeat(40), base: "main", projectRef: { machineId: "devbox", projectId: "storefront" }, prUrl: culprit.prUrl, sinceMs: 0 };
  const body = revertBody(culprit, check, w);
  // The train's own check for a PR that undoes merged work lets it through.
  expect(deliberate(body)).toBe(true);
  expect(body).toContain("Reverts #12");
  const text = writerText(culprit, check, "main", "https://github.com/acme/storefront/pull/13");
  expect(text).toContain("https://github.com/acme/storefront/pull/13");
  expect(text).toContain("origin/main");
  const line = leadLine("X4", culprit, check, w, "https://github.com/acme/storefront/pull/13", "T7");
  expect(line.split("\n")).toHaveLength(1);
  expect(line).toContain("pull/13");
  expect(line).toContain("T7");
});

test("a base requires up-to-date branches through its own ruleset, an organization's, or classic protection", () => {
  const rule = (strict: boolean, source = "Repository", id = 7) => ({
    type: "required_status_checks",
    ruleset_source_type: source,
    ruleset_id: id,
    parameters: { strict_required_status_checks_policy: strict, required_status_checks: [{ context: "fleetd" }] },
  });
  expect(required(upToDateFrom([], null))).toBe(false);
  expect(upToDateFrom([rule(false)], { requiresStrictStatusChecks: false })).toEqual(NONE);
  expect(upToDateFrom([rule(true), rule(true), { type: "deletion", ruleset_id: 8 }], null)).toEqual({ rulesets: [7], orgRulesets: [], classic: false });
  expect(upToDateFrom([rule(true, "Organization", 9)], null)).toEqual({ rulesets: [], orgRulesets: [9], classic: false });
  expect(upToDateFrom([], { requiresStrictStatusChecks: true }).classic).toBe(true);
  // Only that one parameter changes: the required check and every other rule stay.
  const before = [{ type: "deletion" }, rule(true)];
  expect(withoutUpToDate(before)).toEqual([{ type: "deletion" }, rule(false)]);
  expect(upToDateLine("acme/storefront", "main", { rulesets: [7], orgRulesets: [], classic: false })).toContain("one at a time");
  expect(upToDateLine("acme/storefront", "main", { rulesets: [], orgRulesets: [9], classic: false })).toContain("organization owner");
  expect(behind("Head branch is not up to date with the base branch")).toBe(true);
  expect(behind("Base branch was modified. Review and try the merge again.")).toBe(true);
  expect(behind("Required status check \"fleetd\" is expected.")).toBe(false);
});
