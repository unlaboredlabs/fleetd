// The MCP endpoint at /mcp: Streamable HTTP with JSON responses only (POST; no
// GET stream, no DELETE), a static tool list, and the caller's bearer checked on every request, with the wire
// behaviour older hubs had (Effect's `McpServer.layerHttp`): sessions from `initialize`, protocol negotiation, 202 for
// notifications, and the same JSON-RPC errors. Bodies go out with their keys sorted, as serde_json writes them.
import schemaText from "../../../../app/desktop/src/shared/contracts/schema/McpTools.json" with { type: "text" };
import { TOOLS, type ToolName } from "../api/tool_roles.ts";
import { ToolError } from "../../shared/errors.ts";
import { VERSION } from "../../shared/version.ts";
import type { Hub } from "../api/hub.ts";
import type { CallError, Caller, Registry } from "../api/registry.ts";
import { DESCRIPTIONS } from "./descriptions.ts";

/** Newest first; the first is answered to a client asking for one the hub doesn't speak. */
export const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const SESSION_HEADER = "mcp-session-id";
const PROTOCOL_HEADER = "mcp-protocol-version";

/**
 * `initialize`'s `instructions`: Claude Code puts them in the session's system prompt, so a person's own sessions
 * check the work ledger before they build something an agent or another session already is.
 */
export const INSTRUCTIONS =
  "fleetd runs agents on this person's repositories and keeps a ledger of the work in flight on each one. Before you " +
  "start a code change in a git repository, call work_claim with a one-line title of the change, the repo's origin " +
  "remote (`git remote get-url origin`), its branch, and the paths and issue keys you know. If the answer is taken or " +
  "possible_duplicate, tell the user what holds it before going on. If it is yours, you are fleetd's own agent on its " +
  "task's branch: the task already holds the work, so go on. Call work_done when the change lands or you drop it. " +
  "work_list shows what is in flight on a repo.";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** JSON with every object's keys sorted, as serde_json (no preserve_order) writes a Value. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

/**
 * A tool's input schema for tools/list. MCP requires an object root, so a non-object input becomes the empty object
 * schema, and the definitions it references (transitively) go to `$defs`.
 */
export function inputSchema(doc: JsonObject, name: string): JsonObject {
  const defs = (doc.$defs ?? {}) as JsonObject;
  const tools = (defs.McpTools as JsonObject | undefined)?.properties as JsonObject | undefined;
  let input = (tools?.[`${name}.input`] ?? null) as Json;
  // schemars names input structs where Effect inlines them: look through a bare root `$ref`.
  for (;;) {
    const ref = isObject(input) && typeof input.$ref === "string" ? input.$ref : undefined;
    if (!ref?.startsWith("#/$defs/")) break;
    input = (defs[ref.slice("#/$defs/".length)] ?? null) as Json;
  }
  const root: JsonObject =
    isObject(input) && input.type === "object" ? structuredClone(input) : { type: "object", properties: {} };
  const used = new Map<string, Json>();
  const pending: string[] = [];
  collectRefs(root, pending);
  for (let def = pending.pop(); def !== undefined; def = pending.pop()) {
    if (used.has(def)) continue;
    const schema = structuredClone(defs[def] ?? null);
    collectRefs(schema, pending);
    used.set(def, schema);
  }
  if (used.size > 0) root.$defs = Object.fromEntries([...used].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return root;
}

const isObject = (v: Json | undefined): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v);

function collectRefs(schema: Json, out: string[]): void {
  if (Array.isArray(schema)) {
    for (const item of schema) collectRefs(item, out);
  } else if (isObject(schema)) {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$ref" && typeof value === "string") {
        if (value.startsWith("#/$defs/")) out.push(value.slice("#/$defs/".length));
      } else {
        collectRefs(value, out);
      }
    }
  }
}

/** The tools/list result, built from the registry: the described tools in the table's order, then the rest sorted. */
export function toolsList(tools: Registry): { tools: JsonObject[] } {
  const doc = JSON.parse(schemaText) as JsonObject;
  const described = new Map(DESCRIPTIONS);
  const names: string[] = DESCRIPTIONS.map(([n]) => n).filter((n) => tools.has(n));
  const rest = tools
    .names()
    .filter((n) => !names.includes(n))
    .sort();
  names.push(...rest);
  return {
    tools: names.map((name) => ({
      name,
      description: described.get(name) ?? "",
      inputSchema: inputSchema(doc, name),
      // Effect's MCP server fills in the hints it isn't given with these values.
      annotations: {
        readOnlyHint: TOOLS[name as ToolName]?.scope === "read",
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    })),
  };
}

/** UTF-16 units, as the Rust hub's `clip` counts them, never splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** The `invalid` result for input that failed to decode; `fix` differs between /mcp and /app. */
export const invalidInput = (tool: string, detail: string, fix: string) =>
  new ToolError("invalid", clip(`Invalid ${tool} input: ${detail}`, 1000), fix);

const rpcError = (id: Json, code: number, message: string, tag?: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(tag === undefined ? {} : { _tag: tag }) },
});

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(sortedJson(body), { status, headers: { "content-type": "application/json", ...headers } });

const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

/** Some clients show only the text and others only structuredContent, so both carry the result (or the error). */
function callResult(name: string, outcome: { output: unknown } | { error: CallError }): JsonObject {
  let value: unknown;
  let isError = false;
  if ("output" in outcome) {
    value = outcome.output ?? null;
  } else {
    isError = true;
    const error = outcome.error;
    value =
      error.kind === "tool"
        ? error.error.toJSON()
        : invalidInput(name, error.kind === "invalid" ? error.message : "", "Check the arguments against the tool's input schema.").toJSON();
  }
  return {
    content: [{ type: "text", text: sortedJson(value) }],
    structuredContent: value as Json,
    isError,
  };
}

/** The tools/list result and the sessions `initialize` opened, for the hub's life (there is no DELETE). */
export class McpEndpoint {
  private list: { tools: JsonObject[] } | undefined;
  /** The list as sent, serialized once: it is the largest answer /mcp gives. */
  private listJson: string | undefined;
  /** Session id → negotiated protocol. */
  private readonly sessions = new Map<string, string>();

  constructor(private readonly tools: Registry) {}

  /** Built on first use, once every module has registered its tools. */
  toolsList(): { tools: JsonObject[] } {
    this.list ??= toolsList(this.tools);
    return this.list;
  }

  /** One request to /mcp from an already verified caller. */
  async handle(hub: Hub, caller: Caller, req: Request): Promise<Response> {
    if (req.method !== "POST") return empty(405, { allow: "POST" });
    const type = req.headers.get("content-type");
    if (!type || type.split(";")[0]?.trim().toLowerCase() !== "application/json") return empty(415);
    const accept = req.headers.get("accept") ?? "";
    if (!(accept.includes("*/*") || (accept.includes("application/json") && accept.includes("text/event-stream")))) {
      return empty(406);
    }
    let message: unknown;
    try {
      message = JSON.parse(await req.text());
    } catch {
      return jsonResponse(200, rpcError(null, -32700, "Parse error", "ParseError"));
    }
    // Batches were removed from the protocol; Effect answers them with a bare 400.
    if (message === null || typeof message !== "object" || Array.isArray(message)) return empty(400);
    const rpc = message as JsonObject;
    const id = "id" in rpc ? (rpc.id ?? null) : undefined;
    const method = typeof rpc.method === "string" ? rpc.method : "";
    const sessionId = req.headers.get(SESSION_HEADER);

    if (method === "initialize") {
      if (sessionId !== null) {
        return jsonResponse(
          400,
          rpcError(id ?? null, -32600, "initialize must not include an MCP-Session-Id header", "InvalidRequest"),
        );
      }
      const params = rpc.params;
      const requested = isObject(params ?? null) ? (params as JsonObject).protocolVersion : undefined;
      const protocol = PROTOCOLS.find((p) => p === requested) ?? PROTOCOLS[0];
      const session = crypto.randomUUID();
      this.sessions.set(session, protocol);
      const result = {
        protocolVersion: protocol,
        capabilities: { logging: {}, tools: { listChanged: true }, completions: {} },
        serverInfo: { name: "fleetd", version: VERSION },
        instructions: INSTRUCTIONS,
      };
      return jsonResponse(
        200,
        { jsonrpc: "2.0", id: id ?? null, result },
        { [PROTOCOL_HEADER]: protocol, [SESSION_HEADER]: session },
      );
    }

    if (sessionId === null) {
      return jsonResponse(
        400,
        rpcError(id ?? null, -32600, "MCP-Session-Id header is required; send initialize to start a session", "InvalidRequest"),
      );
    }
    const protocol = this.sessions.get(sessionId);
    if (protocol === undefined) return empty(404);
    const asked = req.headers.get(PROTOCOL_HEADER);
    if (asked !== null) {
      if (!(PROTOCOLS as readonly string[]).includes(asked)) {
        return jsonResponse(400, {
          jsonrpc: "2.0",
          id: id ?? null,
          error: {
            code: -32022,
            message: `Unsupported protocol version '${asked}'`,
            data: { supported: PROTOCOLS, requested: asked },
          },
        });
      }
      if (asked !== protocol) {
        const text = `MCP-Protocol-Version header '${asked}' does not match negotiated protocol version '${protocol}'`;
        return jsonResponse(400, rpcError(id ?? null, -32020, text));
      }
    }
    // A notification (notifications/initialized, cancelled, …) or a client response: nothing to answer.
    if (id === undefined) return empty(202, { [PROTOCOL_HEADER]: protocol });
    const params = rpc.params ?? null;
    let body: unknown;
    switch (method) {
      case "ping":
      case "logging/setLevel":
        body = { jsonrpc: "2.0", id, result: {} };
        break;
      case "tools/list":
        this.listJson ??= sortedJson(this.toolsList());
        // `id`, `jsonrpc`, `result`: the sorted order, written by hand around the list serialized once.
        return new Response(`{"id":${sortedJson(id)},"jsonrpc":"2.0","result":${this.listJson}}`, {
          status: 200,
          headers: { "content-type": "application/json", [PROTOCOL_HEADER]: protocol },
        });
      case "resources/list":
        body = { jsonrpc: "2.0", id, result: { resources: [] } };
        break;
      case "resources/templates/list":
        body = { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
        break;
      case "prompts/list":
        body = { jsonrpc: "2.0", id, result: { prompts: [] } };
        break;
      case "tools/call": {
        const name = isObject(params) && typeof params.name === "string" ? params.name : undefined;
        if (name === undefined) {
          body = rpcError(id, -32602, "Invalid method parameters", "InvalidParams");
          break;
        }
        const input = isObject(params) ? (params.arguments ?? null) : null;
        const outcome = await this.tools.call(hub, caller, name, input);
        body =
          "error" in outcome && outcome.error.kind === "unknown"
            ? rpcError(id, -32602, `Tool '${name}' not found`)
            : { jsonrpc: "2.0", id, result: callResult(name, outcome) };
        break;
      }
      case "completion/complete":
        body = rpcError(id, -32602, "Invalid method parameters", "InvalidParams");
        break;
      default:
        body = rpcError(id, -32601, `Method not found: ${method}`, "MethodNotFound");
    }
    return jsonResponse(200, body, { [PROTOCOL_HEADER]: protocol });
  }
}
