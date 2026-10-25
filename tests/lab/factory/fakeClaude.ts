// An offline stand-in for `claude`, for the factory lab (CI has no claude and no network). It speaks the stream-json
// fleetd's node speaks, in the shapes recorded in crates/fleetd/src/node/runner/fixtures at version.rs TESTED, and
// does no model call: each user message is one turn that runs the message's `lab-run: <shell>` lines in its cwd, one
// Bash tool call each, and replies `lab-ok`. Every user message is filed in the session file claude would write, so
// scenarios read what an agent was told (its brief, a lead's digest, a recovery note) as for the real claude.
//
// usage (from the `claude` wrapper kit.ts writes): node fakeClaude.ts <claude args…>
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

type Msg = Record<string, any>;

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../crates/fleetd/src/node/runner/fixtures");
const recorded = (file: string) =>
  fs
    .readFileSync(path.join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { dir: string; msg: Msg });
const VERSION = recorded("claude-2.1.302-resume.jsonl").find((l) => l.dir === "meta")!.msg.claude as string;

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}

const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? randomUUID();
const model = flag("--model") ?? "claude-opus-5-5";
const cwd = process.cwd();
// Where claude files a session: <config dir>/projects/<cwd with every non-alphanumeric as ->/<session>.jsonl.
const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? cwd, ".claude");
const sessionFile = path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/gu, "-"), `${sessionId}.jsonl`);

const out = (msg: Msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const file = (entry: Msg) => {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.appendFileSync(sessionFile, `${JSON.stringify({ ...entry, sessionId, cwd, timestamp: new Date().toISOString() })}\n`);
};

// The recorded initialize answer, logged in with an API key so the node takes this claude as ready.
const initializeAnswer = (requestId: string): Msg => {
  const probe = recorded("claude-2.1.302-initialize-probe.jsonl").find((l) => l.dir === "out")!.msg;
  const response = { ...probe.response.response, account: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }, pid: process.pid };
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
};
// The recorded `system/init`, for this session and cwd, without the tools fleetd denied (as claude leaves them out).
const recordedInit = recorded("claude-2.1.302-resume.jsonl").find((l) => l.dir === "out" && l.msg.type === "system" && l.msg.subtype === "init")!.msg;
/** A list flag's values: one argv element each, up to the next flag. */
const values = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const end = args.findIndex((a, j) => j > i && a.startsWith("--"));
  return args.slice(i + 1, end < 0 ? undefined : end);
};
const denied = new Set(values("--disallowedTools"));
const tools = (recordedInit.tools as Array<string>).filter((t) => !denied.has(t));
const init = (): Msg => ({ ...recordedInit, tools, session_id: sessionId, cwd, original_cwd: cwd, model, uuid: randomUUID() });

const lifecycle = (command: string, state: string) => out({ type: "command_lifecycle", command_uuid: command, state, uuid: randomUUID(), session_id: sessionId });
const assistant = (content: Array<Msg>, userUuid: string) =>
  out({
    type: "assistant",
    message: { model, id: `msg_lab_${randomUUID().replace(/-/gu, "")}`, type: "message", role: "assistant", content, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
    user_message_uuid: userUuid,
    user_message_uuids: [userUuid],
  });
const result = (userUuid: string, startedMs: number, text: string | null, interrupted: boolean) =>
  out({
    type: "result",
    subtype: interrupted ? "error_during_execution" : "success",
    is_error: interrupted,
    result: text,
    terminal_reason: interrupted ? "aborted_tools" : "completed",
    stop_reason: interrupted ? "tool_use" : "end_turn",
    duration_ms: Date.now() - startedMs,
    duration_api_ms: 0,
    num_turns: 1,
    session_id: sessionId,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    user_message_uuid: userUuid,
    user_message_uuids: [userUuid],
    uuid: randomUUID(),
  });

/** The running turn's user message, and its tool's process (its own group, as claude's Bash tool). */
let current: string | undefined;
let tool: ChildProcess | undefined;
let interrupted = false;

const bash = (command: string) =>
  new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    tool = child;
    let output = "";
    child.stdout!.on("data", (d) => (output += String(d)));
    child.stderr!.on("data", (d) => (output += String(d)));
    child.on("close", (code) => {
      tool = undefined;
      resolve({ code, output });
    });
  });

const turn = async (msg: Msg) => {
  const userUuid = msg.uuid as string;
  const text = typeof msg.message?.content === "string" ? (msg.message.content as string) : JSON.stringify(msg.message?.content);
  const startedMs = Date.now();
  interrupted = false;
  current = userUuid;
  file({ type: "user", message: { role: "user", content: text }, uuid: userUuid });
  lifecycle(userUuid, "started");
  out(init());
  out({ type: "system", subtype: "status", status: "requesting", session_id: sessionId, uuid: randomUUID(), user_message_uuids: [userUuid] });
  const commands = [...text.matchAll(/^lab-run: (.+)$/gmu)].map((m) => m[1]!);
  for (const command of commands) {
    if (interrupted) break;
    const id = `toolu_lab_${randomUUID().replace(/-/gu, "")}`;
    assistant([{ type: "tool_use", id, name: "Bash", input: { command } }], userUuid);
    const { code, output } = await bash(command);
    const content = interrupted ? "The user doesn't want to proceed with this tool use." : `${output}${code === 0 ? "" : `\nexit ${code}`}`;
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: interrupted || code !== 0 }] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
  }
  current = undefined;
  if (interrupted) {
    result(userUuid, startedMs, null, true);
    lifecycle(userUuid, "cancelled");
    return;
  }
  const reply = "lab-ok";
  assistant([{ type: "text", text: reply }], userUuid);
  file({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
  result(userUuid, startedMs, reply, false);
  lifecycle(userUuid, "completed");
};

// One turn at a time, in arrival order, as claude queues messages behind a running turn.
let queue = Promise.resolve();
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  const msg = JSON.parse(line) as Msg;
  if (msg.type === "user") {
    lifecycle(msg.uuid as string, "queued");
    queue = queue.then(() => turn(msg));
  } else if (msg.type === "control_request") {
    const subtype = msg.request?.subtype as string;
    if (subtype === "initialize") {
      out(initializeAnswer(msg.request_id as string));
      return;
    }
    // An interrupt ends the running turn as cancelled, between tool calls as well as during one.
    if (subtype === "interrupt" && current !== undefined) {
      interrupted = true;
      if (tool?.pid !== undefined) {
        try {
          process.kill(-tool.pid, "SIGKILL");
        } catch {
          // Ended on its own meanwhile.
        }
      }
    }
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { still_queued: [] } } });
  }
});
lines.on("close", () => void queue.then(() => process.exit(0)));
