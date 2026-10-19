import { describe, expect, it } from "vitest";
import { IPC } from "./channels";
import { MAX_CALL_INPUT_BYTES, MAX_CALL_INPUT_DEPTH, parseRequest } from "./ipc";

describe("parseRequest", () => {
  it("accepts a well-formed call and keeps its input", () => {
    const parsed = parseRequest(IPC.hubCall, [{ tool: "fleetd_status", input: { scope: { project: "p1" } }, timeoutMs: 60_000 }]);
    expect(parsed).toEqual({ ok: true, args: [{ tool: "fleetd_status", input: { scope: { project: "p1" } }, timeoutMs: 60_000 }] });
  });

  it("refuses tool names that aren't MCP tool names", () => {
    for (const tool of ["", "Fleetd", "a b", "x".repeat(65), "../x"]) {
      expect(parseRequest(IPC.hubCall, [{ tool, input: {} }]).ok).toBe(false);
    }
  });

  it("refuses inputs that aren't plain JSON", () => {
    expect(parseRequest(IPC.hubCall, [{ tool: "x", input: { when: new Date() } }]).ok).toBe(false);
    expect(parseRequest(IPC.hubCall, [{ tool: "x", input: Number.NaN }]).ok).toBe(false);
  });

  it("caps a call's input in size and depth", () => {
    const call = (input: unknown) => parseRequest(IPC.hubCall, [{ tool: "x", input }]).ok;
    expect(call("y".repeat(MAX_CALL_INPUT_BYTES - 2))).toBe(true);
    expect(call("y".repeat(MAX_CALL_INPUT_BYTES))).toBe(false);
    const nest = (depth: number): unknown => {
      let value: unknown = 1;
      for (let i = 0; i < depth; i++) value = { a: value };
      return value;
    };
    expect(call(nest(MAX_CALL_INPUT_DEPTH))).toBe(true);
    expect(call(nest(MAX_CALL_INPUT_DEPTH + 1))).toBe(false);
    // Far past any recursion limit: refused, not a stack overflow.
    expect(call(nest(200_000))).toBe(false);
  });

  it("refuses unknown fields, extra arguments and out-of-range timeouts", () => {
    expect(parseRequest(IPC.hubCall, [{ tool: "x", input: {}, id: "c1" }]).ok).toBe(false);
    expect(parseRequest(IPC.hubCall, [{ tool: "x", input: {} }, "extra"]).ok).toBe(false);
    expect(parseRequest(IPC.hubCall, [{ tool: "x", input: {}, timeoutMs: 0 }]).ok).toBe(false);
    expect(parseRequest(IPC.hubCall, [{ tool: "x", input: {}, timeoutMs: 1.5 }]).ok).toBe(false);
  });

  it("takes a live scope or null, and nothing else", () => {
    expect(parseRequest(IPC.hubLive, [null]).ok).toBe(true);
    expect(parseRequest(IPC.hubLive, [{ board: true, focus: "ws-1" }]).ok).toBe(true);
    expect(parseRequest(IPC.hubLive, [{ board: "yes" }]).ok).toBe(false);
    expect(parseRequest(IPC.hubLive, [{ board: true, focus: "" }]).ok).toBe(false);
    expect(parseRequest(IPC.hubLive, []).ok).toBe(false);
  });

  it("trims a pasted URL and key, and refuses blank ones", () => {
    expect(parseRequest(IPC.hubConnect, [{ url: " http://hub:4790 ", key: "k\n" }])).toEqual({
      ok: true,
      args: [{ url: "http://hub:4790", key: "k" }],
    });
    expect(parseRequest(IPC.hubConnect, [{ url: "http://hub", key: "   " }]).ok).toBe(false);
  });

  it("copies only text", () => {
    expect(parseRequest(IPC.copy, ["fld_abc"]).ok).toBe(true);
    expect(parseRequest(IPC.copy, [{ text: "x" }]).ok).toBe(false);
    expect(parseRequest(IPC.copy, ["x".repeat(1_000_001)]).ok).toBe(false);
  });

  it("gives argument-less channels no arguments", () => {
    expect(parseRequest(IPC.hubState, []).ok).toBe(true);
    expect(parseRequest(IPC.hubState, [1]).ok).toBe(false);
  });
});
