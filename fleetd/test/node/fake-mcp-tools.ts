// A stdio MCP server that lists TOOLS_N tools whose descriptions are each TOOLS_PAD characters long: a server with many
// tools, as agy weighs it (src/node/agy_budget.ts).
const n = Number(process.env.TOOLS_N ?? "1");
const pad = Number(process.env.TOOLS_PAD ?? "10");
const tools = Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: "d".repeat(pad), inputSchema: { type: "object" } }));
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at: number;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (m.id === undefined) continue;
    const result =
      m.method === "initialize"
        ? { protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "many-tools", version: "1" } }
        : m.method === "tools/list"
          ? { tools }
          : {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n`);
  }
});
