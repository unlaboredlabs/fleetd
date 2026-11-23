// A stand-in for `agy acp`: just enough of Antigravity's ACP server for the runner's tests, with no Google behind it.
// Every request it gets goes to $AGY_LOG, one JSON line each. A prompt's text picks what the turn does:
// `hang` waits for session/cancel, or for a prompt sent mid-turn, which steers it as agy does; `cmd <command>` runs a command after asking permission (and `mcp <server> <tool> [arguments as JSON]`
// calls an MCP tool so), and a cancel answers that permission `cancelled`; anything else thinks,
// streams "hello" and ends. `authenticate` takes GEMINI_API_KEY, or `oauth-personal` once $AGY_SIGNIN exists;
// `session/new` with $AGY_SIGNED_OUT refuses. `acp --login` plays Antigravity's sign-in: a Google link, then the code
// `good-code` creates $AGY_SIGNIN.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

if (process.argv[2] === "--version") {
  process.stdout.write("1.5.14\n");
  process.exit(0);
}
// What it was started with, for the node's launch test: $AGY_START gets its argv and environment.
if (process.env.AGY_START) writeFileSync(process.env.AGY_START, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));

if (process.argv.includes("--login")) {
  process.stdout.write("Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?state=fake\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n");
  let got = "";
  process.stdin.setRawMode?.(true);
  process.stdin.on("data", (d: Buffer) => {
    got += d.toString();
    if (!got.includes("\r")) return;
    const ok = got.trim() === "good-code";
    if (ok && process.env.AGY_SIGNIN) writeFileSync(process.env.AGY_SIGNIN, "");
    process.stdout.write(ok ? "\nSigned in.\n" : "\nThat code didn't work.\n");
    process.exit(ok ? 0 : 1);
  });
}

const log = process.env.AGY_LOG;
const write = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
const update = (sessionId: string, u: Record<string, unknown>) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const reply = (id: unknown, result: unknown) => write({ jsonrpc: "2.0", id, result });
const refuse = (id: unknown, code: number, message: string) => write({ jsonrpc: "2.0", id, error: { code, message } });

const CONFIG = [
  { id: "model", category: "model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon" }, { value: "gemini-4-argon" }] },
  { id: "thought_level", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
];
let cancelled: ((how: "cancel" | "steer") => void) | undefined;
const answers = new Map<string, (optionId: string) => void>();
let asked = 0;

async function prompt(id: unknown, sessionId: string, text: string): Promise<void> {
  if (text === "hang") {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
    let mine: ((how: "cancel" | "steer") => void) | undefined;
    const how = await new Promise<"cancel" | "steer">((resolve) => (cancelled = mine = resolve));
    if (cancelled === mine) cancelled = undefined;
    // Steered: agy answers the running prompt at once, with no usage, and the new prompt carries the turn on.
    reply(id, how === "steer" ? { stopReason: "end_turn" } : { stopReason: "cancelled" });
    return;
  }
  if (text.startsWith("cmd ") || text.startsWith("mcp ")) {
    const command = text.slice(4);
    const [server, tool, ...args] = command.split(" ");
    const call = text.startsWith("cmd ")
      ? { toolCallId: "call-1", name: "run_command", kind: "execute", title: command, rawInput: { CommandLine: command } }
      : { toolCallId: "call-1", name: "mcp_tool", kind: "other", title: `Run mcp_${server}_${tool}`, rawInput: { ServerName: server, ToolName: tool, ...(args.length ? { Arguments: args.join(" ") } : {}) } };
    update(sessionId, { sessionUpdate: "tool_call", status: "pending", ...call });
    const rpc = `perm-${++asked}`;
    write({ jsonrpc: "2.0", id: rpc, method: "session/request_permission", params: { sessionId, toolCall: call, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } });
    const chosen = await new Promise<string>((resolve) => answers.set(rpc, resolve));
    // A cancelled turn's permission comes back cancelled: the turn ends so.
    if (chosen === "cancelled") return void reply(id, { stopReason: "cancelled" });
    if (chosen === "allow") update(sessionId, { sessionUpdate: "tool_call_update", status: "completed", ...call, rawOutput: { output: "ran", exit_code: 0 } });
    else update(sessionId, { sessionUpdate: "tool_call_update", status: "failed", ...call, rawOutput: { output: "denied" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chosen } });
    reply(id, { stopReason: "end_turn" });
    return;
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking it over" } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hel" } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
  update(sessionId, { sessionUpdate: "usage_update", used: 10, size: 100 });
  reply(id, { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3, cachedReadTokens: 2, cachedWriteTokens: 0 } });
}

let buf = "";
if (!process.argv.includes("--login")) process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    if (log) appendFileSync(log, `${line}\n`);
    const m = JSON.parse(line);
    const p = m.params ?? {};
    if (m.method === undefined) {
      answers.get(m.id)?.(m.result?.outcome?.optionId ?? m.result?.outcome?.outcome);
      continue;
    }
    switch (m.method) {
      case "initialize":
        reply(m.id, { protocolVersion: 1, agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
        break;
      case "authenticate":
        if (p.methodId === "oauth-personal" && process.env.AGY_SIGNIN && existsSync(process.env.AGY_SIGNIN)) reply(m.id, { _meta: { antigravity: { tier: { name: "Google AI Pro" } } } });
        else if (p.methodId === "gemini-api-key" && process.env.GEMINI_API_KEY) reply(m.id, {});
        else refuse(m.id, -32000, "Authentication required");
        break;
      case "session/new":
        if (process.env.AGY_SIGNED_OUT) refuse(m.id, -32000, "Authentication required");
        else reply(m.id, { sessionId: "agy-1", configOptions: CONFIG });
        break;
      case "session/resume":
        if (p.sessionId === "agy-1") reply(m.id, { configOptions: CONFIG });
        else refuse(m.id, -32602, "conversation not found");
        break;
      case "session/set_config_option":
        reply(m.id, { configOptions: CONFIG });
        break;
      case "session/prompt":
        if (cancelled) {
          // A prompt mid-turn: the running one answers first, then this one carries the turn on.
          cancelled("steer");
          void Bun.sleep(10).then(() => prompt(m.id, p.sessionId, p.prompt?.[0]?.text ?? ""));
        } else void prompt(m.id, p.sessionId, p.prompt?.[0]?.text ?? "");
        break;
      case "session/cancel":
        cancelled?.("cancel");
        break;
      default:
        if (m.id !== undefined) refuse(m.id, -32601, `no ${m.method}`);
    }
  }
});
if (!process.argv.includes("--login")) process.stdin.on("end", () => process.exit(0));
