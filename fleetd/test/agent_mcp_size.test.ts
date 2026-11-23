// fleetd's MCP tools fit what Antigravity shows its model (runner/antigravity_spec.ts TOOL_BUDGET): past it agy hides
// the biggest tools, and a lead on Gemini lost brief, spawn_agent and ten more that way (W844).
import { expect, test } from "bun:test";
import { toolList } from "../src/cli/agent_mcp/tools.ts";
import { FLEETD_TOOL_SHARE, leftOut, overLimits, TOOL_BUDGET, TOOL_MAX, toolBytes } from "../src/node/runner/antigravity_spec.ts";

test("each role's fleetd tools fit their share of Antigravity's budget, each tool small", () => {
  for (const role of ["lead", "worker"] as const) expect({ role, over: overLimits(toolList(role).tools) }).toEqual({ role, over: [] });
  expect(FLEETD_TOOL_SHARE).toBeLessThan(TOOL_BUDGET);
});

test("a tool counts as agy keeps it: name, description and parameters, compact, <, > and & escaped", () => {
  expect(toolBytes({ name: "a", description: "x<y", inputSchema: { type: "object" } })).toBe(
    '{"name":"a","description":"x\\u003cy","parameters":{"type":"object"}}'.length,
  );
  expect(toolBytes({ name: "a" })).toBe('{"name":"a","description":"","parameters":{}}'.length);
});

test("the limits name each tool over and the set's total", () => {
  const big = { name: "big", description: "d".repeat(TOOL_MAX) };
  expect(overLimits([big])).toEqual([`big is ${toolBytes(big)} bytes (at most ${TOOL_MAX})`]);
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, description: "d".repeat(1900) }));
  expect(overLimits(many)).toEqual([`the set is ${many.reduce((s, t) => s + toolBytes(t), 0)} bytes (at most ${FLEETD_TOOL_SHARE})`]);
});

test("a lead's session goes without the biggest of the bot's servers, as few as it takes, so fleetd's tools all fit", () => {
  // The measured case: fleetd's lead tools beside Paper's.
  expect(leftOut(44_000, [{ name: "paper", bytes: 54_675 }, { name: "docs", bytes: 3_000 }])).toEqual(["paper"]);
  expect(leftOut(44_000, [{ name: "a", bytes: 9_000 }, { name: "b", bytes: 8_000 }, { name: "c", bytes: 2_000 }])).toEqual(["a"]);
  expect(leftOut(55_000, [{ name: "a", bytes: 9_000 }, { name: "b", bytes: 9_000 }])).toEqual(["a", "b"]);
  expect(leftOut(44_000, [{ name: "a", bytes: 16_000 }])).toEqual([]);
  expect(leftOut(44_000, [])).toEqual([]);
});
