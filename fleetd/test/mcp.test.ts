import { afterAll, expect, test } from "bun:test";
import { serve, stop } from "../src/hub/http/index.ts";
import { clip, INSTRUCTIONS, sortedJson } from "../src/hub/mcp/endpoint.ts";
import { DESCRIPTIONS } from "../src/hub/mcp/descriptions.ts";
import { build } from "../src/hub/serve/index.ts";
import { NotImplemented, ToolError } from "../src/shared/errors.ts";
import { hubHome, insertKey } from "./helpers.ts";

const home = hubHome();
const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
tools.add("hub_info", () => ({ version: "9.9.9" }) as never);
tools.add("people_list", () => {
  throw new ToolError("not_found", "nobody here", "invite someone");
});
// A tool not ported yet, as its registry stub answers: its own, so porting a real one never breaks this test.
tools.add("metrics_get", () => {
  throw new NotImplemented("src/hub/metrics (tool metrics_get)");
});
const server = serve(hub, tools, 0);
const url = `http://127.0.0.1:${server.port}/mcp`;
afterAll(async () => {
  await stop(server);
  hub.db.close();
  home.done();
});

const reader = insertKey(hub.db, [{ role: "read", machines: "*" }], "reader");
const JSON_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const post = (key: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, ...JSON_HEADERS, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function connect(key: string, protocolVersion = "2025-06-18") {
  const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  const reply = await post(key, init);
  expect(reply.status).toBe(200);
  const session = reply.headers.get("mcp-session-id") ?? "";
  const body = (await reply.json()) as { result: Record<string, unknown> };
  const rpc = async (method: string, params: unknown = {}, headers: Record<string, string> = {}) => {
    const res = await post(key, { jsonrpc: "2.0", id: 1, method, params }, { "mcp-session-id": session, ...headers });
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as Record<string, any> };
  };
  const call = async (name: string, args: unknown) => {
    const { body } = await rpc("tools/call", { name, arguments: args });
    const result = body.result;
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    return { isError: result.isError as boolean, value: result.structuredContent };
  };
  return { session, init: body.result, headers: reply.headers, rpc, call };
}

test("initialize opens a session, negotiates the protocol and tells the session to claim its work", async () => {
  const mcp = await connect(reader);
  expect(mcp.session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(mcp.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  expect(mcp.init).toEqual({
    protocolVersion: "2025-06-18",
    capabilities: { logging: {}, tools: { listChanged: true }, completions: {} },
    serverInfo: { name: "fleetd", version: "0.0.0" },
    instructions: INSTRUCTIONS,
  });
  for (const word of ["work_claim", "work_done", "taken or possible_duplicate"]) expect(INSTRUCTIONS).toContain(word);
  // One it doesn't speak gets the newest.
  expect((await connect(reader, "1999-01-01")).init.protocolVersion).toBe("2025-11-25");
  const again = await post(reader, { jsonrpc: "2.0", id: 3, method: "initialize" }, { "mcp-session-id": mcp.session });
  expect(again.status).toBe(400);
  expect(await again.json()).toEqual({
    jsonrpc: "2.0",
    id: 3,
    error: { code: -32600, message: "initialize must not include an MCP-Session-Id header", _tag: "InvalidRequest" },
  });
});

test("the transport's refusals: method, media type, accept, parse errors, batches, sessions, protocol", async () => {
  const get = await fetch(url, { headers: { authorization: `Bearer ${reader}` } });
  expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"]);
  expect((await post(reader, "{}", { "content-type": "text/plain" })).status).toBe(415);
  expect((await post(reader, "{}", { "content-type": "Application/JSON; charset=utf-8", accept: "*/*" })).status).toBe(400);
  expect((await post(reader, "{}", { accept: "application/json" })).status).toBe(406);
  const parse = await post(reader, "{nope");
  expect([parse.status, await parse.json()]).toEqual([200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error", _tag: "ParseError" } }]);
  expect((await post(reader, [{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400);
  const noSession = await post(reader, { jsonrpc: "2.0", id: 2, method: "ping" });
  expect([noSession.status, ((await noSession.json()) as any).error.message]).toEqual([
    400,
    "MCP-Session-Id header is required; send initialize to start a session",
  ]);
  expect((await post(reader, { jsonrpc: "2.0", id: 2, method: "ping" }, { "mcp-session-id": "gone" })).status).toBe(404);

  const mcp = await connect(reader);
  const unsupported = await mcp.rpc("ping", {}, { "mcp-protocol-version": "2020-01-01" });
  expect([unsupported.status, unsupported.body.error]).toEqual([
    400,
    { code: -32022, message: "Unsupported protocol version '2020-01-01'", data: { supported: ["2025-11-25", "2025-06-18", "2025-03-26"], requested: "2020-01-01" } },
  ]);
  const mismatch = await mcp.rpc("ping", {}, { "mcp-protocol-version": "2025-03-26" });
  expect([mismatch.status, mismatch.body.error]).toEqual([
    400,
    { code: -32020, message: "MCP-Protocol-Version header '2025-03-26' does not match negotiated protocol version '2025-06-18'" },
  ]);
  const note = await post(reader, { jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": mcp.session });
  expect([note.status, note.headers.get("mcp-protocol-version"), await note.text()]).toEqual([202, "2025-06-18", ""]);
});

test("the methods it answers, and the ones it doesn't", async () => {
  const mcp = await connect(reader);
  const ok = await mcp.rpc("ping", {}, { "mcp-protocol-version": "2025-06-18" });
  expect([ok.status, ok.headers.get("mcp-protocol-version"), ok.body]).toEqual([200, "2025-06-18", { jsonrpc: "2.0", id: 1, result: {} }]);
  expect((await mcp.rpc("logging/setLevel", { level: "info" })).body.result).toEqual({});
  expect((await mcp.rpc("resources/list")).body.result).toEqual({ resources: [] });
  expect((await mcp.rpc("resources/templates/list")).body.result).toEqual({ resourceTemplates: [] });
  expect((await mcp.rpc("prompts/list")).body.result).toEqual({ prompts: [] });
  expect((await mcp.rpc("completion/complete")).body.error).toEqual({ code: -32602, message: "Invalid method parameters", _tag: "InvalidParams" });
  expect((await mcp.rpc("tools/call", {})).body.error).toEqual({ code: -32602, message: "Invalid method parameters", _tag: "InvalidParams" });
  expect((await mcp.rpc("nope/nothing")).body.error).toEqual({ code: -32601, message: "Method not found: nope/nothing", _tag: "MethodNotFound" });
  expect((await mcp.rpc("tools/call", { name: "no_such_tool" })).body.error).toEqual({ code: -32602, message: "Tool 'no_such_tool' not found" });
});

test("tools/list: every registered tool with its description, object input schema, its $defs and hints", async () => {
  const mcp = await connect(reader);
  const res = await mcp.rpc("tools/list");
  const listed = res.body.result.tools as Record<string, any>[];
  const names = listed.map((t) => t.name as string);
  expect(new Set(names)).toEqual(new Set(tools.names()));
  // The described tools first, in the table's order.
  const described = DESCRIPTIONS.map(([n]) => n).filter((n) => tools.has(n));
  expect(names.slice(0, described.length)).toEqual(described);
  const tool = (name: string) => listed.find((t) => t.name === name)!;
  expect(tool("work_list").annotations).toEqual({ readOnlyHint: true, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  expect(tool("work_claim").annotations.readOnlyHint).toBe(false);
  expect(tool("work_claim").description).toStartWith("Call before you start a code change");
  expect(tool("work_claim").inputSchema.required).toEqual(["title"]);
  expect(tool("work_done").inputSchema.properties.outcome).toBeObject();
  for (const t of listed) {
    expect(t.inputSchema.type).toBe("object");
    // Every reference resolves inside the tool's own $defs.
    const refs = [...JSON.stringify(t.inputSchema).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)].map((m) => m[1]!);
    for (const ref of refs) expect(t.inputSchema.$defs?.[ref]).toBeDefined();
  }
  // Keys go out sorted, as serde_json writes them; the cached list keeps the envelope's order.
  const raw = await (await post(reader, { jsonrpc: "2.0", id: 9, method: "tools/list" }, { "mcp-session-id": mcp.session })).text();
  expect(raw.startsWith('{"id":9,"jsonrpc":"2.0","result":{"tools":[{"annotations":')).toBe(true);
});

test("tools/call: output, a tool's refusal, the role check and a tool not ported yet, as text and structured", async () => {
  const mcp = await connect(reader);
  expect(await mcp.call("hub_info", {})).toEqual({ isError: false, value: { version: "9.9.9" } });
  expect(await mcp.call("people_list", {})).toEqual({ isError: true, value: { code: "not_found", message: "nobody here", fix: "invite someone" } });
  const refused = await mcp.call("project_add", { machineId: "lab-a", path: "/w" });
  expect(refused.isError).toBe(true);
  expect(refused.value.code).toBe("forbidden");
  const stub = await mcp.call("metrics_get", { since: "2026-11-01T00:00:00.000Z", tz: "UTC" });
  expect([stub.isError, stub.value.code]).toEqual([true, "failed"]);
  expect(stub.value.message).toContain("src/hub/metrics");
  // A revoked key stops on its next request, session or not.
  hub.db.conn.run("UPDATE agent_keys SET revoked_ms = 1 WHERE name = 'reader'");
  const revoked = await post(reader, { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-session-id": mcp.session });
  expect([revoked.status, ((await revoked.json()) as any).code]).toEqual([401, "forbidden"]);
});

test("helpers: sorted JSON and UTF-16 clipping", () => {
  expect(sortedJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  expect(clip("abc", 5)).toBe("abc");
  expect(clip("abcdef", 3)).toBe("abc");
  expect(clip("ab😀", 3)).toBe("ab");
  expect(clip("ab😀c", 4)).toBe("ab😀");
});
