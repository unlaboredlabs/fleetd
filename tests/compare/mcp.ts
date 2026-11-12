// /mcp over plain fetch: initialize, tools/list, tools/call, with a bearer key on every request. The two-team cases
// (twoTeams.ts) call through this rather than the MCP SDK so that fleetd's own tests can run them with nothing
// installed.

export type Schema = Record<string, any>;

export interface Tool {
  readonly name: string;
  readonly inputSchema: Schema;
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

/** A tool's answer: its result, or with `isError` its error (`{ code, message }`). */
export interface Answer {
  readonly isError: boolean;
  readonly body: unknown;
}

export interface Session {
  readonly tools: () => Promise<Array<Tool>>;
  /** Never throws for an answer: a refusal, a protocol error and no answer within `ms` are all error answers. */
  readonly call: (name: string, input: unknown, ms?: number) => Promise<Answer>;
}

export async function openSession(url: string, key: string): Promise<Session> {
  let id = 0;
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const rpc = async (method: string, params: unknown, ms: number): Promise<Record<string, any>> => {
    const mine = method.startsWith("notifications/") ? undefined : ++id;
    const res = await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(mine === undefined ? {} : { id: mine }), method, params }), signal: AbortSignal.timeout(ms) });
    const text = await res.text();
    if (mine === undefined) return {};
    if (!res.ok && !text.startsWith("{")) throw new Error(`${method}: HTTP ${res.status}`);
    // A server may answer as an event stream: the response is the `data:` line that carries this request's id.
    const frames = res.headers.get("content-type")?.includes("text/event-stream")
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)) as Record<string, any>)
      : [JSON.parse(text) as Record<string, any>];
    const frame = frames.find((f) => f.id === mine) ?? frames[0];
    if (frame === undefined) throw new Error(`${method}: no response`);
    if (mine === 1 && res.headers.get("mcp-session-id") !== null) headers["mcp-session-id"] = res.headers.get("mcp-session-id")!;
    return frame;
  };
  const opened = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fleetd-compare", version: "0" } }, 30_000);
  if (opened.error !== undefined) throw new Error(`initialize: ${JSON.stringify(opened.error)}`);
  headers["mcp-protocol-version"] = opened.result.protocolVersion as string;
  await rpc("notifications/initialized", {}, 30_000);
  return {
    tools: async () => {
      const listed = await rpc("tools/list", {}, 30_000);
      if (listed.error !== undefined) throw new Error(`tools/list: ${JSON.stringify(listed.error)}`);
      return listed.result.tools as Array<Tool>;
    },
    call: async (name, input, ms = 30_000) => {
      let frame: Record<string, any>;
      try {
        frame = await rpc("tools/call", { name, arguments: input }, ms);
      } catch (e) {
        return { isError: true, body: { code: "no_answer", message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) } };
      }
      if (frame.error !== undefined) return { isError: true, body: { code: "rpc", message: frame.error.message, rpc: frame.error.code } };
      // Not JSON-RPC at all: the server's own refusal of the request (a revoked key's 401 is `{ code, message }`).
      if (frame.result === undefined) return { isError: true, body: frame };
      const result = frame.result as Record<string, any>;
      const text = (result.content as Array<Record<string, any>> | undefined)?.find((c) => c.type === "text")?.text as string | undefined;
      const body: unknown = result.structuredContent !== undefined ? result.structuredContent : text === undefined ? null : parsed(text);
      return { isError: result.isError === true, body };
    },
  };
}

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
