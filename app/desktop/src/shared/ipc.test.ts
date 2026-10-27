import { describe, expect, it } from "vitest";
import { IPC } from "./channels";
import { MAX_CALL_INPUT_BYTES, MAX_CALL_INPUT_DEPTH, MAX_CALL_INPUT_NODES, parseRequest } from "./ipc";

describe("parseRequest", () => {
  it("accepts a well-formed call and keeps its input", () => {
    const parsed = parseRequest(IPC.hubCall, ["hub", { tool: "fleetd_status", input: { scope: { project: "p1" } }, timeoutMs: 60_000 }]);
    expect(parsed).toEqual({ ok: true, args: ["hub", { tool: "fleetd_status", input: { scope: { project: "p1" } }, timeoutMs: 60_000 }] });
  });

  it("refuses tool names that aren't MCP tool names", () => {
    for (const tool of ["", "Fleetd", "a b", "x".repeat(65), "../x"]) {
      expect(parseRequest(IPC.hubCall, ["hub", { tool, input: {} }]).ok).toBe(false);
    }
  });

  it("refuses inputs that aren't plain JSON", () => {
    expect(parseRequest(IPC.hubCall, ["hub", { tool: "x", input: { when: new Date() } }]).ok).toBe(false);
    expect(parseRequest(IPC.hubCall, ["hub", { tool: "x", input: Number.NaN }]).ok).toBe(false);
  });

  it("caps a call's input in size and depth", () => {
    const call = (input: unknown) => parseRequest(IPC.hubCall, ["hub", { tool: "x", input }]).ok;
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

  it("refuses shared and cyclic references at once, so a few hundred bytes can't expand exponentially", () => {
    const call = (input: unknown) => parseRequest(IPC.hubCall, ["hub", { tool: "x", input }]).ok;
    // The reviewer's input: x = [x, x], 60 times over.
    let x: unknown = [];
    for (let i = 0; i < 60; i++) x = [x, x];
    // A deeply shared DAG of objects.
    let dag: Record<string, unknown> = { leaf: "y".repeat(100) };
    for (let i = 0; i < 60; i++) dag = { a: dag, b: dag, c: [dag] };
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const started = performance.now();
    for (const input of [x, dag, cyclic, { left: dag, right: dag }]) expect(call(input)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    // Equal but distinct objects are fine.
    expect(call({ left: { a: 1 }, right: { a: 1 } })).toBe(true);
  });

  it("caps the number of values, a single huge array included", () => {
    const call = (input: unknown) => parseRequest(IPC.hubCall, ["hub", { tool: "x", input }]).ok;
    expect(call(new Array<number>(MAX_CALL_INPUT_NODES - 1).fill(0))).toBe(true);
    expect(call(new Array<number>(MAX_CALL_INPUT_NODES).fill(0))).toBe(false);
    expect(call(new Array<number>(5_000_000).fill(0))).toBe(false);
  });

  it("counts the encoded size exactly as JSON.stringify would", () => {
    const call = (input: unknown) => parseRequest(IPC.hubCall, ["hub", { tool: "x", input }]).ok;
    // A string literal is its quotes plus its UTF-8 bytes: "é" is 2 bytes.
    const fits = "é".repeat((MAX_CALL_INPUT_BYTES - 2) / 2);
    expect(new TextEncoder().encode(JSON.stringify(fits)).length).toBe(MAX_CALL_INPUT_BYTES);
    expect(call(fits)).toBe(true);
    expect(call(`${fits}x`)).toBe(false);
    const object = { k: "v".repeat(MAX_CALL_INPUT_BYTES - 9), n: [true] };
    expect(JSON.stringify(object).length).toBeGreaterThan(MAX_CALL_INPUT_BYTES);
    expect(call(object)).toBe(false);
  });

  it("refuses unknown fields, extra arguments and out-of-range timeouts", () => {
    expect(parseRequest(IPC.hubCall, ["hub", { tool: "x", input: {}, id: "c1" }]).ok).toBe(false);
    expect(parseRequest(IPC.hubCall, ["hub", { tool: "x", input: {} }, "extra"]).ok).toBe(false);
    expect(parseRequest(IPC.hubCall, ["hub", { tool: "x", input: {}, timeoutMs: 0 }]).ok).toBe(false);
    expect(parseRequest(IPC.hubCall, ["hub", { tool: "x", input: {}, timeoutMs: 1.5 }]).ok).toBe(false);
  });

  it("takes an order to focus or null, and nothing else", () => {
    expect(parseRequest(IPC.hubFocus, ["hub", null]).ok).toBe(true);
    expect(parseRequest(IPC.hubFocus, ["hub", "ws-1"]).ok).toBe(true);
    expect(parseRequest(IPC.hubFocus, ["hub", ""]).ok).toBe(false);
    expect(parseRequest(IPC.hubFocus, ["hub", { board: true }]).ok).toBe(false);
    expect(parseRequest(IPC.hubFocus, ["hub"]).ok).toBe(false);
    expect(parseRequest(IPC.hubFocus, ["Not a hub", null]).ok).toBe(false);
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
    expect(parseRequest(IPC.hubsList, []).ok).toBe(true);
    expect(parseRequest(IPC.hubsList, [1]).ok).toBe(false);
  });

  it("names the hub first on every hub channel", () => {
    expect(parseRequest(IPC.hubResync, ["hub"]).ok).toBe(true);
    expect(parseRequest(IPC.hubResync, ["a1b2c3d4"]).ok).toBe(true);
    expect(parseRequest(IPC.hubResync, []).ok).toBe(false);
    expect(parseRequest(IPC.hubResync, ["../hub"]).ok).toBe(false);
    expect(parseRequest(IPC.hubForget, ["hub"]).ok).toBe(true);
    // This computer joins the hub Add machine is on, never one picked behind its back.
    expect(parseRequest(IPC.machinesJoinHere, ["a1b2c3d4", "laptop"]).ok).toBe(true);
    expect(parseRequest(IPC.machinesJoinHere, ["laptop"]).ok).toBe(false);
    // And each hub keeps its own join's state.
    expect(parseRequest(IPC.machinesJoinHereState, ["a1b2c3d4"]).ok).toBe(true);
    expect(parseRequest(IPC.machinesJoinHereState, []).ok).toBe(false);
  });

  it("pairs into a hub already listed or a new one under a free-form label", () => {
    expect(parseRequest(IPC.hubConnect, [{ url: "http://hub", key: "k", target: { hub: "a1b2" } }]).ok).toBe(true);
    expect(parseRequest(IPC.hubConnect, [{ url: "http://hub", key: "k", target: { label: "Side project", color: "violet" } }]).ok).toBe(true);
    expect(parseRequest(IPC.hubConnect, [{ url: "http://hub", key: "k", target: { label: "Acme", color: "chartreuse" } }]).ok).toBe(false);
    expect(parseRequest(IPC.hubsUpdate, ["hub", { label: "Personal", color: null }]).ok).toBe(true);
    expect(parseRequest(IPC.hubsUpdate, ["hub", { label: "", color: null }]).ok).toBe(false);
  });

  it("reads a drop only at an absolute path, and the folder picker takes nothing", () => {
    expect(parseRequest(IPC.projectsReadDrop, ["/home/dev/src/storefront"]).ok).toBe(true);
    expect(parseRequest(IPC.projectsReadDrop, ["C:\\src\\storefront"]).ok).toBe(true);
    for (const path of ["", "relative/path", "~/src", 42]) expect(parseRequest(IPC.projectsReadDrop, [path]).ok).toBe(false);
    expect(parseRequest(IPC.projectsPickFolder, []).ok).toBe(true);
    expect(parseRequest(IPC.projectsPickFolder, ["/etc"]).ok).toBe(false);
  });
});
