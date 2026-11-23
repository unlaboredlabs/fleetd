// An Antigravity lead's start weighs the bot's MCP servers (src/node/agy_budget.ts): fleetd's own aside, each listed,
// one that can't be listed counting nothing, and the biggest left out until fleetd's tools all fit agy's budget.
import { expect, test } from "bun:test";
import { fleetdLeadBytes, overBudget, resolvedOf } from "../../src/node/agy_budget.ts";
import type { Resolved } from "../../src/node/actions/mcp_probe.ts";
import { FLEETD_TOOL_SHARE } from "../../src/node/runner/antigravity_spec.ts";

const tools = (n: number, pad: number) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, description: "d".repeat(pad), inputSchema: {} }));

test("an mcpServers entry reaches the probe as its transport and values", () => {
  expect(resolvedOf("a", { type: "stdio", command: "npx", args: ["x"], env: { K: "v" } })).toEqual({ name: "a", transport: { type: "stdio", command: "npx", args: ["x"] }, values: [["K", "v"]], secrets: [] });
  expect(resolvedOf("b", { type: "http", url: "http://127.0.0.1/mcp", headers: { A: "1" } })).toEqual({ name: "b", transport: { type: "http", url: "http://127.0.0.1/mcp" }, values: [["A", "1"]], secrets: [] });
  expect(resolvedOf("c", {})).toBeUndefined();
});

test("the biggest servers go, fleetd's own is never weighed, and one that can't list counts nothing", async () => {
  const listed: string[] = [];
  const by: Record<string, unknown[]> = { paper: tools(50, 1000), notes: tools(2, 10) };
  const list = async (s: Resolved) => {
    listed.push(s.name);
    if (s.name === "down") throw new Error("no answer");
    return by[s.name] ?? [];
  };
  const entry = { type: "stdio", command: "x" };
  expect(await overBudget({ paper: entry, notes: entry, down: entry, fleetd: entry }, list)).toEqual(["paper"]);
  expect(listed.sort()).toEqual(["down", "notes", "paper"]);
  expect(await overBudget({ notes: entry }, list)).toEqual([]);
  expect(fleetdLeadBytes()).toBeLessThanOrEqual(FLEETD_TOOL_SHARE);
});
