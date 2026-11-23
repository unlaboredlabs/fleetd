// `fleetd mcp-gateway`: how an Antigravity session reaches the bot's own MCP servers. agy shows its model at most about
// 60 KB of MCP tools, every server's together, and silently hides the biggest past it (node/runner/antigravity_spec.ts
// TOOL_BUDGET): Paper's tools alone are 55 KB. So the session's agy gets fleetd's own server and this one in place of
// the bot's (antigravity_spec.ts `mcpServers`), and this one has two tools, whatever the servers behind it hold:
// `search`, which finds their tools by words and gives each one's input schema, and `call`, which runs one, its answer
// as the server gave it. Claude Code's deferred tools work so: a few tools in the model's context, the rest on demand.
//
// The servers come in FLEETD_MCP_GATEWAY (`{"mcpServers": {...}}`, values included, as a session's mcp.json has them).
// Each is started or reached at its first search or call, as the Test reaches one (node/actions/mcp_probe.ts
// `connect`): a stdio server in this command's directory with its environment plus the server's env, its process
// group ended with this command. One that can't be reached is said so in the tool's answer, never a value of its; the
// next search or call tries it again.
import { connect, type Connection, type ProbeIo, resolvedOf, RpcError, TIMEOUT_MS, toolsOf } from "../node/actions/mcp_probe.ts";
import { spawnGroup } from "../node/actions/mcp_spawn.ts";
import { Masker } from "../node/mask.ts";
import { GATEWAY_ENV } from "../node/runner/antigravity_spec.ts";
import { VERSION } from "../shared/version.ts";

type Json = Record<string, unknown>;
type Tool = { name: string; description?: string; inputSchema?: unknown };
type Reached = { conn: Connection; tools: Tool[] };

const PROTOCOL_VERSION = "2025-06-18";
/** How long one call may take, through to its answer. */
export const CALL_TIMEOUT_MS = 10 * 60_000;
/** The most tools one search answers with, their schemas whole. */
export const SEARCH_MAX = 8;
const USAGE = `usage: fleetd mcp-gateway (run by an Antigravity session, with ${GATEWAY_ENV} set)`;

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export class Gateway {
  readonly #servers: Record<string, unknown>;
  readonly #io: ProbeIo;
  readonly #reached = new Map<string, Promise<Reached>>();
  /** Servers whose own instructions a search has given already. */
  readonly #told = new Set<string>();

  constructor(servers: Record<string, unknown>, io: ProbeIo) {
    this.#servers = servers;
    this.#io = io;
  }

  get names(): string[] {
    return Object.keys(this.#servers);
  }

  /** The gateway's own two tools. */
  tools(): Tool[] {
    const names = this.names.join(", ");
    return [
      {
        name: "search",
        description:
          `Find the tools of this session's MCP servers (${names}) and get each one's input schema. Their tools aren't listed one by one: ` +
          `search for what you need (words of a tool's name or what it does), then run it with call. An empty query lists every tool's name.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Words to find tools by, e.g. `screenshot artboard`. Empty: list every tool's name." },
            server: { type: "string", description: `Only this server's tools: one of ${names}.` },
          },
          required: ["query"],
        },
      },
      {
        name: "call",
        description: `Run a tool of this session's MCP servers (${names}) that search found, with arguments as its input schema says.`,
        inputSchema: {
          type: "object",
          properties: {
            server: { type: "string", description: "The tool's server." },
            tool: { type: "string", description: "The tool's name." },
            arguments: { type: "object", description: "The tool's arguments." },
          },
          required: ["server", "tool"],
        },
      },
    ];
  }

  /** The server reached, with its tools; thrown, why it can't be. */
  #reach(name: string): Promise<Reached> {
    let got = this.#reached.get(name);
    if (got) return got;
    const server = resolvedOf(name, this.#servers[name]);
    got = (async () => {
      if (!server) throw new Error("its entry names no command or address");
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
      try {
        const conn = await connect(server, this.#io, abort.signal);
        const tools = await toolsOf(conn).catch(async (error) => {
          throw error instanceof RpcError ? await conn.explain(error) : error;
        });
        clearTimeout(timer);
        return { conn, tools: tools.filter((t): t is Tool => typeof t.name === "string") as Tool[] };
      } catch (error) {
        clearTimeout(timer);
        throw abort.signal.aborted ? new Error(`no answer within ${TIMEOUT_MS / 1000} s`) : error;
      }
    })();
    got.catch(() => this.#reached.delete(name));
    this.#reached.set(name, got);
    return got;
  }

  /** `why` with none of the server's values in it. */
  #masked(name: string, why: string): string {
    const server = resolvedOf(name, this.#servers[name]);
    return new Masker((server?.values ?? []).map(([k, v]) => [`${name}.${k}`, v])).text(why);
  }

  /** The `search` tool. */
  async search(args: Json): Promise<Json> {
    const query = typeof args.query === "string" ? args.query : "";
    const only = typeof args.server === "string" && args.server ? args.server : undefined;
    if (only !== undefined && !(only in this.#servers)) return text(`No MCP server ${only} here: this session's are ${this.names.join(", ")}.`, true);
    const names = only ? [only] : this.names;
    const reached = await Promise.all(names.map(async (name) => ({ name, got: await this.#reach(name).then((r) => r, (e: Error) => e) })));
    const down = reached.flatMap(({ name, got }) => (got instanceof Error ? [`${name} can't be reached right now (${this.#masked(name, got.message)}): search again in a minute.`] : []));
    const up = reached.flatMap(({ name, got }) => (got instanceof Error ? [] : [{ name, ...got }]));
    const asked = words(query);
    const lines: string[] = [];
    if (asked.length === 0) {
      for (const s of up) lines.push(`${s.name}: ${s.tools.map((t) => t.name).join(", ")}`);
      lines.push("", "Search with words of a tool's name to get its input schema, then run it with call.");
    } else {
      const hits = up
        .flatMap((s) => s.tools.map((t) => ({ server: s.name, tool: t, score: score(asked, s.name, t) })))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score);
      const shown = hits.slice(0, SEARCH_MAX);
      for (const s of new Set(shown.map((h) => h.server))) {
        const said = up.find((u) => u.name === s)?.conn.instructions;
        if (said && !this.#told.has(s)) {
          this.#told.add(s);
          lines.push(`${s}'s own instructions:`, said.trim(), "");
        }
      }
      if (shown.length === 0) {
        lines.push(`No tool matches "${query}". Every tool's name:`);
        for (const s of up) lines.push(`${s.name}: ${s.tools.map((t) => t.name).join(", ")}`);
      } else {
        lines.push("Run one with call (server, tool, arguments):");
        for (const h of shown) lines.push(JSON.stringify({ server: h.server, tool: h.tool.name, description: h.tool.description ?? "", inputSchema: h.tool.inputSchema ?? {} }));
        if (hits.length > shown.length) lines.push(`${hits.length - shown.length} more match: narrow the words or name the server.`);
      }
    }
    if (down.length) lines.push("", ...down);
    return text(lines.join("\n").trim(), up.length === 0);
  }

  /** The `call` tool: the server's answer as it gave it. */
  async call(args: Json): Promise<Json> {
    const name = typeof args.server === "string" ? args.server : "";
    const tool = typeof args.tool === "string" ? args.tool : "";
    if (!(name in this.#servers)) return text(`No MCP server ${name || "(none named)"} here: this session's are ${this.names.join(", ")}. Find a tool with search first.`, true);
    if (!tool) return text("Name the tool to run: find it with search first.", true);
    const params = args.arguments === undefined || args.arguments === null ? {} : args.arguments;
    if (typeof params !== "object" || Array.isArray(params)) return text("The arguments must be an object.", true);
    let reached: Reached;
    try {
      reached = await this.#reach(name);
    } catch (error) {
      return text(`${name} can't be reached right now (${this.#masked(name, (error as Error).message)}). Try again in a minute; if it keeps failing, carry on without ${name} and say so.`, true);
    }
    if (!reached.tools.some((t) => t.name === tool)) {
      return text(`${name} has no tool ${tool}. Its tools: ${reached.tools.map((t) => t.name).join(", ")}.`, true);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${CALL_TIMEOUT_MS / 60_000} minutes`)), CALL_TIMEOUT_MS);
      });
      return await Promise.race([reached.conn.request("tools/call", { name: tool, arguments: params }), timeout]);
    } catch (error) {
      if (error instanceof RpcError) return text(this.#masked(name, error.message), true);
      // A server that stopped answering is reached afresh at the next search or call.
      this.#reached.delete(name);
      reached.conn.close();
      return text(`${name} didn't answer (${this.#masked(name, (error as Error).message)}). Try again; if it keeps failing, carry on without ${name} and say so.`, true);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends every server it started or reached. */
  async close(): Promise<void> {
    const all = await Promise.allSettled(this.#reached.values());
    for (const r of all) if (r.status === "fulfilled") r.value.conn.close();
    this.#reached.clear();
  }
}

/** How well a tool matches the words asked: each word in its name counts most, in its server's name next, in its
 * description least. */
function score(asked: string[], server: string, tool: Tool): number {
  const name = tool.name.toLowerCase();
  const nameWords = new Set(words(tool.name));
  const about = words(tool.description ?? "");
  let total = 0;
  for (const w of asked) {
    // A part of a word counts from three letters: `screen` finds get_screenshot, `a` finds nothing.
    const part = w.length >= 3;
    if (nameWords.has(w)) total += 4;
    else if (part && name.includes(w)) total += 3;
    else if (about.includes(w)) total += 1;
    else if (part && about.some((a) => a.startsWith(w))) total += 0.5;
  }
  // The server's own name only narrows: a search for "paper" alone lists Paper's tools.
  const serverWords = words(server);
  if (asked.some((w) => serverWords.includes(w))) total += total > 0 ? 1 : 0.25;
  return total;
}

/** One JSON-RPC message in, its answer out (undefined for a notification). */
export async function handle(gateway: Gateway, message: unknown): Promise<Json | undefined> {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const m = message as Json;
  if (!("id" in m)) return;
  const id = m.id ?? null;
  const params = (m.params ?? {}) as Json;
  let result: unknown;
  switch (m.method) {
    case "initialize":
      result = {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "fleetd-mcp-gateway", version: VERSION },
        instructions: `The tools of this session's MCP servers (${gateway.names.join(", ")}) load on demand: find one with search, then run it with call.`,
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools: gateway.tools() };
      break;
    case "tools/call": {
      const args = (params.arguments ?? {}) as Json;
      result = params.name === "search" ? await gateway.search(args) : params.name === "call" ? await gateway.call(args) : text(`No tool ${String(params.name)} here.`, true);
      break;
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(m.method)}` } };
  }
  return { jsonrpc: "2.0", id, result };
}

async function* lines(input: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) yield buffer;
}

/** `fleetd mcp-gateway`: serves stdin until it closes, each request in its own time. */
export async function mcpGateway(argv: string[]): Promise<number> {
  let servers: Record<string, unknown> | undefined;
  try {
    servers = (JSON.parse(process.env[GATEWAY_ENV] ?? "") as { mcpServers?: Record<string, unknown> }).mcpServers;
  } catch {}
  if (argv.length > 0 || !servers || typeof servers !== "object") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== GATEWAY_ENV));
  const gateway = new Gateway(servers, { fetch, spawn: spawnGroup, cwd: process.cwd(), env, version: VERSION });
  const out = Bun.stdout.writer();
  const write = async (answer: Json) => {
    out.write(`${JSON.stringify(answer)}\n`);
    await out.flush();
  };
  const ending = () => void gateway.close().finally(() => process.exit(0));
  process.on("SIGTERM", ending);
  process.on("SIGINT", ending);
  const inflight = new Set<Promise<void>>();
  try {
    for await (const line of lines(Bun.stdin.stream())) {
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${(error as Error).message}` } });
        continue;
      }
      const going: Promise<void> = handle(gateway, message)
        .then((answer) => (answer ? write(answer) : undefined))
        .catch(() => {})
        .finally(() => inflight.delete(going));
      inflight.add(going);
    }
    await Promise.all(inflight);
  } catch (error) {
    if ((error as { code?: string }).code !== "EPIPE") throw error;
  } finally {
    await gateway.close();
  }
  return 0;
}
