// A stand-in for `agy acp`: just enough of Antigravity's ACP server for the runner's tests, with no Google behind it.
// Every request it gets goes to $AGY_LOG, one JSON line each. A prompt's text picks what the turn does:
// `hang` waits for session/cancel; `cmd <command>` runs a command after asking permission; anything else thinks,
// streams "hello" and ends. Without GEMINI_API_KEY, `authenticate` and a `session/new` with $AGY_SIGNED_OUT refuse.
import { appendFileSync } from "node:fs";

const log = process.env.AGY_LOG;
const write = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
const update = (sessionId: string, u: Record<string, unknown>) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const reply = (id: unknown, result: unknown) => write({ jsonrpc: "2.0", id, result });
const refuse = (id: unknown, code: number, message: string) => write({ jsonrpc: "2.0", id, error: { code, message } });

const CONFIG = [
  { id: "model", category: "model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon" }, { value: "gemini-4-argon" }] },
  { id: "thought_level", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
];
let cancelled: (() => void) | undefined;
const answers = new Map<string, (optionId: string) => void>();
let asked = 0;

async function prompt(id: unknown, sessionId: string, text: string): Promise<void> {
  if (text === "hang") {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
    await new Promise<void>((resolve) => (cancelled = resolve));
    reply(id, { stopReason: "cancelled" });
    return;
  }
  if (text.startsWith("cmd ")) {
    const command = text.slice(4);
    const call = { toolCallId: "call-1", name: "run_command", kind: "execute", title: command, rawInput: { CommandLine: command } };
    update(sessionId, { sessionUpdate: "tool_call", status: "pending", ...call });
    const rpc = `perm-${++asked}`;
    write({ jsonrpc: "2.0", id: rpc, method: "session/request_permission", params: { sessionId, toolCall: call, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } });
    const chosen = await new Promise<string>((resolve) => answers.set(rpc, resolve));
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
process.stdin.on("data", (chunk: Buffer) => {
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
      answers.get(m.id)?.(m.result?.outcome?.optionId);
      continue;
    }
    switch (m.method) {
      case "initialize":
        reply(m.id, { protocolVersion: 1, agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
        break;
      case "authenticate":
        if (process.env.GEMINI_API_KEY) reply(m.id, {});
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
        void prompt(m.id, p.sessionId, p.prompt?.[0]?.text ?? "");
        break;
      case "session/cancel":
        cancelled?.();
        break;
      default:
        if (m.id !== undefined) refuse(m.id, -32601, `no ${m.method}`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
