// A stand-in for `fleetd session-host` (src/node/runner/host/serve.ts) that plays its claude too: `bun fake-host.ts session-host <dir>
// <session id> -- <program> <args…>`. It registers in <dir> (host.json), serves <dir>/sock with the host's lines
// ({"seq","event"} out, {"ack"} / {"command"} / "stop" in), and plays a claude that answers each Send with one run:
// RunStarted, an AssistantText "ok: <text>", RunEnded Completed. A Send whose text holds `ask:` asks permission for
// Bash first and ends its run once answered; one with `auth:` fails as a refused login; one with `print:<NAME>` runs a
// command that prints that variable whole and line by line (as `env | cut -d= -f1` does), files it in claude's own
// conversation file as claude would, and answers with what it printed. Shutdown exits. Its environment goes to
// <dir>/env.json, its arguments to <dir>/argv.json. SIGTERM (its scope stopped with the machine's whole session) kills the scripts
// of the Monitors it armed: claude queues each one's notice, then exits before any turn takes it.
import { appendFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const [, dir, session] = argv;
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const model = flag("--model") ?? "";
if (!dir || !session) {
  // As `fleetd session-host` answers it.
  console.error("usage: fleetd session-host <dir> <session id> -- <program> <args…>");
  process.exit(2);
}
// As the Rust host: its dir is the node's to make (launch makes it); one swept away is no host.
if (!existsSync(dir)) process.exit(1);
const kept: [number, string][] = [];
let seq = 0;
let conn: Bun.Socket<undefined> | undefined;
const emit = (event: unknown) => {
  const line = JSON.stringify({ seq: ++seq, event });
  kept.push([seq, line]);
  conn?.write(`${line}\n`);
};
let waiting: { run: string; text: string } | undefined;
const queued: { run: string; text: string }[] = [];
const armed: string[] = [];
const answer = (run: string, text: string) => {
  emit({ AssistantText: { message_id: `msg-${run}`, text: `ok: ${text}` } });
  emit({ RunEnded: { run_id: run, outcome: { Completed: { text: `ok: ${text}` } }, usage: null } });
};
const exit = () => {
  emit({ Exited: { code: 0, signal: null, stderr_tail: "" } });
  setTimeout(() => process.exit(0), 200);
};
const sock = join(dir, "sock");
rmSync(sock, { force: true });
let buf = "";
const decoder = new TextDecoder();
Bun.listen({
  unix: sock,
  socket: {
    open(s) {
      conn = s;
      for (const [, line] of kept) s.write(`${line}\n`);
    },
    data(_s, chunk) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (line === "stop") return exit();
        if (line.ack !== undefined) {
          while (kept.length && kept[0]![0] <= line.ack) kept.shift();
          continue;
        }
        const cmd = line.command;
        if (cmd === "Interrupt" && waiting) {
          emit({ RunEnded: { run_id: waiting.run, outcome: "Interrupted", usage: null } });
          waiting = undefined;
        } else if (cmd?.Withdraw) {
          const at = queued.findIndex((q) => q.run === cmd.Withdraw.run_id);
          if (at >= 0) queued.splice(at, 1);
          emit({ Withdrawn: { run_id: cmd.Withdraw.run_id, cancelled: at >= 0, by_stop: false } });
          if (at >= 0) emit({ RunEnded: { run_id: cmd.Withdraw.run_id, outcome: "Interrupted", usage: null } });
        } else if (cmd?.Send && waiting) {
          queued.push({ run: cmd.Send.run_id, text: cmd.Send.text });
        } else if (cmd?.Send) {
          const { run_id, text } = cmd.Send;
          emit({ RunStarted: { run_id } });
          // `flaky:` fails its first try as claude does when the network drops; `refuse-model:` fails while claude
          // runs on any model but the profile's own.
          if (text.includes("flaky:")) {
            emit({ RunEnded: { run_id, outcome: { Failed: { class: "network", message: "Connection error.", retries: 0 } }, usage: null } });
            continue;
          }
          if (text.includes("auth:")) {
            emit({ RunEnded: { run_id, outcome: { Failed: { class: "auth", message: "Failed to authenticate. API Error: 401 OAuth token has expired.\nmore", retries: 0 } }, usage: null } });
            continue;
          }
          if (text.includes("refuse-model:") && model !== "claude-opus-5-5") {
            emit({ RunEnded: { run_id, outcome: { Failed: { class: "invalid_request", message: `model ${model} not found`, apiStatus: 404, retries: 0, model } }, usage: null } });
            continue;
          }
          if (text.includes("spans:"))
            emit({ Spans: [1, 2, 3].map((n) => ({ key: `${run_id}/${n}`, kind: "run", sessionId: session, runId: run_id, startMs: Date.now() + n, endMs: Date.now() + n + 1, status: "ok" })) });
          // `monitor:` arms a Monitor for 10 minutes; `monitor-ms=<n>:` for n ms.
          const monitorMs = /monitor-ms=(\d+):/.exec(text)?.[1];
          if (text.includes("monitor:") || monitorMs !== undefined) {
            const at = new Date().toISOString();
            const input = { description: "ci", timeout_ms: monitorMs === undefined ? 600000 : Number(monitorMs) };
            emit({ Item: { id: `mon-${run_id}`, runId: run_id, status: "completed", title: "Monitor", startedAt: at, completedAt: at, updatedAt: at, kind: { type: "tool", toolName: "Monitor", input } } });
            armed.push(`mon-${run_id}`);
          }
          if (text.includes("hang:")) {
            // A turn whose stream went quiet: it ends only when interrupted.
            waiting = { run: run_id, text: "" };
            continue;
          }
          const printed = /print:([A-Z_]+)/.exec(text)?.[1];
          if (printed !== undefined) {
            const value = process.env[printed] ?? "";
            const output = `${value}\n${`${printed}=${value}`.split("\n").map((l) => l.split("=")[0]).join("\n")}\n`;
            const at = new Date().toISOString();
            const tool = `cmd-${run_id}`;
            emit({ Item: { id: tool, runId: run_id, status: "completed", title: "Bash", startedAt: at, completedAt: at, updatedAt: at, kind: { type: "command", command: `printenv ${printed}; env | cut -d= -f1`, output, exitCode: 0 } } });
            const config = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude");
            const project = join(config, "projects", realpathSync(process.cwd()).replace(/[^A-Za-z0-9]/g, "-"));
            mkdirSync(project, { recursive: true });
            for (const entry of [
              { type: "assistant", sessionId: session, message: { role: "assistant", content: [{ type: "tool_use", id: tool, name: "Bash", input: { command: `printenv ${printed}` } }] } },
              { type: "user", sessionId: session, message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: output }] } },
            ])
              appendFileSync(join(project, `${session}.jsonl`), `${JSON.stringify(entry)}\n`);
            emit({ AssistantText: { message_id: `msg-${run_id}`, text: `it printed:\n${output}` } });
            emit({ RunEnded: { run_id, outcome: { Completed: { text: `it printed:\n${output}` } }, usage: null } });
            continue;
          }
          if (text.includes("ask:")) {
            waiting = { run: run_id, text };
            emit({ PermissionRequest: { request_id: `req-${run_id}`, tool_use_id: "tu1", tool_name: "Bash", input: { command: "ls" }, summary: "ls" } });
          } else answer(run_id, text);
        } else if (cmd?.Answer && waiting) {
          const w = waiting;
          waiting = undefined;
          answer(w.run, w.text);
          for (const q of queued.splice(0)) {
            emit({ RunStarted: { run_id: q.run } });
            answer(q.run, q.text);
          }
        } else if (cmd?.Shutdown) exit();
      }
    },
    close() {
      conn = undefined;
    },
  },
});
process.on("SIGTERM", () => {
  for (const id of armed.splice(0)) emit({ WatchEnded: { tool_use_id: id } });
  emit({ Exited: { code: null, signal: 15, stderr_tail: "" } });
  setTimeout(() => process.exit(143), 200);
});
// What the session's claude would have been started with, for tests to read.
writeFileSync(join(dir, "env.json"), JSON.stringify(process.env));
writeFileSync(join(dir, "argv.json"), JSON.stringify(argv));
writeFileSync(join(dir, "host.json"), JSON.stringify({ protocol: 1, hostPid: process.pid, hostStart: null, pid: process.pid, start: null, marker: process.env.FLEETD_RUNNER_SESSION ?? "" }));
