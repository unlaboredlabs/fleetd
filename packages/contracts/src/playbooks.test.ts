import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  Brief,
  DecisionRule,
  IntakeSubmitInput,
  IntakeSubmitOutput,
  Playbook,
  PlaybookRef,
  ResearchBrief,
  ResearchVerdict,
  Workstream,
  researchOutcome,
} from "./index.ts";

const accepts = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown>)(value)._tag === "Success";
const issue = (schema: Schema.Top, value: unknown) => {
  const result = Schema.decodeUnknownResult(schema as Schema.Codec<unknown>)(value);
  return result._tag === "Failure" ? String(result.failure) : "";
};
const at = "2026-10-17T10:00:00.000Z";
const sha = "0123456789abcdef0123456789abcdef01234567";

const review = (reviewers: number, verifier = false, planFirst = false) => ({ reviewers, verifier, planFirst });
const bugfix = {
  name: "bugfix",
  version: 1,
  requiredChecks: [{ anyOf: ["test", "cmd"], label: "a failing repro check" }],
  tierDefault: "S",
  reviewRules: { S: review(0), M: review(1), L: review(2, true, true) },
  valueBar: { maxReviewRounds: 2, requireSource: true },
  estimatePrior: 5,
  leadInstructions: "Reproduce first: a test or cmd check that fails before the fix and passes after.",
};

const brief = {
  goal: "g",
  why: "w",
  pointers: [],
  constraints: [],
  doneWhen: [{ type: "judge", criteria: "the judge reports both numbers" }],
  tier: "M",
};
const rule = { better: "higher", goAtLeast: 0.1, stopBelow: 0.02 };
const research = { ...brief, baseline: "main at its current head", metric: "pass rate on the eval set", decisionRule: rule, budget: { agentHours: 4 } };

describe("Playbook frontmatter", () => {
  it("takes the bugfix shape", () => expect(accepts(Playbook, bugfix)).toBe(true));
  it("refuses an unknown name, an unknown or empty check-type set, and lead instructions past 600", () => {
    expect(accepts(Playbook, { ...bugfix, name: "chore" })).toBe(false);
    expect(accepts(Playbook, { ...bugfix, requiredChecks: [{ anyOf: ["repro"] }] })).toBe(false);
    expect(accepts(Playbook, { ...bugfix, requiredChecks: [{ anyOf: [] }] })).toBe(false);
    expect(accepts(Playbook, { ...bugfix, leadInstructions: "x".repeat(600) })).toBe(true);
    expect(accepts(Playbook, { ...bugfix, leadInstructions: "x".repeat(601) })).toBe(false);
  });
  it("needs a review rule for every tier", () => {
    expect(accepts(Playbook, { ...bugfix, reviewRules: { S: review(0), M: review(1) } })).toBe(false);
  });
});

describe("PlaybookRef", () => {
  it("is a playbook name at a full git SHA", () => {
    for (const ref of [`bugfix@${sha}`, `finish-all@${sha}`, `research@${"a".repeat(64)}`]) expect(accepts(PlaybookRef, ref), ref).toBe(true);
    for (const ref of [`chore@${sha}`, "bugfix", `bugfix@${sha.slice(0, 7)}`, `bugfix@${sha.toUpperCase()}`, `bugfix@${sha}x`]) {
      expect(accepts(PlaybookRef, ref), ref).toBe(false);
    }
  });
});

describe("research briefs", () => {
  it("are plain briefs plus baseline, metric, decisionRule and budget.agentHours", () => {
    expect(accepts(ResearchBrief, research)).toBe(true);
    expect(accepts(Brief, brief)).toBe(true);
    expect(accepts(ResearchBrief, brief)).toBe(false);
  });
  it("name every missing field in the refusal", () => {
    const { baseline: _b, decisionRule: _r, ...rest } = research;
    const message = issue(ResearchBrief, { ...rest, budget: {} });
    expect(message).toContain("a research brief needs baseline, metric, decisionRule and budget.agentHours");
    expect(message).toContain("missing baseline, decisionRule, budget.agentHours");
  });
  it("refuse a rule whose STOP line is above its GO line", () => {
    expect(accepts(DecisionRule, { better: "higher", goAtLeast: 0.1, stopBelow: 0.2 })).toBe(false);
    expect(accepts(DecisionRule, { better: "higher", goAtLeast: 0.1, stopBelow: 0.1 })).toBe(true);
  });
});

describe("researchOutcome", () => {
  it("is GO at or past the GO line, STOP below the STOP line, INCONCLUSIVE between", () => {
    const higher = { better: "higher", goAtLeast: 0.1, stopBelow: 0.02 } as const;
    expect(researchOutcome(higher, { baseline: 0.5, candidate: 0.6 })).toBe("go");
    expect(researchOutcome(higher, { baseline: 0.5, candidate: 0.55 })).toBe("inconclusive");
    expect(researchOutcome(higher, { baseline: 0.5, candidate: 0.52 })).toBe("inconclusive");
    expect(researchOutcome(higher, { baseline: 0.5, candidate: 0.51 })).toBe("stop");
    expect(researchOutcome(higher, { baseline: 0.5, candidate: 0.3 })).toBe("stop");
  });
  it("counts a drop as the improvement when lower is better", () => {
    const lower = { better: "lower", goAtLeast: 50, stopBelow: 50 } as const;
    expect(researchOutcome(lower, { baseline: 400, candidate: 300 })).toBe("go");
    expect(researchOutcome(lower, { baseline: 400, candidate: 380 })).toBe("stop");
    expect(researchOutcome(lower, { baseline: 400, candidate: 500 })).toBe("stop");
  });
  it("must agree with a stored verdict", () => {
    const verdict = { outcome: "go", metricValues: { baseline: 0.5, candidate: 0.7 }, rule, computedAt: at };
    expect(accepts(ResearchVerdict, verdict)).toBe(true);
    expect(accepts(ResearchVerdict, { ...verdict, outcome: "stop" })).toBe(false);
  });
});

describe("Workstream M9 fields", () => {
  const workstream = {
    workstreamId: "W1",
    projectRef: { machineId: "forge", projectId: "p1" },
    title: "t",
    source: { text: "research: is it faster", channel: "mcp", by: "human", at },
    state: "done",
    createdAt: at,
    updatedAt: at,
  };
  const verdict = { outcome: "stop", metricValues: { baseline: 0.5, candidate: 0.5 }, rule, computedAt: at };
  it("still takes rows from before M9", () => expect(accepts(Workstream, workstream)).toBe(true));
  it("carries the pinned playbook and a stop outcome with its verdict", () => {
    expect(accepts(Workstream, { ...workstream, playbook: `research@${sha}`, outcome: "stop", verdict })).toBe(true);
  });
  it("refuses an outcome without its verdict, or one that disagrees with it", () => {
    expect(accepts(Workstream, { ...workstream, outcome: "stop" })).toBe(false);
    expect(accepts(Workstream, { ...workstream, verdict })).toBe(false);
    expect(accepts(Workstream, { ...workstream, outcome: "go", verdict })).toBe(false);
  });
});

describe("intake_submit", () => {
  const base = { text: "fix: the lab README has a typo", clientRequestId: "r1" };
  it("takes a project, no project, and a template", () => {
    expect(accepts(IntakeSubmitInput, base)).toBe(true);
    expect(accepts(IntakeSubmitInput, { ...base, machineId: "forge", projectId: "p1", template: "bugfix" })).toBe(true);
    expect(accepts(IntakeSubmitInput, { ...base, template: "chore" })).toBe(false);
  });
  it("refuses half a project", () => {
    expect(accepts(IntakeSubmitInput, { ...base, machineId: "forge" })).toBe(false);
    expect(accepts(IntakeSubmitInput, { ...base, projectId: "p1" })).toBe(false);
  });
  it("answers with a workstream and its echo, or with the routing ask", () => {
    const echo = { projectRef: { machineId: "forge", projectId: "lab" }, template: "bugfix", reason: "the README lives in the lab repo; prefix fix:" };
    expect(accepts(IntakeSubmitOutput, { workstreamId: "W3", echo })).toBe(true);
    expect(accepts(IntakeSubmitOutput, { askId: "A4" })).toBe(true);
    expect(accepts(IntakeSubmitOutput, { workstreamId: "W3", askId: "A4" })).toBe(false);
    expect(accepts(IntakeSubmitOutput, {})).toBe(false);
    expect(accepts(IntakeSubmitOutput, { workstreamId: "W3", echo: { ...echo, reason: "two\nlines" } })).toBe(false);
  });
});
