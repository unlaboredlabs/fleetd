// `fleetd agent-mcp --role lead|worker`: the MCP server (stdio, one JSON-RPC
// message per line) the node puts in every lead's and task's `--mcp-config`. Each tool is one lead-side call, sent
// through the node's socket with the session's `FLEETD_THREAD_ID`; the hub decides who may make it. The role only
// picks which tools are listed. Results that take time (a task's result, an answer, an approval) arrive in a later
// wake, never by polling.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../shared/version.ts";
import { checkArguments } from "./check.ts";
import { at, isObject, rustJson } from "./json.ts";
import { browserResult, errorResult, toolResult } from "./results.ts";
import { callerCwd, NODE_RESTARTING, nodeSocketPath, osError, sendToNode } from "./socket.ts";
import { ALIASES, toolList, toolsFor, SNAPSHOT, type Role } from "./tools.ts";

export { SERVER_NAME } from "./tools.ts";

const PROTOCOL_VERSION = "2025-06-18";
/** contracts' artifacts.rs `ARTIFACT_TEXT_CAP`, in UTF-16 units as the app counts. */
const ARTIFACT_TEXT_CAP = 2_000_000;
const NODE_TIMEOUT_MS = 90_000;

type Call = Record<string, unknown>;
const BROWSER_OPS = new Set(SNAPSHOT.tools.filter((t) => t.browser).map((t) => t.op));

/** The lead call a `tools/call` makes, or (thrown, a string) why its arguments are not one. */
export function callOf(role: Role, name: string, args: unknown): Call {
  const listed = ALIASES.find(([old]) => old === name)?.[1] ?? name;
  const tool = toolsFor(role).find((t) => t.name === listed);
  if (!tool) throw `No tool ${name} here.`;
  if (args !== null && args !== undefined && !isObject(args)) throw "The arguments must be an object.";
  const call: Call = { ...(args ?? {}), op: tool.op };
  const { op: _, ...fields } = call;
  const why = checkArguments(tool.name, tool.inputSchema, fields);
  if (why !== undefined) throw `Invalid arguments for ${name}: ${why}.`;
  return call;
}

/** A publish with `path` sends the file's text as `content`, read here, in the agent's own session: relative to its
 * working directory, or absolute. Its format follows the file's extension unless the call names one. */
export function readArtifactPath(call: Call, cwd: string): void {
  if (call.op !== "artifact_publish" || typeof call.content === "string") return;
  const path = call.path;
  if (typeof path !== "string") throw "Give content or path for the artifact.";
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.startsWith("/") ? path : join(cwd, path));
  } catch (error) {
    throw `Can't read ${path}: ${osError(error)}.`;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw `${path} isn't UTF-8 text.`;
  }
  if (text === "") throw `${path} is empty.`;
  if (text.length > ARTIFACT_TEXT_CAP) {
    throw `${path} is longer than ${ARTIFACT_TEXT_CAP} characters: split it, or link large data out.`;
  }
  if (call.format === undefined || call.format === null) {
    const lower = path.toLowerCase();
    call.format = lower.endsWith(".html") || lower.endsWith(".htm") ? "html" : "md";
  }
  call.content = text;
}

/** Where the server runs and how it reaches the node; tests swap `send`. */
export interface LeadDeps {
  pwd: string | undefined;
  sock: string | undefined;
  /** `FLEETD_THREAD_ID`: set inside a fleetd session, so the hub knows which agent is calling. */
  thread: string | undefined;
  cwd: string;
  send: (socket: string, frame: Call) => Promise<Record<string, unknown>>;
}

/** The real process's deps. */
export const envDeps = (): LeadDeps => ({
  pwd: process.env.PWD,
  sock: process.env.FLEETD_NODE_SOCK,
  thread: process.env.FLEETD_THREAD_ID,
  cwd: process.cwd(),
  send: (socket, frame) => sendToNode(socket, frame, NODE_TIMEOUT_MS),
});

/** One lead call (`{"op": …, …}`) to the hub through the node: the answer frame, or (thrown) why the node could not
 * be asked. */
export function sendCall(call: Call, deps: LeadDeps): Promise<Record<string, unknown>> {
  const frame: Call = {
    t: BROWSER_OPS.has(String(call.op)) ? "browser_call" : "lead_call",
    id: `cli-${process.pid}`,
    cwd: callerCwd(deps.pwd, deps.cwd),
    call,
  };
  if (deps.thread) frame.threadId = deps.thread;
  return deps.send(nodeSocketPath(deps.sock), frame);
}

async function toolCall(role: Role, params: unknown, deps: LeadDeps) {
  const name = at(params, "name");
  let call: Call;
  try {
    call = callOf(role, typeof name === "string" ? name : "", at(params, "arguments"));
    readArtifactPath(call, callerCwd(deps.pwd, deps.cwd));
  } catch (why) {
    return errorResult(String(why));
  }
  let answer: Record<string, unknown>;
  try {
    answer = await sendCall(call, deps);
  } catch (unreachable) {
    if (String(unreachable).startsWith(NODE_RESTARTING)) return errorResult(String(unreachable));
    return errorResult(`${unreachable}. Carry on without this call and say so in your result.`);
  }
  return isObject(answer.result) && "op" in answer.result ? browserResult(answer) : toolResult(answer);
}

/** One JSON-RPC message in, its answer out (undefined for a notification). */
export async function handle(role: Role, message: unknown, deps: LeadDeps): Promise<Call | undefined> {
  if (!isObject(message) || !("id" in message)) return;
  const id = message.id ?? null;
  const method = typeof message.method === "string" ? message.method : "";
  let result: unknown;
  switch (method) {
    case "initialize": {
      const asked = at(message.params, "protocolVersion");
      result = {
        protocolVersion: typeof asked === "string" ? asked : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "fleetd", version: VERSION },
        instructions: "fleetd's own tools: every agent is a fleetd task, started, steered and stopped here.",
      };
      break;
    }
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = toolList(role);
      break;
    case "tools/call":
      result = await toolCall(role, message.params, deps);
      break;
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }
  return { jsonrpc: "2.0", id, result };
}

/** stdin's lines, as Rust's `lines()` reads them: `\n` or `\r\n` ends one; invalid UTF-8 ends them all. */
async function* lines(input: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let pending = new Uint8Array(0);
  const decode = (bytes: Uint8Array) => {
    const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
    return decoder.decode(bytes.subarray(0, end));
  };
  for await (const chunk of input) {
    let joined = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let start = 0;
    for (let nl = joined.indexOf(0x0a); nl >= 0; nl = joined.indexOf(0x0a, start)) {
      yield decode(joined.subarray(start, nl));
      start = nl + 1;
    }
    pending = joined.slice(start);
  }
  if (pending.length > 0) yield decode(pending);
}

export const AGENT_MCP_USAGE = "usage: fleetd agent-mcp --role lead|worker";

/** `fleetd agent-mcp --role lead|worker`: serves stdin until it closes. */
export async function agentMcp(argv: string[], deps: LeadDeps = envDeps()): Promise<number> {
  const role = argv.length === 2 && argv[0] === "--role" && (argv[1] === "lead" || argv[1] === "worker") ? argv[1] : undefined;
  if (!role) {
    process.stderr.write(`${AGENT_MCP_USAGE}\n`);
    return 2;
  }
  const out = Bun.stdout.writer();
  try {
    for await (const line of lines(Bun.stdin.stream())) {
      if (line.trim() === "") continue;
      let message: unknown;
      let answer: Call | undefined;
      try {
        message = JSON.parse(line);
      } catch (error) {
        answer = { jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${(error as Error).message}` } };
      }
      if (answer === undefined) answer = await handle(role, message, deps);
      if (answer === undefined) continue;
      out.write(`${rustJson(answer)}\n`);
      await out.flush();
    }
  } catch (error) {
    // Invalid UTF-8 on stdin, or stdout gone: the Rust server stops reading too.
    if (!(error instanceof TypeError) && (error as { code?: string }).code !== "EPIPE") throw error;
  }
  return 0;
}
