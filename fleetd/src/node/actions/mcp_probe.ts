// Test connection (`mcp_test`, crates/fleetd/src/node/mcp_probe.rs): the node starts or reaches an MCP server as an
// agent's claude would, initializes it and lists its tools, within TIMEOUT_MS. A stdio server runs in the given
// directory with the agent's environment plus its own env, in a process group of its own that is killed afterwards;
// an HTTP server is called with its headers (MCP's streamable HTTP, cli/mcp_client.rs); an SSE server (MCP's older
// HTTP transport) is read from its event stream. What goes wrong comes back as one line a person can act on, with a
// command's stderr tail, every one of the server's secrets masked.
import type { McpTestResult, McpToolInfo } from "../../shared/contracts.ts";
import { VERSION } from "../../shared/version.ts";
import { Masker } from "../mask.ts";
import type { Env } from "../util.ts";
import type { Resolved } from "./mcp.ts";

export const TIMEOUT_MS = 30_000;
export const PROTOCOL_VERSION = "2025-06-18";
const STDERR_TAIL = 2000;
const CLIENT = "fleetd-mcp-test";
const TOOL_PAGES = 20;

type Json = Record<string, unknown>;
type Found = { server?: string; tools: Json[] };

export async function probe(server: Resolved, cwd: string, env: Env): Promise<McpTestResult> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`no answer within ${TIMEOUT_MS / 1000} s: the server didn't finish starting or listing its tools`));
    }, TIMEOUT_MS);
  });
  const t = server.transport;
  const run = t.type === "stdio" ? stdio(t.command, t.args ?? [], cwd, env, server.values, abort.signal) : t.type === "http" ? http(t.url, server.values, abort.signal) : sse(t.url, server.values, abort.signal);
  try {
    const found = await Promise.race([run, timeout]);
    return { ...(found.server ? { server: found.server } : {}), tools: found.tools.flatMap(toolInfo) };
  } catch (error) {
    return { tools: [], error: new Masker(server.secrets).text((error as Error).message) };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

function toolInfo(tool: Json): McpToolInfo[] {
  if (typeof tool.name !== "string") return [];
  const description = typeof tool.description === "string" ? [...(tool.description.split(/\r?\n/)[0] ?? "")].slice(0, 300).join("") : undefined;
  const readOnly = (tool.annotations as Json | undefined)?.readOnlyHint;
  return [{ name: tool.name, ...(description !== undefined ? { description } : {}), ...(typeof readOnly === "boolean" ? { readOnly } : {}) }];
}

const initialize = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT, version: VERSION } },
});
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const list = (id: number, cursor?: string) => ({ jsonrpc: "2.0", id, method: "tools/list", params: cursor ? { cursor } : {} });

/** A reply's result, or its JSON-RPC error as `MCP error <code>: <message>`. */
export function resultOf(reply: Json): Json {
  const error = reply.error as Json | undefined;
  if (error) throw new Error(`MCP error ${error.code === undefined ? "" : JSON.stringify(error.code)}: ${typeof error.message === "string" ? error.message : ""}`);
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

type Exchange = { send(message: Json): Promise<void>; response(id: number): Promise<Json> };

/** initialize, initialized, then every page of tools/list. */
async function session(x: Exchange): Promise<Found> {
  await x.send(initialize(0));
  const init = resultOf(await x.response(0));
  await x.send(initialized);
  const tools: Json[] = [];
  let cursor: string | undefined;
  for (let id = 1; id <= TOOL_PAGES; id++) {
    await x.send(list(id, cursor));
    const page = resultOf(await x.response(id));
    if (Array.isArray(page.tools)) tools.push(...(page.tools as Json[]));
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    if (cursor === undefined) break;
  }
  return { server: serverInfo(init), tools };
}

async function stdio(command: string, args: string[], cwd: string, env: Env, values: [string, string][], signal: AbortSignal): Promise<Found> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([command, ...args], { cwd, env: { ...env, ...Object.fromEntries(values) }, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new Error(code === "ENOENT" ? `${command} was not found on this machine's PATH (or ${cwd} doesn't exist)` : `${command} could not start: ${(error as Error).message}`);
  }
  // Its whole process group goes when the test ends, by any path: a launcher such as `npx` or `uvx` runs the real
  // server as its own child, which killing the launcher alone would leave behind.
  const killGroup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  };
  signal.addEventListener("abort", killGroup);
  let stderr = Buffer.alloc(0);
  const tail = (async () => {
    for await (const chunk of proc.stderr) {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > 4 * STDERR_TAIL) stderr = stderr.subarray(stderr.length - STDERR_TAIL);
    }
  })().catch(() => {});
  const lines = readLines(proc.stdout);
  let ended = false;
  const x: Exchange = {
    async send(message) {
      try {
        proc.stdin.write(`${JSON.stringify(message)}\n`);
        await proc.stdin.flush();
      } catch {
        ended = true;
        throw new Error("the server exited before it answered");
      }
    },
    async response(id) {
      for (;;) {
        const next = await lines.next();
        if (next.done) {
          ended = true;
          throw new Error("the server exited before it answered");
        }
        // A server may print other things, and asks of its own; only the response counts.
        try {
          const value = JSON.parse(next.value.trim()) as unknown;
          if (isResponse(value, id)) return value;
        } catch {}
      }
    },
  };
  let outcome: Found | Error;
  try {
    outcome = await session(x);
  } catch (error) {
    outcome = error as Error;
  }
  const code = ended ? await Promise.race([proc.exited, Bun.sleep(5_000).then(() => undefined)]) : undefined;
  killGroup();
  signal.removeEventListener("abort", killGroup);
  if (!(outcome instanceof Error)) return outcome;
  await Promise.race([tail, Bun.sleep(2_000)]);
  let text = stderr.toString("utf8").trim();
  if (text.length > STDERR_TAIL) text = text.slice(text.length - STDERR_TAIL);
  const exited = code !== undefined && code !== 0 && proc.signalCode === null ? ` (exit ${code})` : "";
  throw new Error(text ? `${outcome.message}${exited}: ${text}` : `${outcome.message}${exited}`);
}

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
async function sameOrigin(url: string, init: RequestInit): Promise<Response> {
  const origin = new URL(url).origin;
  let at = url;
  for (let hop = 0; ; hop++) {
    const response = await fetch(at, { ...init, redirect: "manual" });
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
async function http(url: string, headers: [string, string][], signal: AbortSignal): Promise<Found> {
  const keyed = headers.length > 0;
  let session: string | undefined;
  let protocol = PROTOCOL_VERSION;
  let nextId = 0;
  const post = async (message: Json): Promise<string | undefined> => {
    let response: Response;
    try {
      response = await sameOrigin(url, {
        method: "POST",
        signal,
        headers: {
          ...Object.fromEntries(headers),
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": protocol,
          "user-agent": `${CLIENT}/${VERSION}`,
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
  const request = async (method: string, params: Json): Promise<Json> => {
    const id = nextId++;
    const body = await post({ jsonrpc: "2.0", id, method, params });
    const reply = body === undefined ? undefined : findResponse(body, id);
    if (!reply) throw new Error(`no answer to ${method}`);
    return resultOf(reply);
  };
  try {
    const init = await request("initialize", initialize(0).params);
    if (typeof init.protocolVersion === "string") protocol = init.protocolVersion;
    await post(initialized);
    const tools: Json[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < TOOL_PAGES; page++) {
      const listed = await request("tools/list", cursor ? { cursor } : {});
      if (Array.isArray(listed.tools)) tools.push(...(listed.tools as Json[]));
      cursor = typeof listed.nextCursor === "string" ? listed.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    return { server: serverInfo(init), tools };
  } catch (error) {
    if (error instanceof Unauthorized)
      throw new Error(keyed ? "the server refused its credentials (HTTP 401): check its headers" : "the server wants credentials (HTTP 401): a key, or signing in");
    throw error;
  }
}

/** MCP's older HTTP transport: a GET opens the event stream, whose first `endpoint` event names where to POST; every
 * answer comes back on the stream as a `message` event. */
async function sse(url: string, headers: [string, string][], signal: AbortSignal): Promise<Found> {
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    throw new Error(`${url} is not a URL`);
  }
  const keyed = headers.length > 0;
  const own = { ...Object.fromEntries(headers), "user-agent": `${CLIENT}/${VERSION}` };
  let response: Response;
  try {
    response = await sameOrigin(url, { signal, headers: { ...own, accept: "text/event-stream" } });
  } catch (error) {
    throw new Error(described(error));
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(httpError(`Error opening the event stream (HTTP ${response.status}): ${body.trim()}`, keyed));
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let endpoint: string | undefined;
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
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new Error(described(error));
      }
      if (chunk.done) throw new Error("the server closed its event stream");
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
    }
  };
  const x: Exchange = {
    async send(message) {
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
        posted = await fetch(endpoint, { method: "POST", signal, headers: { ...own, "content-type": "application/json" }, body: JSON.stringify(message) });
      } catch (error) {
        throw new Error(described(error));
      }
      if (!posted.ok) {
        const body = await posted.text().catch(() => "");
        throw new Error(httpError(`Error POSTing to endpoint (HTTP ${posted.status}): ${body.trim()}`, keyed));
      }
      await posted.body?.cancel();
    },
    async response(id) {
      for (;;) {
        const [name, data] = await event();
        if (name !== "message") continue;
        try {
          const value = JSON.parse(data) as unknown;
          if (isResponse(value, id)) return value;
        } catch {}
      }
    },
  };
  try {
    return await session(x);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
