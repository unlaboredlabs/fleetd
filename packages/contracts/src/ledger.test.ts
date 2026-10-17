import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Ask, Brief, DecisionKey, LeadCall, LeadResultFrame, Step, WorkstreamId } from "./index.ts";

const accepts = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown>)(value)._tag === "Success";
const at = "2026-10-17T10:00:00.000Z";

describe("DecisionKey", () => {
  it("accepts lowercase dotted slugs up to 80", () => {
    for (const key of ["api", "api.health.path", "pref.dark_mode", "a1.b-2", `a.${"x".repeat(78)}`]) expect(accepts(DecisionKey, key), key).toBe(true);
  });
  it("rejects case, empty segments, a leading _ or -, and length past 80", () => {
    for (const key of ["", "Api", "api.", ".api", "api..path", "_api", "api-x.y", "api path", `a.${"x".repeat(79)}`]) {
      expect(accepts(DecisionKey, key), key).toBe(false);
    }
  });
});

describe("hub serial ids", () => {
  it("are the prefix plus a positive integer", () => {
    for (const id of ["W1", "W12"]) expect(accepts(WorkstreamId, id)).toBe(true);
    for (const id of ["W0", "W01", "w1", "A1", "W", "W1x"]) expect(accepts(WorkstreamId, id), id).toBe(false);
  });
});

describe("Step commands", () => {
  const step = (command: string) => ({ text: "run it", where: "forge", command });
  it("refuse <placeholders>", () => {
    for (const command of ["export TOKEN=<token>", "curl <your api url>", "gh secret set X -b <VALUE>"]) {
      expect(accepts(Step, step(command)), command).toBe(false);
    }
  });
  it("allow shell redirects and comparisons", () => {
    for (const command of ["sort < in.txt > out.txt", "echo hi 2>&1", "diff <(ls a) <(ls b)", "cat <<EOF > f", "test 1 -lt 2"]) {
      expect(accepts(Step, step(command)), command).toBe(true);
    }
  });
  it("take a machine id, browser or phone as where", () => {
    expect(accepts(Step, { text: "t", where: "phone" })).toBe(true);
    expect(accepts(Step, { text: "t", where: "My Mac" })).toBe(false);
  });
});

describe("ask call", () => {
  const ask = { op: "ask", key: "api.health.path", class: "product", text: "Path?", recommendation: "/healthz" };

  it("defaults to a decide that blocks nothing and did not proceed", () => {
    const decoded = Schema.decodeUnknownSync(LeadCall)(ask);
    expect(decoded.op === "ask" && [decoded.kind, decoded.blocks, decoded.proceededOnRec]).toEqual(["decide", "nothing", false]);
  });

  it("requires a recommendation for decide and steps for do", () => {
    const { recommendation: _, ...noRec } = ask;
    expect(accepts(LeadCall, noRec)).toBe(false);
    expect(accepts(LeadCall, { ...noRec, kind: "do" })).toBe(false);
    expect(accepts(LeadCall, { ...noRec, kind: "do", steps: [] })).toBe(false);
    expect(accepts(LeadCall, { ...noRec, kind: "do", steps: [{ text: "Add the DNS record", where: "browser" }] })).toBe(true);
  });

  it("leaves class policy to the hub but caps text at 500 and options at 6", () => {
    expect(accepts(LeadCall, { ...ask, class: "naming" })).toBe(true);
    expect(accepts(LeadCall, { ...ask, text: "x".repeat(501) })).toBe(false);
    expect(accepts(LeadCall, { ...ask, options: ["a", "b", "c", "d", "e", "f", "g"] })).toBe(false);
  });
});

describe("Ask record", () => {
  const ask = {
    askId: "A1",
    projectRef: { machineId: "forge", projectId: "p1" },
    kind: "decide",
    key: "api.health.path",
    class: "product",
    text: "Path?",
    recommendation: "/healthz",
    blocks: "nothing",
    proceededOnRec: true,
    state: "open",
    createdAt: at,
  };
  it("holds the same kind rule and a closed class list", () => {
    expect(accepts(Ask, ask)).toBe(true);
    const { recommendation: _, ...noRec } = ask;
    expect(accepts(Ask, noRec)).toBe(false);
    expect(accepts(Ask, { ...noRec, kind: "do", steps: [{ text: "Tick the box", where: "phone" }] })).toBe(true);
    expect(accepts(Ask, { ...ask, class: "naming" })).toBe(false);
  });

  it("leaves out projectRef only on an intake.route.* ask", () => {
    const { projectRef: _, ...unrouted } = ask;
    expect(accepts(Ask, unrouted)).toBe(false);
    expect(accepts(Ask, { ...unrouted, key: "intake.route.tidy-the-docs-1a2b3c" })).toBe(true);
    expect(accepts(Ask, { ...ask, key: "intake.route.tidy-the-docs-1a2b3c" })).toBe(true);
  });
});

describe("Brief", () => {
  const brief = { goal: "g", why: "w", pointers: [], constraints: [], tier: "S", doneWhen: [{ type: "http", url: "http://127.0.0.1:4790/health", status: 200 }] };
  it("needs at least one done-when check and a tier", () => {
    expect(accepts(Brief, brief)).toBe(true);
    expect(accepts(Brief, { ...brief, doneWhen: [] })).toBe(false);
    expect(accepts(Brief, { ...brief, tier: "XL" })).toBe(false);
  });
  it("checks each done-when shape", () => {
    expect(accepts(Brief, { ...brief, doneWhen: [{ type: "cmd", machineId: "forge", argv: [], expectExit: 0 }] })).toBe(false);
    expect(accepts(Brief, { ...brief, doneWhen: [{ type: "http", url: "file:///etc/passwd", status: 200 }] })).toBe(false);
    expect(accepts(Brief, { ...brief, doneWhen: [{ type: "nope" }] })).toBe(false);
  });
});

describe("LeadResultFrame", () => {
  it("carries exactly one of result and error", () => {
    const error = { code: "invalid", message: "m" };
    const result = { op: "status_set", workstreamId: "W1" };
    expect(accepts(LeadResultFrame, { t: "lead_result", id: "c1", error })).toBe(true);
    expect(accepts(LeadResultFrame, { t: "lead_result", id: "c1", result, error })).toBe(false);
    expect(accepts(LeadResultFrame, { t: "lead_result", id: "c1" })).toBe(false);
  });
});
