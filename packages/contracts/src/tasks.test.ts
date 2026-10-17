import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CapSetInput, DEFAULT_POLICY, LeadCall, PolicyFile, Task, TaskId } from "./index.ts";

const accepts = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown>)(value)._tag === "Success";
const at = "2026-10-17T10:00:00.000Z";
const spawn = { op: "task_spawn", workstreamId: "W1", title: "add file", areas: ["docs"], prompt: "create docs/x.md", serves: "done:0" };

describe("TaskId", () => {
  it("is T plus a positive integer", () => {
    for (const id of ["T1", "T42"]) expect(accepts(TaskId, id), id).toBe(true);
    for (const id of ["T0", "T01", "t1", "W1", "T", "T1a"]) expect(accepts(TaskId, id), id).toBe(false);
  });
});

describe("task spawn", () => {
  it("defaults to a write task and needs an area for it", () => {
    const decoded = Schema.decodeUnknownSync(LeadCall)(spawn);
    expect(decoded.op === "task_spawn" && decoded.kind).toBe("write");
    expect(accepts(LeadCall, { ...spawn, areas: [] })).toBe(false);
    const { areas: _, ...noAreas } = spawn;
    expect(accepts(LeadCall, noAreas)).toBe(false);
    expect(accepts(LeadCall, { ...noAreas, kind: "read" })).toBe(true);
    expect(accepts(LeadCall, { ...noAreas, kind: "review", pr: "https://github.com/o/r/pull/1" })).toBe(true);
  });

  it("caps the title at 80 on one line and the prompt at 8000", () => {
    expect(accepts(LeadCall, { ...spawn, title: "x".repeat(80), prompt: "x".repeat(8000) })).toBe(true);
    expect(accepts(LeadCall, { ...spawn, title: "x".repeat(81) })).toBe(false);
    expect(accepts(LeadCall, { ...spawn, title: "a\nb" })).toBe(false);
    expect(accepts(LeadCall, { ...spawn, title: "" })).toBe(false);
    expect(accepts(LeadCall, { ...spawn, prompt: "x".repeat(8001) })).toBe(false);
  });

  it("takes slug-like, distinct area names", () => {
    expect(accepts(LeadCall, { ...spawn, areas: ["docs", "hub-tasks", "a_b", "x".repeat(40)] })).toBe(true);
    for (const area of ["Docs", "-docs", "apps/hub", "a b", "", "x".repeat(41)]) {
      expect(accepts(LeadCall, { ...spawn, areas: [area] }), area).toBe(false);
    }
    expect(accepts(LeadCall, { ...spawn, areas: ["docs", "docs"] })).toBe(false);
  });

  it("refuses an effort outside the known levels", () => {
    expect(accepts(LeadCall, { ...spawn, effort: "high" })).toBe(true);
    expect(accepts(LeadCall, { ...spawn, effort: "xhigh" })).toBe(false);
  });
});

describe("Task", () => {
  const task = {
    taskId: "T1",
    projectRef: { machineId: "forge", projectId: "p1" },
    workstreamId: "W1",
    title: "add file",
    kind: "write",
    prompt: "create docs/x.md",
    areas: ["docs"],
    model: "claude-opus-5-5",
    effort: "high",
    state: "done",
    attempt: 1,
    result: { status: "done", tail: "x".repeat(2000), branch: "fleetd/T1-add-file", at },
    createdAt: at,
  };

  it("holds the same area rule and caps the result tail at 2000", () => {
    expect(accepts(Task, task)).toBe(true);
    expect(accepts(Task, { ...task, areas: [] })).toBe(false);
    expect(accepts(Task, { ...task, kind: "review", areas: [] })).toBe(true);
    expect(accepts(Task, { ...task, result: { ...task.result, tail: "x".repeat(2001) } })).toBe(false);
    expect(accepts(Task, { ...task, result: { ...task.result, prUrl: "javascript:alert(1)" } })).toBe(false);
  });
});

describe("policy file", () => {
  it("maps area names to repo-relative globs", () => {
    const decoded = Schema.decodeUnknownSync(PolicyFile)({ areas: { docs: ["docs/**", "*.md"] }, defaults: { effort: "high" } });
    expect(decoded.areas).toEqual({ docs: ["docs/**", "*.md"] });
    expect(DEFAULT_POLICY.areas).toEqual({ all: ["**"] });
  });

  it("refuses bad area names, empty glob lists and absolute globs", () => {
    expect(accepts(PolicyFile, { areas: { "Bad Name": ["x/**"] } })).toBe(false);
    expect(accepts(PolicyFile, { areas: { docs: [] } })).toBe(false);
    expect(accepts(PolicyFile, { areas: { docs: ["/etc/**"] } })).toBe(false);
    expect(accepts(PolicyFile, { areas: { docs: ["docs/**"] }, defaults: { effort: "medium-ish" } })).toBe(false);
  });
});

describe("cap_set", () => {
  it("needs a cap, a share or both", () => {
    const share = { projectRef: { machineId: "forge", projectId: "p1" }, share: 8 };
    expect(accepts(CapSetInput, { cap: 40 })).toBe(true);
    expect(accepts(CapSetInput, { share })).toBe(true);
    expect(accepts(CapSetInput, {})).toBe(false);
    expect(accepts(CapSetInput, { cap: 0 })).toBe(false);
  });
});
