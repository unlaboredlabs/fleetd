// The MCP endpoint at /mcp: Streamable HTTP with JSON responses only (POST; no
// GET stream, no DELETE), a static tool list, and the caller's bearer checked on every request, with the wire
// behaviour older hubs had (Effect's `McpServer.layerHttp`): sessions from `initialize`, protocol negotiation, 202 for
// notifications, and the same JSON-RPC errors. Bodies go out with their keys sorted, as serde_json writes them.
import schemaText from "../../../../app/desktop/src/shared/contracts/schema/McpTools.json" with { type: "text" };
import { TOOLS, type ToolName } from "../api/tool_roles.ts";
import { VERSION } from "../../shared/version.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { DESCRIPTIONS } from "./descriptions.ts";
import {
  callResult,
  empty,
  INSTRUCTIONS,
  inputSchema,
  isObject,
  type JsonObject,
  jsonResponse,
  PROTOCOL_HEADER,
  PROTOCOLS,
  rpcError,
  SESSION_HEADER,
  sortedJson,
} from "./rpc.ts";

export { clip, INSTRUCTIONS, inputSchema, invalidInput, PROTOCOLS, sortedJson } from "./rpc.ts";

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
