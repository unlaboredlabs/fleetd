// Test connection (`mcp_test`): the node starts or reaches an MCP server as an
// agent's claude would, initializes it and lists its tools, within TIMEOUT_MS. A stdio server runs in the given
// directory with the agent's environment plus its own env, in a process group of its own that is killed afterwards;
// an HTTP server is called with its headers (MCP's streamable HTTP, cli/mcp_client.rs); an SSE server (MCP's older
// HTTP transport) is read from its event stream. What goes wrong comes back as one line a person can act on, with a
// command's stderr tail, every one of the server's secrets masked, as they are in what a working one lists. The same
// connection (`connect`), kept open, is how fleetd's MCP gateway calls a server's tools (cli/mcp_gateway.ts).
//
// Box side (`fleetd/box/mcp_probe`): the caller hands in the `fetch` and the `spawn` it runs with, so a service with
// no node probes a server as the node does (the node's own are ./mcp_spawn.ts and the global fetch; `fleetd
// mcp-probe` runs it in a box).
import type { McpTestResult, McpToolInfo, McpTransport } from "../../shared/contracts.ts";
import { Masker } from "../mask.ts";

/** A server with its values, as the node resolves it from what it holds (./mcp.ts `resolve`). */
export type Resolved = {
  name: string;
  transport: McpTransport;
  /** Env (stdio) or headers (HTTP, SSE). */
  values: [name: string, value: string][];
  /** Its secrets as `<server>.<NAME>`, for masking. */
  secrets: [name: string, value: string][];
};

/** A `--mcp-config` entry (`mcpServers`' value) as the probe takes it; undefined for one it can't reach. */
export function resolvedOf(name: string, entry: unknown): Resolved | undefined {
  const e = entry as { type?: unknown; command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown };
  const values = (o: unknown) => Object.entries((o ?? {}) as Record<string, unknown>).map(([k, v]): [string, string] => [k, String(v)]);
  if ((e.type === "http" || e.type === "sse") && typeof e.url === "string") return { name, transport: { type: e.type, url: e.url }, values: values(e.headers), secrets: [] };
  if (typeof e.command === "string") {
    const args = Array.isArray(e.args) ? e.args.map(String) : [];
    return { name, transport: { type: "stdio", command: e.command, args }, values: values(e.env), secrets: [] };
  }
  return undefined;
}

/** A started process: its pipes, how it ended, and a kill of it and everything it started. */
export type Child = {
  stdin: { write(text: string): unknown; flush(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  /** The signal that ended it, once one did. */
  readonly signalCode: string | number | null;
  /** Kills its whole process group: a launcher such as `npx` or `uvx` runs the real server as its own child. */
  kill(): void;
};

/** Starts `argv` in `cwd` with exactly `env`; throws (with Node's `code`, ENOENT for a missing command) when it can't. */
export type Spawn = (argv: string[], options: { cwd: string; env: Record<string, string> }) => Child;

/** What the probe asks of `fetch`: the global one fits, and so does `fleetd/box/tailnet_fetch`'s `dialFetch`. */
export type Fetch = (
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect?: "manual" },
) => Promise<Response>;

export type ProbeIo = {
  /** For an HTTP or SSE server. */
  fetch: Fetch;
  /** For a stdio server; without it one isn't started. */
  spawn?: Spawn;
  /** Where a stdio server runs, and the environment its own env adds to. */
  cwd?: string;
  env?: Record<string, string>;
  /** fleetd's version, as the client's in `initialize` and its user agent. */
  version?: string;
};

export const TIMEOUT_MS = 30_000;
export const PROTOCOL_VERSION = "2025-06-18";
const STDERR_TAIL = 2000;
const CLIENT = "fleetd-mcp-test";
const TOOL_PAGES = 20;

type Json = Record<string, unknown>;
type Found = { server?: string; tools: Json[] };
type Client = { fetch: Fetch; version: string; signal: AbortSignal };

export async function probe(server: Resolved, io: ProbeIo): Promise<McpTestResult> {
  // What the server says goes through the mask too: one may echo a key back in its name or a tool's description.
  const mask = new Masker(server.secrets);
  try {
    const found = await listed(server, io, TIMEOUT_MS);
    const tools = found.tools.flatMap(toolInfo).map((t) => ({ ...t, name: mask.text(t.name), ...(t.description !== undefined ? { description: mask.text(t.description) } : {}) }));
    return { ...(found.server ? { server: mask.text(found.server) } : {}), tools };
  } catch (error) {
    return { tools: [], error: mask.text((error as Error).message) };
  }
}

/** A server reached and initialized, kept for requests until it is closed: what the Test lists a server's tools with,
 * and what an Antigravity session's MCP gateway (cli/mcp_gateway.ts) calls the bot's servers through. */
export type Connection = {
  /** `name version` from its serverInfo. */
  server: string | undefined;
  /** What its initialize says of how to use its tools. */
  instructions: string | undefined;
  /** One request's result, one request at a time. Throws an RpcError for the server's own error, which leaves it
   * open; any other error, why it can't answer, closes it. */
  request(method: string, params: Json): Promise<Json>;
  /** `error` in the server's words, and the server closed: a stdio server's exit code and stderr tail. */
  explain(error: Error): Promise<Error>;
  /** Ends it: a stdio server's process group is killed. */
  close(): void;
};

/** The server's own JSON-RPC error. */
export class RpcError extends Error {}

/** The server's tools whole, every page of its tools/list. */
export async function toolsOf(conn: Connection): Promise<Json[]> {
  const tools: Json[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < TOOL_PAGES; page++) {
    const listed = await conn.request("tools/list", cursor ? { cursor } : {});
    if (Array.isArray(listed.tools)) tools.push(...(listed.tools as Json[]));
    cursor = typeof listed.nextCursor === "string" ? listed.nextCursor : undefined;
    if (cursor === undefined) break;
  }
  return tools;
}

async function listed(server: Resolved, io: ProbeIo, ms: number): Promise<Found> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`no answer within ${ms / 1000} s: the server didn't finish starting or listing its tools`));
    }, ms);
  });
  let conn: Connection | undefined;
  const run = (async () => {
    conn = await connect(server, io, abort.signal);
    try {
      return { server: conn.server, tools: await toolsOf(conn) };
    } catch (error) {
      throw error instanceof RpcError ? await conn.explain(error) : error;
    }
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    abort.abort();
    conn?.close();
  }
}

/** Starts or reaches `server` and initializes it. Aborting `signal` closes it. Throws why it couldn't. */
export async function connect(server: Resolved, io: ProbeIo, signal?: AbortSignal): Promise<Connection> {
  const abort = new AbortController();
  if (signal) signal.aborted ? abort.abort() : signal.addEventListener("abort", () => abort.abort(), { once: true });
  const t = server.transport;
  const c: Client = { fetch: io.fetch, version: io.version ?? "0.0.0", signal: abort.signal };
  const link =
    t.type === "stdio" ? stdio(t.command, t.args ?? [], io.cwd ?? ".", io.env ?? {}, server.values, io.spawn, c) : t.type === "http" ? http(t.url, server.values, c) : sse(t.url, server.values, c);
  const close = () => abort.abort();
  let init: Json;
  try {
    init = resultOf((await link.exchange(initialize(0, c.version), 0))!);
    await link.exchange(initialized);
  } catch (error) {
    throw await link.explain(error as Error).finally(close);
  }
  let id = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    server: serverInfo(init),
    instructions: typeof init.instructions === "string" ? init.instructions : undefined,
    request(method, params) {
      const mine = ++id;
      const run = queue.then(async () => {
        let reply: Json | undefined;
        try {
          reply = await link.exchange({ jsonrpc: "2.0", id: mine, method, params }, mine);
        } catch (error) {
          throw await link.explain(error as Error).finally(close);
        }
        return resultOf(reply!);
      });
      queue = run.catch(() => {});
      return run;
    },
    explain: (error) => link.explain(error).finally(close),
    close,
  };
}

function toolInfo(tool: Json): McpToolInfo[] {
  if (typeof tool.name !== "string") return [];
  const description = typeof tool.description === "string" ? [...(tool.description.split(/\r?\n/)[0] ?? "")].slice(0, 300).join("") : undefined;
  const readOnly = (tool.annotations as Json | undefined)?.readOnlyHint;
  return [{ name: tool.name, ...(description !== undefined ? { description } : {}), ...(typeof readOnly === "boolean" ? { readOnly } : {}) }];
}

const initialize = (id: number, version: string) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT, version } },
});
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

/** A reply's result, or its JSON-RPC error as `MCP error <code>: <message>`. */
export function resultOf(reply: Json): Json {
  const error = reply.error as Json | undefined;
  if (error) throw new RpcError(`MCP error ${error.code === undefined ? "" : JSON.stringify(error.code)}: ${typeof error.message === "string" ? error.message : ""}`);
  return (reply.result as Json | undefined) ?? {};
}

/** `name version` from an initialize result's serverInfo. */
export function serverInfo(init: Json): string | undefined {
  const info = init.serverInfo as Json | undefined;
  if (typeof info?.name !== "string") return undefined;
  return typeof info.version === "string" ? `${info.name} ${info.version}` : info.name;
}

const isResponse = (value: unknown, id: number): value is Json =>
  !!value && typeof value === "object" && (value as Json).id === id && ("result" in (value as Json) || "error" in (value as Json));

/** One transport to a server: `exchange` sends a message and, given its id, answers the server's reply to it. */
type Link = {
  exchange(message: Json, id?: number): Promise<Json | undefined>;
  /** `error` in the server's words. */
  explain(error: Error): Promise<Error>;
};

function stdio(command: string, args: string[], cwd: string, env: Record<string, string>, values: Resolved["values"], spawn: Spawn | undefined, c: Client): Link {
  if (!spawn) return refused(`nothing here can start ${command}: a stdio server is tested where its agents run`);
  let proc: Child;
  try {
    proc = spawn([command, ...args], { cwd, env: { ...env, ...Object.fromEntries(values) } });
  } catch (error) {
    const code = (error as { code?: string }).code;
    return refused(code === "ENOENT" ? `${command} was not found on this machine's PATH (or ${cwd} doesn't exist)` : `${command} could not start: ${(error as Error).message}`);
  }
  // Its whole process group goes when the connection closes, by any path.
  const killGroup = () => proc.kill();
  if (c.signal.aborted) killGroup();
  else c.signal.addEventListener("abort", killGroup, { once: true });
  let stderr = Buffer.alloc(0);
  const tail = (async () => {
    for await (const chunk of proc.stderr) {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > 4 * STDERR_TAIL) stderr = stderr.subarray(stderr.length - STDERR_TAIL);
    }
  })().catch(() => {});
  const lines = readLines(proc.stdout);
  let ended = false;
  const write = async (message: Json) => {
    try {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      await proc.stdin.flush();
    } catch {
      ended = true;
      throw new Error("the server exited before it answered");
    }
  };
  return {
    async exchange(message, id) {
      await write(message);
      if (id === undefined) return undefined;
      for (;;) {
        const next = await lines.next();
        if (next.done) {
          ended = true;
          throw new Error("the server exited before it answered");
        }
        // A server may print other things, and asks of its own: a ping is answered, any other ask refused; only the
        // response counts.
        let value: unknown;
        try {
          value = JSON.parse(next.value.trim()) as unknown;
        } catch {
          continue;
        }
        if (isResponse(value, id)) return value;
        const ask = value as Json | null;
        if (ask && typeof ask.method === "string" && ask.id !== undefined && ask.id !== null) {
          await write(ask.method === "ping" ? { jsonrpc: "2.0", id: ask.id, result: {} } : { jsonrpc: "2.0", id: ask.id, error: { code: -32601, message: `method not found: ${ask.method}` } }).catch(() => {});
        }
      }
    },
    async explain(error) {
      const code = ended ? await Promise.race([proc.exited, Bun.sleep(5_000).then(() => undefined)]) : undefined;
      killGroup();
      await Promise.race([tail, Bun.sleep(2_000)]);
      let text = stderr.toString("utf8").trim();
      if (text.length > STDERR_TAIL) text = text.slice(text.length - STDERR_TAIL);
      const exited = code !== undefined && code !== 0 && proc.signalCode === null ? ` (exit ${code})` : "";
      return new Error(text ? `${error.message}${exited}: ${text}` : `${error.message}${exited}`);
    },
  };
}

/** A link that never connects, saying why. */
const refused = (why: string): Link => ({
  exchange: () => Promise.reject(new Error(why)),
  explain: async (error) => error,
});

/** A byte stream's lines. */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
    }
  }
  if (buffer) yield buffer;
}

/** `fetch` following at most 10 redirects, each to the first URL's own origin only: a server's headers (secrets among
 * them) never go elsewhere. */
async function sameOrigin(fetcher: Fetch, url: string, init: Omit<Parameters<Fetch>[1], "redirect">): Promise<Response> {
  const origin = new URL(url).origin;
  let at = url;
  for (let hop = 0; ; hop++) {
    const response = await fetcher(at, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location || hop >= 10) return response;
    const next = new URL(location, at);
    if (next.origin !== origin) return response;
    at = next.toString();
  }
}

const described = (error: unknown) => ((error as Error).name === "AbortError" ? "the request was cut off" : (error as Error).message);

function httpError(message: string, keyed: boolean): string {
  if (!message.includes("401")) return message;
  return keyed ? `${message}: the server refused its credentials; check its headers` : `${message}: the server wants credentials, a key or signing in`;
}

class Unauthorized extends Error {}

/** One request's answer in a JSON body, a batch, or an event stream's `data:` lines. */
export function findResponse(body: string, id: number): Json | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    return Array.isArray(value) ? value.find((v) => (v as Json)?.id === id) : (value as Json)?.id === id ? (value as Json) : undefined;
  } catch {}
  let data = "";
  for (const line of [...body.split(/\r?\n/), ""]) {
    if (line.startsWith("data:")) data += `${line.slice(5).replace(/^ /, "")}\n`;
    else if (!line && data) {
      try {
        const value = JSON.parse(data) as Json;
        if (value?.id === id) return value;
      } catch {}
      data = "";
    }
  }
  return undefined;
}


/** MCP's streamable HTTP, as the Rust McpClient speaks it: every message a POST, the session id kept. */
function http(url: string, headers: Resolved["values"], c: Client): Link {
  const keyed = headers.length > 0;
  let session: string | undefined;
  let protocol = PROTOCOL_VERSION;
  const post = async (message: Json): Promise<string | undefined> => {
    let response: Response;
    try {
      response = await sameOrigin(c.fetch, url, {
        method: "POST",
        signal: c.signal,
        headers: {
          ...Object.fromEntries(headers),
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": protocol,
          "user-agent": `${CLIENT}/${c.version}`,
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify(message),
      });
    } catch (error) {
      throw new Error(described(error));
    }
    if (response.status === 401) throw new Unauthorized();
    session = response.headers.get("mcp-session-id") ?? session;
    if (response.status === 202) return undefined;
    const body = await response.text();
    if (!response.ok) throw new Error(httpError(`Error POSTing to endpoint (HTTP ${response.status}): ${body.trim()}`, keyed));
    return body;
  };
  return {
    async exchange(message, id) {
      const body = await post(message);
      if (id === undefined) return undefined;
      const reply = body === undefined ? undefined : findResponse(body, id);
      if (!reply) throw new Error(`no answer to ${message.method}`);
      if (message.method === "initialize" && typeof (reply.result as Json | undefined)?.protocolVersion === "string") protocol = (reply.result as Json).protocolVersion as string;
      return reply;
    },
    async explain(error) {
      if (!(error instanceof Unauthorized)) return error;
      return new Error(keyed ? "the server refused its credentials (HTTP 401): check its headers" : "the server wants credentials (HTTP 401): a key, or signing in");
    },
  };
}

const readerOf = (response: Response) => response.body!.getReader();

/** MCP's older HTTP transport: a GET opens the event stream, whose first `endpoint` event names where to POST; every
 * answer comes back on the stream as a `message` event. */
function sse(url: string, headers: Resolved["values"], c: Client): Link {
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    return refused(`${url} is not a URL`);
  }
  const keyed = headers.length > 0;
  const own = { ...Object.fromEntries(headers), "user-agent": `${CLIENT}/${c.version}` };
  let reader: ReturnType<typeof readerOf> | undefined;
  c.signal.addEventListener("abort", () => void reader?.cancel().catch(() => {}), { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let endpoint: string | undefined;
  const open = async () => {
    let response: Response;
    try {
      response = await sameOrigin(c.fetch, url, { signal: c.signal, headers: { ...own, accept: "text/event-stream" } });
    } catch (error) {
      throw new Error(described(error));
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(httpError(`Error opening the event stream (HTTP ${response.status}): ${body.trim()}`, keyed));
    }
    reader = readerOf(response);
  };
  const event = async (): Promise<[string, string]> => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end + 2);
        buffer = buffer.slice(end + 2);
        let name = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
        }
        if (data) return [name, data];
        continue;
      }
      let chunk: Awaited<ReturnType<ReturnType<typeof readerOf>["read"]>>;
      try {
        chunk = await reader!.read();
      } catch (error) {
        throw new Error(described(error));
      }
      if (chunk.done) throw new Error("the server closed its event stream");
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
    }
  };
  return {
    async exchange(message, id) {
      if (!reader) await open();
      while (endpoint === undefined) {
        const [name, data] = await event();
        if (name !== "endpoint") continue;
        let at: URL;
        try {
          at = new URL(data.trim(), base);
        } catch {
          throw new Error(`the server named a bad endpoint: ${data}`);
        }
        // Its headers (secrets among them) go to the server's own origin only, as the MCP SDK has it.
        if (at.origin !== base.origin) throw new Error(`the server named an endpoint on another origin (${at.origin}): fleetd sends its headers only to ${base.origin}`);
        endpoint = at.toString();
      }
      let posted: Response;
      try {
        posted = await c.fetch(endpoint, { method: "POST", signal: c.signal, headers: { ...own, "content-type": "application/json" }, body: JSON.stringify(message) });
      } catch (error) {
        throw new Error(described(error));
      }
      if (!posted.ok) {
        const body = await posted.text().catch(() => "");
        throw new Error(httpError(`Error POSTing to endpoint (HTTP ${posted.status}): ${body.trim()}`, keyed));
      }
      await posted.body?.cancel();
      if (id === undefined) return undefined;
      for (;;) {
        const [name, data] = await event();
        if (name !== "message") continue;
        try {
          const value = JSON.parse(data) as unknown;
          if (isResponse(value, id)) return value;
        } catch {}
      }
    },
    explain: async (error) => error,
  };
}
