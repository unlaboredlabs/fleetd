// `fleetd mcp-gateway`, as an Antigravity session's agy runs it: two tools of its own whatever the bot's servers hold,
// a search that gives their tools' schemas (and a server's own instructions once), and a call that runs one on its
// server, stdio or HTTP, its answer as the server gave it. A server that can't be reached is said so, its values masked.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

type Json = Record<string, any>;

const fake = join(import.meta.dir, "../node/fake-mcp-tools.ts");
const main = join(import.meta.dir, "../../src/main.ts");

/** A server reached by streamable HTTP that wants its key. */
const notes = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (req.headers.get("authorization") !== "Bearer notes-key") return new Response("", { status: 401 });
    const m = (await req.json()) as Json;
    if (m.id === undefined) return new Response("", { status: 202 });
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: m.id, result }, { headers: { "mcp-session-id": "n-1" } });
    if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1" } });
    if (m.method === "tools/list") return reply({ tools: [{ name: "write_note", description: "Write a note to the notebook", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
    if (m.method === "tools/call") return reply({ content: [{ type: "text", text: `noted: ${m.params.arguments.text}` }], isError: false });
    return reply({});
  },
});

const servers = {
  paper: { type: "stdio", command: process.execPath, args: [fake], env: { TOOLS_N: "50", TOOLS_PAD: "1000", TOOLS_SAY: "Load the guide first.", TOOLS_FAIL: "1" } },
  notes: { type: "http", url: `http://127.0.0.1:${notes.port}/mcp`, headers: { Authorization: "Bearer notes-key" } },
  broken: { type: "stdio", command: "/bin/sh", args: ["-c", 'echo "refused key $KEY" >&2; exit 3'], env: { KEY: "broken-secret" } },
};

let proc: ReturnType<typeof Bun.spawn>;
let nextId = 0;
const waiting = new Map<number, (m: Json) => void>();

beforeAll(async () => {
  proc = Bun.spawn([process.execPath, main, "mcp-gateway"], {
    env: { ...process.env, FLEETD_MCP_GATEWAY: JSON.stringify({ mcpServers: servers }) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  void (async () => {
    let buffer = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk);
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const m = JSON.parse(buffer.slice(0, nl)) as Json;
        buffer = buffer.slice(nl + 1);
        waiting.get(m.id)?.(m);
      }
    }
  })();
  await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agy", version: "1" } });
});
afterAll(() => {
  proc.kill();
  notes.stop(true);
});

function ask(method: string, params: Json): Promise<Json> {
  const id = ++nextId;
  const got = new Promise<Json>((resolve) => waiting.set(id, resolve));
  const stdin = proc.stdin as import("bun").FileSink;
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  stdin.flush();
  return got;
}
const tool = async (name: string, args: Json) => (await ask("tools/call", { name, arguments: args })).result as { content: { text: string }[]; isError: boolean };

test("agy gets the gateway's two tools, which name the bot's servers", async () => {
  const listed = (await ask("tools/list", {})).result.tools as Json[];
  expect(listed.map((t) => t.name)).toEqual(["search", "call"]);
  expect(listed[0]!.description).toContain("paper, notes, broken");
});

test("a search gives the matching tools' schemas, a server's own instructions once, and says which can't be reached", async () => {
  const first = await tool("search", { query: "write a note" });
  expect(first.isError).toBe(false);
  const lines = first.content[0]!.text.split("\n");
  expect(lines).toContain(JSON.stringify({ server: "notes", tool: "write_note", description: "Write a note to the notebook", inputSchema: { type: "object", properties: { text: { type: "string" } } } }));
  const down = lines.find((l) => l.startsWith("broken can't be reached right now"))!;
  expect(down).toContain("exit 3");
  expect(down).toContain("***broken.KEY***");
  expect(first.content[0]!.text).not.toContain("broken-secret");
  const paper = await tool("search", { query: "tool 3", server: "paper" });
  const text = paper.content[0]!.text;
  expect(text.startsWith("paper's own instructions:\nLoad the guide first.")).toBe(true);
  expect(text).toContain(JSON.stringify({ server: "paper", tool: "tool_3", description: "d".repeat(1000), inputSchema: { type: "object" } }));
  // At most SEARCH_MAX schemas, and the rest counted.
  expect(text).toMatch(/\d+ more match: narrow the words or name the server\./);
  expect((await tool("search", { query: "tool 3", server: "paper" })).content[0]!.text).not.toContain("own instructions");
  // An empty query lists every tool's name.
  const all = (await tool("search", { query: "", server: "paper" })).content[0]!.text;
  expect(all.split("\n")[0]).toBe(`paper: ${[...Array.from({ length: 50 }, (_, i) => `tool_${i}`), "tool_fail"].join(", ")}`);
});

test("a call runs the tool on its server, stdio or HTTP, and answers as it did", async () => {
  expect(await tool("call", { server: "paper", tool: "tool_3", arguments: { a: 1 } })).toEqual({ content: [{ type: "text", text: 'tool_3 ran with {"a":1}' } as never], isError: false });
  expect(await tool("call", { server: "notes", tool: "write_note", arguments: { text: "hi" } })).toEqual({ content: [{ type: "text", text: "noted: hi" } as never], isError: false });
});

test("a call that can't run says why, and the server stays for the next one", async () => {
  const failed = await tool("call", { server: "paper", tool: "tool_fail" });
  expect(failed).toMatchObject({ isError: true, content: [{ text: "MCP error -32000: it failed" }] });
  expect((await tool("call", { server: "paper", tool: "nope" })).content[0]!.text).toStartWith("paper has no tool nope. Its tools: tool_0, tool_1");
  expect((await tool("call", { server: "figma", tool: "x" })).content[0]!.text).toBe("No MCP server figma here: this session's are paper, notes, broken. Find a tool with search first.");
  const broken = await tool("call", { server: "broken", tool: "x" });
  expect(broken.isError).toBe(true);
  expect(broken.content[0]!.text).not.toContain("broken-secret");
  expect((await tool("call", { server: "paper", tool: "tool_1" })).isError).toBe(false);
});
