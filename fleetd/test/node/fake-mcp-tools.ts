// A stdio MCP server that lists TOOLS_N tools whose descriptions are each TOOLS_PAD characters long: a server with many
// tools, as Antigravity's sessions reach through fleetd's MCP gateway (src/cli/mcp_gateway.ts). Its instructions are
// TOOLS_SAY when set; a call of one of its tools answers with the tool's name and its arguments. With TOOLS_FAIL set,
// it lists `tool_fail` too, whose call answers a JSON-RPC error.
const n = Number(process.env.TOOLS_N ?? "1");
const pad = Number(process.env.TOOLS_PAD ?? "10");
const tools = Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: "d".repeat(pad), inputSchema: { type: "object" } }));
if (process.env.TOOLS_FAIL) tools.push({ name: "tool_fail", description: "fails", inputSchema: { type: "object" } });
let buffer = "";
const answer = (m: { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } }): Record<string, unknown> => {
  switch (m.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: m.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "many-tools", version: "1" },
          ...(process.env.TOOLS_SAY ? { instructions: process.env.TOOLS_SAY } : {}),
        },
      };
    case "tools/list":
      return { result: { tools } };
    case "tools/call":
      if (m.params?.name === "tool_fail") return { error: { code: -32000, message: "it failed" } };
      return { result: { content: [{ type: "text", text: `${m.params?.name} ran with ${JSON.stringify(m.params?.arguments ?? {})}` }], isError: false } };
    default:
      return { result: {} };
  }
};
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at: number;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line) as { id?: number; method: string };
    if (m.id === undefined) continue;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, ...answer(m) })}\n`);
  }
});
