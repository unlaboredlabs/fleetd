import { PlaybookName } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { applyUnifiedDiff } from "./diff.ts";
import { answer, bundled, change, edit, GATE, unifiedDiff, WORDING } from "./testKit.ts";
import { type Context, validateAnswer } from "./validate.ts";

const ctx: Context = {
  windowDays: 14,
  incidents: new Set(["I1", "I2"]),
  playbooks: new Map(PlaybookName.literals.map((name) => [name, bundled(name)])),
  busy: new Map(),
};

const check = (...changes: ReadonlyArray<unknown>) => {
  const out = validateAnswer(answer(...changes), ctx);
  if ("error" in out) throw new Error(out.error);
  return out;
};

describe("applyUnifiedDiff", () => {
  it("places hunks by their lines, not their line numbers, and refuses one that does not match", () => {
    const text = "a\nb\nc\nd\ne\n";
    expect(applyUnifiedDiff(text, "--- a/x.md\n+++ b/x.md\n@@ -40,3 +40,3 @@\n b\n-c\n+C\n d\n")).toEqual({ text: "a\nb\nC\nd\ne\n" });
    // Trailing spaces a model added to a context line still match.
    expect(applyUnifiedDiff(text, "@@ -1,2 +1,3 @@\n a  \n+a2\n b\n")).toEqual({ text: "a\na2\nb\nc\nd\ne\n" });
    expect(applyUnifiedDiff(text, "@@ -1,2 +1,2 @@\n a\n-x\n+y\n")).toEqual({ error: "hunk 1 of the diff does not match the current playbook" });
    expect(applyUnifiedDiff(text, "just prose")).toEqual({ error: "the diff is not a unified diff: it has no @@ hunk" });
  });
});

describe("validateAnswer", () => {
  it("accepts a wording change to leadInstructions", () => {
    const { accepted, dropped } = check(change({ diff: WORDING }));
    expect(dropped).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ kind: "wording", fields: ["leadInstructions"] });
    expect(accepted[0]!.after).toContain("Run the repro yourself before you claim done.");
  });

  it("classifies a gate change by its fields, whatever the model calls it", () => {
    const { accepted } = check(change({ diff: GATE, kind: "wording" }));
    expect(accepted[0]).toMatchObject({ kind: "gate", fields: ["reviewRules"], change: { kind: "wording" } });
    expect(check(change({ diff: edit("bugfix", "estimatePrior: 5", "estimatePrior: 4") })).accepted[0]).toMatchObject({ kind: "wording", fields: ["estimatePrior"] });
    // Touching the wording and a gate in one diff makes it a gate change.
    const before = bundled("bugfix");
    const mixed = unifiedDiff("bugfix", before, before.replace("estimatePrior: 5", "estimatePrior: 4").replace("maxReviewRounds: 3", "maxReviewRounds: 5"));
    expect(check(change({ diff: mixed })).accepted[0]).toMatchObject({ kind: "gate", fields: ["estimatePrior", "valueBar"] });
  });

  it.each([
    ["no incident cited", change({ diff: WORDING, fixesIncidents: [] }), "it cites no incident it fixes"],
    ["an incident outside the window", change({ diff: WORDING, fixesIncidents: ["I1", "I9"] }), "it cites I9, not incidents of the last 14 days"],
    ["an unknown metric", change({ diff: WORDING, metric: { class: "vibes", op: "decrease", windowDays: 14 } }), /^"vibes" is not a metric fleetd measures/u],
    ["an unknown playbook", change({ diff: WORDING, playbook: "chore" }), /^"chore" is not a playbook/u],
    ["a diff that does not apply", change({ diff: "@@ -1 +1 @@\n-nope\n+yes\n" }), "hunk 1 of the diff does not match the current playbook"],
    ["a wording change that also edits the body", change({ diff: edit("bugfix", "# Bugfix", "# Bug fixing") }), /^a wording change may touch only leadInstructions and estimatePrior/u],
    ["a change that breaks the frontmatter", change({ diff: edit("bugfix", "estimatePrior: 5", "estimatePrior: -1") }), /^playbook bugfix\.md after the diff is invalid/u],
    ["a renamed playbook", change({ diff: edit("bugfix", "name: bugfix", "name: feature") }), /its name is feature but the file is bugfix\.md/u],
  ])("drops %s", (_, item, reason) => {
    const { accepted, dropped } = check(item);
    expect(accepted).toEqual([]);
    expect(dropped).toHaveLength(1);
    if (typeof reason === "string") expect(dropped[0]!.reason).toBe(reason);
    else expect(dropped[0]!.reason).toMatch(reason);
  });

  it("drops a second change to the same playbook and changes to a busy one", () => {
    const busy = { ...ctx, busy: new Map([["feature", "R3 on feature is still measuring"]]) };
    const feature = change({ playbook: "feature", diff: edit("feature", "Idle is success.", "Idle is a success.") });
    const out = validateAnswer(answer(change({ diff: WORDING }), change({ diff: GATE }), feature), busy);
    if ("error" in out) throw new Error(out.error);
    expect(out.accepted.map((a) => a.change.playbook)).toEqual(["bugfix"]);
    expect(out.dropped).toEqual([
      { index: 1, playbook: "bugfix", reason: "a second change to bugfix in one run" },
      { index: 2, playbook: "feature", reason: "R3 on feature is still measuring" },
    ]);
  });

  it("reads the answer out of prose or a fence, and says when there is none", () => {
    expect(validateAnswer(`Here:\n\`\`\`json\n${answer(change({ diff: WORDING }))}\n\`\`\``, ctx)).toMatchObject({ accepted: [{ kind: "wording" }] });
    expect(validateAnswer("no changes needed", ctx)).toEqual({ error: "the answer has no JSON object" });
    expect(validateAnswer('{"proposals": []}', ctx)).toEqual({ error: 'the answer has no "changes" list' });
  });
});
