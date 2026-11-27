// `fleetd agent-mcp --role lead|worker`: the MCP server (stdio, one JSON-RPC
// message per line) the node puts in every lead's and task's `--mcp-config`. Each tool is one lead-side call, sent
// through the node's socket with the session's `FLEETD_THREAD_ID`; the hub decides who may make it. The role only
// picks which tools are listed. Results that take time (a task's result, an answer, an approval) arrive in a later
// wake, never by polling. The tools listed are the node's: a node updated since the session started runs a newer
// build, whose tools this server takes and announces with `notifications/tools/list_changed` (`serve`).
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newCallId } from "../../shared/lead_once.ts";
import { VERSION } from "../../shared/version.ts";
import { checkArguments } from "./check.ts";
import { at, isObject, rustJson } from "./json.ts";
import { browserResult, errorResult, toolResult, type ToolResult } from "./results.ts";
import { callerCwd, NODE_RESTARTING, nodeSocketPath, osError, sendToNode } from "./socket.ts";
import { storeSecret } from "./store.ts";
import { snapshotHash, toolList, toolsFor, SNAPSHOT, useSnapshot, type Role, type Snapshot } from "./tools.ts";

export { SERVER_NAME } from "./tools.ts";

const PROTOCOL_VERSION = "2025-06-18";
/** contracts' artifacts.rs `ARTIFACT_TEXT_CAP`, in UTF-16 units as the app counts. */
const ARTIFACT_TEXT_CAP = 2_000_000;
const NODE_TIMEOUT_MS = 90_000;
/** How often a running server asks the node whether its tools changed. */
export const TOOLS_EVERY_MS = 15_000;
/** How long the first tools/list waits for the node's tools before it lists this build's. */
const FIRST_TOOLS_WAIT_MS = 3_000;

type Call = Record<string, unknown>;
const isBrowserOp = (op: unknown) => SNAPSHOT.tools.some((t) => t.browser && t.op === op);

/** The lead call a `tools/call` makes, or (thrown, a string) why its arguments are not one. */
export function callOf(role: Role, name: string, args: unknown): Call {
  const tool = toolsFor(role).find((t) => t.name === name);
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
  /** Where `attachment_read` saves a file: the session's own TMPDIR. */
  tmp?: string;
  send: (socket: string, frame: Call) => Promise<Record<string, unknown>>;
}

/** The real process's deps. */
export const envDeps = (): LeadDeps => ({
  pwd: process.env.PWD,
  sock: process.env.FLEETD_NODE_SOCK,
  thread: process.env.FLEETD_THREAD_ID,
  cwd: process.cwd(),
  tmp: process.env.TMPDIR || tmpdir(),
  send: (socket, frame) => sendToNode(socket, frame, NODE_TIMEOUT_MS),
});

/** One lead call (`{"op": …, …}`) to the hub through the node: the answer frame, or (thrown) why the node could not
 * be asked. Each call has its own id, so one sent again after a cut is answered once (../../shared/lead_once.ts). */
export function sendCall(call: Call, deps: LeadDeps): Promise<Record<string, unknown>> {
  const frame: Call = {
    t: isBrowserOp(call.op) ? "browser_call" : "lead_call",
    id: newCallId(process.pid, randomUUID()),
    cwd: callerCwd(deps.pwd, deps.cwd),
    call,
  };
  if (deps.thread) frame.threadId = deps.thread;
  return deps.send(nodeSocketPath(deps.sock), frame);
}

/** Why the node could not be asked, as the tool's error. */
function unreachableResult(unreachable: unknown): ToolResult {
  if (String(unreachable).startsWith(NODE_RESTARTING)) return errorResult(String(unreachable));
  return errorResult(`${unreachable}. Carry on without this call and say so in your result.`);
}

/** What one `attachment_read` asks the hub for: its ATTACHMENT_READ_PIECE, well inside a node frame. */
const ATTACHMENT_PIECE = 4 * 1024 * 1024;

/**
 * `attachment_read`: the file, a piece at a time, saved in this session's own TMPDIR, which is where the agent runs
 * (a worktree, a hosted box), and out of its worktree, so git never sees it. Says where, to open with Read.
 */
export async function saveAttachment(call: Call, deps: LeadDeps): Promise<ToolResult> {
  const id = String(call.attachmentId);
  let file: string | undefined;
  let name = "";
  let size = 0;
  for (let offset = 0; file === undefined || offset < size; ) {
    let answer: Record<string, unknown>;
    try {
      answer = await sendCall({ op: "attachment_read", attachmentId: id, offset, length: ATTACHMENT_PIECE }, deps);
    } catch (unreachable) {
      return unreachableResult(unreachable);
    }
    if (!("result" in answer)) return toolResult(answer);
    const result = answer.result;
    const piece = Buffer.from(String(at(result, "dataB64") ?? ""), "base64");
    try {
      if (file === undefined) {
        name = String(at(result, "name") ?? id);
        size = Number(at(result, "bytes") ?? 0);
        const dir = join(deps.tmp ?? tmpdir(), "fleetd-attachments", id);
        mkdirSync(dir, { recursive: true });
        // The hub's names are safe ones already; this keeps the file in its folder whatever it says.
        file = join(dir, name.replace(/[/\\\0]/g, "_").replace(/^\.+/, "") || id);
        writeFileSync(`${file}.part`, piece);
      } else appendFileSync(`${file}.part`, piece);
    } catch (error) {
      return errorResult(`${id} not saved: ${osError(error)}.`);
    }
    if (piece.length === 0) break;
    offset += piece.length;
  }
  try {
    renameSync(`${file}.part`, file);
  } catch (error) {
    return errorResult(`${id} not saved: ${osError(error)}.`);
  }
  return { content: [{ type: "text", text: `Saved ${id} (${name}, ${size} bytes) at ${file}: open it with Read.` }], isError: false };
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
  if (call.op === "attachment_read") return saveAttachment(call, deps);
  if (call.op === "vault_store") return storeSecret(call, deps, role);
  let answer: Record<string, unknown>;
  try {
    answer = await sendCall(call, deps);
  } catch (unreachable) {
    return unreachableResult(unreachable);
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
        capabilities: { tools: { listChanged: true } },
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

/** The node's tools, taken in place of the ones served (`served.hash`) when they differ: whether `role`'s tools/list
 * changed with them. A node that can't be asked, or is from before `agent_tools`, leaves them as they are. */
export async function takeNodeTools(role: Role, deps: LeadDeps, served: { hash: string }): Promise<boolean> {
  let answer: Record<string, unknown>;
  try {
    answer = await deps.send(nodeSocketPath(deps.sock), { t: "agent_tools", have: served.hash });
  } catch {
    return false;
  }
  if (answer.t !== "agent_tools" || typeof answer.hash !== "string" || answer.hash === served.hash) return false;
  const next = answer.snapshot;
  if (!isObject(next) || !Array.isArray(next.tools) || !isObject(next.probes)) return false;
  const before = JSON.stringify(toolList(role));
  useSnapshot(next as unknown as Snapshot);
  served.hash = answer.hash;
  return JSON.stringify(toolList(role)) !== before;
}

/** Serves `input`'s messages until it ends, each answer a line to `write`. The node's tools are asked for as it starts
 * (the first tools/list waits for them a little) and every `everyMs`; once claude has listed tools, a change is
 * announced, and claude lists them again. */
export async function serve(
  role: Role,
  input: ReadableStream<Uint8Array>,
  write: (line: string) => Promise<unknown>,
  deps: LeadDeps,
  everyMs = TOOLS_EVERY_MS,
): Promise<void> {
  const served = { hash: snapshotHash(SNAPSHOT) };
  let listed = false;
  let asking: Promise<void> | undefined;
  const ask = () =>
    (asking ??= takeNodeTools(role, deps, served)
      .then(async (changed) => {
        if (changed && listed) await write(rustJson({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
      })
      .catch(() => {})
      .finally(() => {
        asking = undefined;
      }));
  const first = ask();
  const timer = setInterval(ask, everyMs);
  timer.unref();
  try {
    for await (const line of lines(input)) {
      if (line.trim() === "") continue;
      let message: unknown;
      let answer: Call | undefined;
      try {
        message = JSON.parse(line);
      } catch (error) {
        answer = { jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${(error as Error).message}` } };
      }
      if (answer === undefined) {
        if (isObject(message) && message.method === "tools/list") {
          await Promise.race([first, Bun.sleep(FIRST_TOOLS_WAIT_MS)]);
          // In the same tick as the list is read: a change after this is announced.
          listed = true;
        }
        answer = await handle(role, message, deps);
      }
      if (answer === undefined) continue;
      await write(`${rustJson(answer)}\n`);
    }
  } finally {
    clearInterval(timer);
  }
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
    await serve(role, Bun.stdin.stream(), async (line) => {
      out.write(line.endsWith("\n") ? line : `${line}\n`);
      await out.flush();
    }, deps);
  } catch (error) {
    // Invalid UTF-8 on stdin, or stdout gone: the Rust server stops reading too.
    if (!(error instanceof TypeError) && (error as { code?: string }).code !== "EPIPE") throw error;
  }
  return 0;
}
