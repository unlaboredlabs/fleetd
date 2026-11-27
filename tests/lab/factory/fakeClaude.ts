// An offline stand-in for `claude`, for the factory lab (CI has no claude and no network). It speaks the stream-json
// fleetd's node speaks, in the shapes recorded in fleetd/test/fixtures/runner at version.rs TESTED, and
// does no model call: each user message is one turn that runs the message's `lab-run: <shell>` lines in its cwd, one
// Bash tool call each, and replies `lab-ok`; a `lab-slow: <ms>` line waits that long before each call after the first, as
// a slow runner between tool calls; a `lab-stream: <ms>` line streams the reply a word each <ms> (stream events, as claude
// sends with partial messages), a few paragraphs of its own when replies.json has none. Claude overloaded, as the recorded 529s are: a `lab-overloaded: <s>` line retries
// that many seconds (an `api_retry` 529 every 5 s) before the turn goes on. A lab that wants replies of its own (the phone lab's chats) writes replies.json in
// its run dir (FLEETD_LAB_DIR, which kit.ts's wrapper sets): `[[needle, reply], …]`, the first whose needle the message
// holds answers it instead of `lab-ok`. Every user message is filed in the session file claude would write, so
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

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fleetd/test/fixtures/runner");
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
const newMessageId = () => `msg_lab_${randomUUID().replace(/-/gu, "")}`;
const assistant = (content: Array<Msg>, userUuid: string, id = newMessageId()) =>
  out({
    type: "assistant",
    message: { model, id, type: "message", role: "assistant", content, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
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

const cannedReply = (text: string): string | undefined => {
  const file = process.env.FLEETD_LAB_DIR === undefined ? undefined : path.join(process.env.FLEETD_LAB_DIR, "replies.json");
  if (file === undefined || !fs.existsSync(file)) return undefined;
  return (JSON.parse(fs.readFileSync(file, "utf8")) as Array<[string, string]>).find(([needle]) => text.includes(needle))?.[1];
};

/** A `lab-stream` turn's reply when replies.json has none: a few paragraphs, a list and code, as a lead's replies have. */
const STREAMED = [
  "Here is where things stand after this round.",
  "",
  "- The **checkout** fix is merged and the build is on its way out; the canary looks healthy so far.",
  "- Two writers are still on the `inventory` alerts: one on the dedupe, one on the tests that would have caught it.",
  "- The flaky `payments` test failed again on main; I put a reader on it to find out whether it's the clock or the network.",
  "",
  "```ts",
  "const alerted = new Set<string>();",
  "if (stock < threshold && !alerted.has(sku)) alert(sku);",
  "```",
  "",
  "Nothing needs you right now. I'll tell you when the PRs are up, or sooner if a review blocks one.",
].join("\n");

/**
 * Streams `text` a word at a time, `ms` apart, as the stream events claude sends with partial messages on; returns the
 * message's id, which the whole message after them carries too.
 */
const stream = async (text: string, ms: number, userUuid: string): Promise<string> => {
  const id = newMessageId();
  const event = (ev: Msg) => out({ type: "stream_event", event: ev, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), api_message_id: id });
  event({ type: "message_start", message: { model, id, type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const word of text.split(/(?<=\s)/u)) {
    if (interrupted) break;
    await new Promise((r) => setTimeout(r, ms));
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word } });
  }
  event({ type: "content_block_stop", index: 0 });
  event({ type: "message_stop" });
  return id;
};

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
    // A shell that can't start (its cwd deleted under it: `spawn sh ENOENT`) is a failed tool call, as claude reports
    // it, not a crash of the whole session.
    child.on("error", (error) => {
      tool = undefined;
      resolve({ code: 127, output: `${output}${error.message}` });
    });
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
  // A recorded failure (`lab-replay: auth-expired-401`, a fixture's scenario): its output after the request, in this
  // session, then claude's exit as recorded.
  const replay = /^lab-replay: ([a-z0-9-]+)$/mu.exec(text)?.[1];
  if (replay !== undefined) {
    const lines = recorded(`claude-${VERSION}-${replay}.jsonl`);
    const from = lines.findIndex((l) => l.dir === "out" && l.msg.subtype === "status") + 1;
    for (const l of lines.slice(from)) {
      if (l.dir === "meta") {
        current = undefined;
        process.exit(typeof l.msg.exit === "number" ? l.msg.exit : 1);
      }
      if (l.dir !== "out") continue;
      out({ ...l.msg, session_id: sessionId, ...(l.msg.command_uuid === undefined ? {} : { command_uuid: userUuid }) });
    }
    current = undefined;
    return;
  }
  const overloadedS = Number(/^lab-overloaded: (\d+)$/mu.exec(text)?.[1] ?? 0);
  for (let attempt = 1, waited = 0; waited < overloadedS && !interrupted; attempt++, waited += 5) {
    out({ type: "system", subtype: "api_retry", attempt, max_retries: 10, retry_delay_ms: 5000, error_status: 529, error: "overloaded", session_id: sessionId, uuid: randomUUID() });
    await new Promise((r) => setTimeout(r, 5000));
  }
  const commands = [...text.matchAll(/^lab-run: (.+)$/gmu)].map((m) => m[1]!);
  const slowMs = Number(/^lab-slow: (\d+)$/mu.exec(text)?.[1] ?? 0);
  const streamMs = Number(/^lab-stream: (\d+)$/mu.exec(text)?.[1] ?? 0);
  for (const [i, command] of commands.entries()) {
    if (i > 0 && slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
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
  const reply = cannedReply(text) ?? (streamMs > 0 ? STREAMED : "lab-ok");
  const messageId = streamMs > 0 ? await stream(reply, streamMs, userUuid) : undefined;
  if (interrupted) {
    result(userUuid, startedMs, null, true);
    lifecycle(userUuid, "cancelled");
    return;
  }
  assistant([{ type: "text", text: reply }], userUuid, messageId);
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
