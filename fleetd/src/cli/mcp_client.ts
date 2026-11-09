// The little of an MCP Streamable HTTP client the CLI needs: initialize once,
// then call tools. Answers may come as JSON or as an SSE stream; both are read to the matching response.
import { VERSION } from "../shared/version.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** HTTP 401 is `unauthorized`: the hub refused the key. */
export class McpError extends Error {
  constructor(
    message: string,
    readonly unauthorized = false,
  ) {
    super(message);
  }
  static unauthorized() {
    return new McpError("the hub refused the key (401)", true);
  }
}

/** A tool's answer: its first text content as JSON, and whether it is an error result. */
export type ToolResult = { isError: boolean; body: any };

/** `new URL("mcp", hub + "/")`. */
export const endpoint = (hub: string) => (hub.endsWith("/") ? `${hub}mcp` : `${hub}/mcp`);

/** Pages of `tools/list` read at most. */
const TOOL_PAGES = 20;

export class McpClient {
  private session: string | undefined;
  /** The server's `serverInfo`: `name version`. */
  server: string | undefined;
  private protocol = MCP_PROTOCOL_VERSION;
  private nextId = 0;

  private constructor(
    private readonly url: string,
    private readonly key: string | undefined,
    private readonly headers: [string, string][],
    private readonly userAgent: string,
  ) {}

  static connect(hub: string, key: string, name: string, timeoutMs: number): Promise<McpClient> {
    return McpClient.connectTo(endpoint(hub), key, [], name, timeoutMs);
  }

  /** Any streamable HTTP server at `url`, `headers` on every request. */
  static async connectTo(
    url: string,
    key: string | undefined,
    headers: [string, string][],
    name: string,
    timeoutMs: number,
  ): Promise<McpClient> {
    const client = new McpClient(url, key, headers, `${name}/${VERSION}`);
    const init = await client.request(
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name, version: VERSION } },
      timeoutMs,
    );
    if (typeof init?.protocolVersion === "string") client.protocol = init.protocolVersion;
    client.server = serverInfo(init);
    await client.post({ jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs);
    return client;
  }

  async callTool(name: string, args: unknown, timeoutMs: number): Promise<ToolResult> {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") throw new McpError(`${name} answered without text content`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new McpError(`${name} answered with invalid JSON: ${(error as Error).message}`);
    }
    return { isError: result?.isError === true, body };
  }

  /** `tools/list`, every page: each tool's object as the server sent it. */
  async listTools(timeoutMs: number): Promise<any[]> {
    const tools: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < TOOL_PAGES; i++) {
      const page = await this.request("tools/list", cursor === undefined ? {} : { cursor }, timeoutMs);
      if (Array.isArray(page?.tools)) tools.push(...page.tools);
      cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    return tools;
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    if (response === undefined) throw new McpError(`no answer to ${method}`);
    const reply = findResponse(response, id);
    if (reply === undefined) throw new McpError(`no answer to ${method}`);
    return resultOf(reply);
  }

  /** The raw body of the answer, or undefined for 202 Accepted. */
  private async post(message: unknown, timeoutMs: number): Promise<string | undefined> {
    const headers: Record<string, string> = { "user-agent": this.userAgent };
    if (this.key !== undefined) headers.authorization = `Bearer ${this.key}`;
    for (const [name, value] of this.headers) headers[name] = value;
    headers.accept = "application/json, text/event-stream";
    headers["content-type"] = "application/json";
    headers["mcp-protocol-version"] = this.protocol;
    if (this.session !== undefined) headers["mcp-session-id"] = this.session;
    let response: Response;
    try {
      response = await fetchSameOrigin(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new McpError(describe(error));
    }
    if (response.status === 401) throw McpError.unauthorized();
    const session = response.headers.get("mcp-session-id");
    if (session !== null) this.session = session;
    if (response.status === 202) return undefined;
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new McpError(describe(error));
    }
    if (!response.ok) throw new McpError(`Error POSTing to endpoint (HTTP ${response.status}): ${body.trim()}`);
    return body;
  }
}

/** Redirects followed only within the first URL's origin, at most 10: a request's headers never go to another. */
export async function fetchSameOrigin(url: string, init: RequestInit): Promise<Response> {
  const origin = new URL(url).origin;
  let at = url;
  for (let hops = 0; ; hops++) {
    const response = await fetch(at, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    const next = new URL(location, at);
    if (next.origin !== origin || hops >= 9) return response;
    at = next.href;
  }
}

/** A JSON-RPC response's result, or its error as text. */
export function resultOf(reply: any): any {
  if (reply?.error !== undefined) {
    const code = reply.error?.code === undefined ? "" : JSON.stringify(reply.error.code);
    throw new McpError(`MCP error ${code}: ${typeof reply.error?.message === "string" ? reply.error.message : ""}`);
  }
  return reply?.result ?? null;
}

/** `name version` from an initialize result's `serverInfo`. */
export function serverInfo(init: any): string | undefined {
  const info = init?.serverInfo;
  if (typeof info?.name !== "string") return undefined;
  return typeof info.version === "string" ? `${info.name} ${info.version}` : info.name;
}

/** A fetch failure's text, its causes after it. */
export function describe(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "operation timed out";
  let text = error instanceof Error ? error.message : String(error);
  let cause = error instanceof Error ? error.cause : undefined;
  while (cause instanceof Error) {
    text = `${text}: ${cause.message}`;
    cause = cause.cause;
  }
  return text;
}

/** The JSON-RPC response with `id`, from a JSON body or the `data:` lines of an SSE body. */
function findResponse(body: string, id: number): any {
  const matches = (v: any) => v !== null && typeof v === "object" && v.id === id;
  try {
    const value = JSON.parse(body);
    return Array.isArray(value) ? value.find(matches) : matches(value) ? value : undefined;
  } catch {}
  let data = "";
  for (const line of [...body.split(/\r?\n/), ""]) {
    if (line.startsWith("data:")) {
      const rest = line.slice(5);
      data += (rest.startsWith(" ") ? rest.slice(1) : rest) + "\n";
    } else if (line === "" && data !== "") {
      try {
        const value = JSON.parse(data);
        if (matches(value)) return value;
      } catch {}
      data = "";
    }
  }
  return undefined;
}
