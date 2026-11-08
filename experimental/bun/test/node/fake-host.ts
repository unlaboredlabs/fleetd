// A stand-in for the Rust binary's `fleetd session-host`, for tests without it: `bun fake-host.ts session-host <dir>
// <session id> -- <program> <args…>`. It registers in <dir> (host.json), serves <dir>/sock with the host's lines
// ({"seq","event"} out, {"ack"} / {"command"} / "stop" in), and plays a claude that answers each Send with one run:
// RunStarted, an AssistantText "ok: <text>", RunEnded Completed. A Send whose text holds `ask:` asks permission for
// Bash first and ends its run once answered. Shutdown exits.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const [, dir, session] = argv;
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const model = flag("--model") ?? "";
if (!dir || !session) {
  // As the Rust binary answers it: what a node checks to know a session host (src/node/runner/helper.ts).
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
          if (text.includes("refuse-model:") && model !== "claude-opus-5-5") {
            emit({ RunEnded: { run_id, outcome: { Failed: { class: "invalid_request", message: `model ${model} not found`, apiStatus: 404, retries: 0, model } }, usage: null } });
            continue;
          }
          if (text.includes("spans:"))
            emit({ Spans: [1, 2, 3].map((n) => ({ key: `${run_id}/${n}`, kind: "run", sessionId: session, runId: run_id, startMs: n, endMs: n + 1, status: "ok" })) });
          if (text.includes("monitor:")) {
            const at = new Date().toISOString();
            emit({ Item: { id: `mon-${run_id}`, runId: run_id, status: "completed", title: "Monitor", startedAt: at, completedAt: at, updatedAt: at, kind: { type: "tool", toolName: "Monitor", input: { description: "ci", timeout_ms: 600000 } } } });
          }
          if (text.includes("hang:")) {
            // A turn whose stream went quiet: it ends only when interrupted.
            waiting = { run: run_id, text: "" };
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
writeFileSync(join(dir, "host.json"), JSON.stringify({ protocol: 1, hostPid: process.pid, hostStart: null, pid: process.pid, start: null, marker: process.env.FLEETD_RUNNER_SESSION ?? "" }));
