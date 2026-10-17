import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CmdResult, HubToNode, LeadCall, NodeToHub, ReviewVerdict, Serves } from "./index.ts";

const accepts = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown>)(value)._tag === "Success";
const sha = "0123456789abcdef0123456789abcdef01234567";
const spawn = { op: "task_spawn", workstreamId: "W1", title: "add file", areas: ["docs"], prompt: "create docs/x.md" };

describe("serves", () => {
  it("takes a done-when index, an issue, a one-line defect or an ask", () => {
    for (const s of ["done:0", "done:12", "issue:#7", "issue:https://github.com/o/r/issues/7", "defect:login 500s", `defect:${"x".repeat(200)}`, "ask:A3"]) {
      expect(accepts(Serves, s), s).toBe(true);
    }
    for (const s of ["", "done:", "done:01", "done:-1", "issue:7", "issue:#0", "issue:ftp://x", "defect:", "defect:  ", "defect:a\nb", `defect:${"x".repeat(201)}`, "ask:3", "ask:A0", "fix the bug", "DONE:1"]) {
      expect(accepts(Serves, s), s).toBe(false);
    }
  });

  it("is required for a write spawn, with the fix text", () => {
    const refused = Schema.decodeUnknownExit(LeadCall)(spawn);
    expect(refused._tag).toBe("Failure");
    expect(String(refused)).toContain("say what this serves: --serves done:<n> | issue:<ref> | defect:<text> | ask:<id>");
    expect(accepts(LeadCall, { ...spawn, serves: "done:0" })).toBe(true);
    expect(accepts(LeadCall, { ...spawn, kind: "read", areas: [] })).toBe(true);
  });

  it("allows --qa only on review tasks", () => {
    expect(accepts(LeadCall, { ...spawn, kind: "review", areas: [], qa: true })).toBe(true);
    expect(accepts(LeadCall, { ...spawn, serves: "done:0", qa: true })).toBe(false);
  });
});

describe("review verdict", () => {
  const verdict = { taskId: "T3", prHeadSha: sha, blocking: 0, nonBlocking: 2, summary: "two nits" };

  it("needs a full lowercase head SHA so the same head always compares equal", () => {
    expect(accepts(ReviewVerdict, verdict)).toBe(true);
    expect(accepts(ReviewVerdict, { ...verdict, prHeadSha: "a".repeat(64) })).toBe(true);
    for (const prHeadSha of [sha.slice(0, 7), sha.toUpperCase(), `${sha}0`]) {
      expect(accepts(ReviewVerdict, { ...verdict, prHeadSha }), prHeadSha).toBe(false);
    }
  });

  it("refuses negative counts and an empty or long summary", () => {
    expect(accepts(LeadCall, { op: "review_verdict", ...verdict })).toBe(true);
    expect(accepts(ReviewVerdict, { ...verdict, blocking: -1 })).toBe(false);
    expect(accepts(ReviewVerdict, { ...verdict, summary: "" })).toBe(false);
    expect(accepts(ReviewVerdict, { ...verdict, summary: "x".repeat(1001) })).toBe(false);
  });
});

describe("cmd check frames", () => {
  it("run argv in an absolute cwd and come back with the exit code or null", () => {
    const check = { t: "cmd_check", id: "k1", cwd: "/srv/p", argv: ["test", "-f", "docs/x.md"], timeoutSec: 120 };
    expect(accepts(HubToNode, check)).toBe(true);
    expect(accepts(HubToNode, { ...check, cwd: "srv/p" })).toBe(false);
    expect(accepts(HubToNode, { ...check, argv: [] })).toBe(false);
    expect(accepts(HubToNode, { ...check, timeoutSec: 0 })).toBe(false);
    const result = { t: "cmd_result", id: "k1", exitCode: 1, outputTail: "", timedOut: false };
    expect(accepts(NodeToHub, result)).toBe(true);
    expect(accepts(NodeToHub, { ...result, exitCode: null, timedOut: true })).toBe(true);
    expect(accepts(CmdResult, { ...result, outputTail: "x".repeat(2001) })).toBe(false);
  });
});
