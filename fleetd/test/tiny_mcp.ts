// A tiny MCP server over streamable HTTP, for the Connections tests and for a by-hand check on a tailnet host:
// `bun test/tiny_mcp.ts <host> <port>` serves it at http://<host>:<port>/mcp. One tool, `echo`, answers with what it
// was given and the server's name; `key` (optional) is the bearer token it asks for.
type Json = Record<string, unknown>;

export function tinyMcp(opts: { hostname?: string; port?: number; name?: string; key?: string } = {}) {
  const name = opts.name ?? "tiny";
  const seen: { method: string; auth: string | null }[] = [];
  const answer = (m: Json): Json | undefined => {
    if (m.id === undefined) return undefined;
    if (m.method === "initialize") {
      return { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } } };
    }
    if (m.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: m.id,
        result: { tools: [{ name: "echo", description: "Says back what it was given.", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } }] },
      };
    }
    if (m.method === "tools/call") {
      const text = String(((m.params as Json | undefined)?.arguments as Json | undefined)?.text ?? "");
      return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${name} heard: ${text}` }] } };
    }
    return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no method ${String(m.method)}` } };
  };
  const server = Bun.serve({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/mcp") return new Response("not here", { status: 404 });
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      if (req.method !== "POST") return new Response("POST only", { status: 405 });
      const auth = req.headers.get("authorization");
      if (opts.key !== undefined && auth !== `Bearer ${opts.key}`) return new Response("who are you", { status: 401 });
      const m = (await req.json()) as Json;
      seen.push({ method: String(m.method), auth });
      const out = answer(m);
      if (!out) return new Response(null, { status: 202 });
      return Response.json(out, { headers: { "mcp-session-id": "s1" } });
    },
  });
  return { server, seen, url: `http://${opts.hostname ?? "127.0.0.1"}:${server.port}/mcp`, port: server.port ?? 0 };
}

if (import.meta.main) {
  const [host = "127.0.0.1", port = "8765"] = process.argv.slice(2);
  const t = tinyMcp({ hostname: host, port: Number(port), name: "tiny-tailnet" });
  console.log(`tiny MCP at ${t.url}`);
}
