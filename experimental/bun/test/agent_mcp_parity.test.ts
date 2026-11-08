// agent-mcp against the Rust binary's: the same lines on stdin, through the same fake node, give the same bytes on
// stdout and the same frames on the node's socket. Needs a Rust `fleetd` built from this tree: FLEETD_RUST_BIN, or
// target/{debug,release}/fleetd at the repo's root; without one these tests are skipped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOT } from "../src/cli/agent_mcp/tools.ts";
import { snapshot } from "../src/cli/agent_mcp/snapshot.ts";
import { tempHome } from "./helpers.ts";

const ROOT = join(import.meta.dir, "../../..");
const RUST =
  process.env.FLEETD_RUST_BIN ??
  [join(ROOT, "target/release/fleetd"), join(ROOT, "target/debug/fleetd")].find((path) => existsSync(path));
const MAIN = join(import.meta.dir, "../src/main.ts");

type Line = Record<string, unknown> | string;

/** A fake node on a unix socket: records each frame and answers with the next of `answers`. */
function fakeNode(path: string) {
  const state = { frames: [] as Record<string, unknown>[], answers: [] as unknown[] };
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        state.frames.push({ ...frame, id: "cli-<pid>" });
        const answer = state.answers.shift();
        if (answer === "close") return void socket.end();
        socket.write(typeof answer === "string" ? `${answer}\n` : `${JSON.stringify({ ...(answer as object), id: frame.id })}\n`);
      },
    },
  });
  return { state, stop: () => server.stop(true) };
}

let home: ReturnType<typeof tempHome>;
let node: ReturnType<typeof fakeNode>;
let sock: string;

beforeAll(() => {
  home = tempHome();
  sock = join(home.dir, "node.sock");
  node = fakeNode(sock);
  mkdirSync(join(home.dir, "work"), { recursive: true });
  writeFileSync(join(home.dir, "work/report.html"), "<h1>hi</h1>");
  writeFileSync(join(home.dir, "work/empty.md"), "");
  writeFileSync(join(home.dir, "work/bad.md"), Buffer.from([0xff, 0xfe, 0x00]));
});
afterAll(() => {
  node?.stop();
  home?.done();
});

/** Runs `binary agent-mcp --role <role>` (Bun's from source when `binary` is undefined) on `lines`. */
async function run(binary: string | undefined, role: string, lines: Line[], answers: unknown[]) {
  node.state.frames = [];
  node.state.answers = [...answers];
  const cmd = binary ? [binary, "agent-mcp", "--role", role] : [process.execPath, MAIN, "agent-mcp", "--role", role];
  const proc = Bun.spawn(cmd, {
    stdin: Buffer.from(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n"),
    stdout: "pipe",
    stderr: "pipe",
    cwd: join(home.dir, "work"),
    env: {
      PATH: process.env.PATH ?? "",
      FLEETD_HOME: home.dir,
      FLEETD_NODE_SOCK: sock,
      FLEETD_THREAD_ID: "thread-1",
      PWD: join(home.dir, "work"),
      FLEETD_VERSION: rustVersion,
    },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code, frames: node.state.frames };
}

let rustVersion = "0.0.0";
const call = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** Bad values for every field of every tool's schema, and a few whole-call cases. */
function invalidCorpus(): { role: string; lines: Line[] }[] {
  const out: { role: string; lines: Line[] }[] = [];
  for (const role of ["lead", "worker"]) {
    const lines: Line[] = [];
    let id = 0;
    const tools = SNAPSHOT.tools.filter((t) => (role === "lead" ? t.lead : t.worker));
    for (const tool of tools) {
      lines.push(call(++id, tool.name, {}), call(++id, tool.name, [1]), call(++id, tool.name, "x"));
      const walk = (schema: Record<string, unknown>, wrap: (v: unknown) => unknown) => {
        const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
        for (const [key, sub] of Object.entries(props)) {
          const inner = (v: unknown) => wrap({ [key]: v });
          for (const bad of [5, -1, 1.5, "x", "", "!", "a\nb", "x".repeat(1001), true, null, [], {}, ["!"], [{}], 9007199254740993]) {
            lines.push(call(++id, tool.name, inner(bad)));
          }
          if (sub.type === "object") walk(sub, inner);
          const items = sub.items as Record<string, unknown> | undefined;
          if (items?.type === "object") walk(items, (v) => inner([v]));
        }
      };
      walk(tool.inputSchema, (v) => v);
    }
    out.push({ role, lines });
  }
  return out;
}

describe.skipIf(!RUST)("agent-mcp matches the Rust binary", () => {
  beforeAll(() => {
    const line = Bun.spawnSync([RUST!, "version"]).stdout.toString();
    rustVersion = /\(([^,]+), protocol/.exec(line)?.[1] ?? "0.0.0";
  });

  test("tools.json is what the Rust binary lists and how it refuses", () => {
    // The version line names the binary, which can be any build of this tree: only the tools and probes must match.
    expect({ ...snapshot(RUST!), rust: SNAPSHOT.rust }).toEqual(SNAPSHOT);
  });

  test("the protocol: initialize, ping, tools/list, a notification, an unknown method", async () => {
    for (const role of ["lead", "worker"]) {
      const lines: Line[] = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
        { jsonrpc: "2.0", id: "two", method: "initialize" },
        { jsonrpc: "2.0", id: null, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 3, method: "tools/list" },
        { jsonrpc: "2.0", id: 4, method: "resources/list" },
        { jsonrpc: "2.0", id: 5 },
        "   ",
        "[1,2]",
        "5",
        { jsonrpc: "2.0", id: 6, method: "tools/call" },
        { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } },
      ];
      const [rust, bun] = [await run(RUST, role, lines, []), await run(undefined, role, lines, [])];
      expect(bun.stdout).toBe(rust.stdout);
      expect(bun.code).toBe(rust.code);
    }
  });

  test("every field's bad values are refused in the same words", async () => {
    for (const { role, lines } of invalidCorpus()) {
      // Calls that pass the checks reach the node, which says the same thing to both.
      const answers = Array.from({ length: lines.length }, () => ({ t: "lead_result", error: { code: "failed", message: "no" } }));
      const [rust, bun] = [await run(RUST, role, lines, answers), await run(undefined, role, lines, answers)];
      const r = rust.stdout.split("\n");
      const b = bun.stdout.split("\n");
      const differ = r.map((line, i) => [lines[i], line, b[i]]).filter(([, x, y]) => x !== y);
      expect(differ).toEqual([]);
      expect(bun.frames).toEqual(rust.frames);
    }
  }, 60_000);

  test("calls reach the node as the same frames, and its answers come back in the same words", async () => {
    const B = (n: number) => `B${String(n).repeat(32)}`;
    const files = [{ file: "video", bytes: 10 }, { file: "actions", bytes: 2 }];
    const lead: [Line, unknown][] = [
      [call(1, "agents", { state: "running" }), { t: "lead_result", result: { op: "task_list", tasks: [], truncated: true, next: "Wait." } }],
      [call(2, "automation_pause", { automationId: "au_abcdef", paused: true }), { t: "lead_result", error: { code: "failed", message: "no", fix: "do this" } }],
      [call(3, "chat_image", { path: "x.png" }), { t: "lead_result", error: { code: "failed", message: "no" } }],
      [call(4, "publish_artifact", { name: "r", title: "R", path: "report.html" }), { t: "lead_result", result: { op: "artifact_publish", name: "r", version: 2 } }],
      [call(5, "publish_artifact", { name: "r", title: "R", path: "empty.md" }), undefined],
      [call(6, "publish_artifact", { name: "r", title: "R", path: "bad.md" }), undefined],
      [call(7, "publish_artifact", { name: "r", title: "R", path: "none.md" }), undefined],
      [call(8, "publish_artifact", { name: "r", title: "R" }), undefined],
      [call(9, "publish_artifact", { name: "r", title: "R", path: "/" }), undefined],
      [call(10, "publish_artifact", { name: "r", title: "R", content: "inline", path: "none.md" }), { t: "lead_result", result: { op: "artifact_publish", name: "r", version: 1 } }],
      [call(11, "session_start", { purpose: "p" }), { t: "browser_result", result: { op: "session_start", sessionId: B(1), startMs: 812, cdp: "ws://x" } }],
      [call(12, "session_start", { purpose: "p", kind: "android" }), { t: "browser_result", result: { op: "session_start", sessionId: B(2), startMs: 9, serial: "emulator-5554" } }],
      [call(13, "session_start", { purpose: "p", kind: "ios" }), { t: "browser_result", result: { op: "session_start", sessionId: B(3), startMs: 9, udid: "U" } }],
      [call(14, "session_start", { purpose: "p", kind: "mac" }), { t: "browser_result", result: { op: "session_start", sessionId: B(4), startMs: 0, desktop: "mac", heldBy: "T9 until it ends" } }],
      [call(15, "session_start", { purpose: "p", kind: "mac" }), { t: "browser_result", result: { op: "session_start", sessionId: B(5), startMs: 0, desktop: "mac" } }],
      [call(16, "session_start", { purpose: "p", kind: "linux_desktop" }), { t: "browser_result", result: { op: "session_start", sessionId: B(6), startMs: 5, desktop: "container", worktree: "/w" } }],
      [call(17, "session_start", { purpose: "p", kind: "linux_desktop" }), { t: "browser_result", result: { op: "session_start", sessionId: B(7), startMs: 5, desktop: "container" } }],
      [call(18, "session_start", { purpose: "p", kind: "linux_desktop" }), { t: "browser_result", result: { op: "session_start", sessionId: B(8), startMs: 5, desktop: "xvfb" } }],
      [call(19, "desktop", { action: "screenshot" }), { t: "browser_result", result: { op: "desktop", message: "1280x800", jpegB64: "AAAA", width: 1280, height: 800 } }],
      [call(20, "desktop", { action: "wait" }), { t: "browser_result", result: { op: "desktop", message: "waited" } }],
      [call(21, "session_end", {}), { t: "browser_result", result: { op: "session_end", sessionId: B(4), kind: "mac", files } }],
      [call(22, "session_end", {}), { t: "browser_result", result: { op: "session_end", sessionId: B(6), kind: "linux_desktop", files, note: "slow" } }],
      [call(23, "session_end", {}), { t: "browser_result", result: { op: "session_end", sessionId: B(2), kind: "android", files: [] } }],
      [call(24, "session_end", {}), { t: "browser_result", result: { op: "session_end", sessionId: B(3), kind: "ios", files, note: "n" } }],
      [call(25, "session_end", {}), { t: "browser_result", result: { op: "session_end", sessionId: B(1), files } }],
      [call(26, "request_takeover", { reason: "captcha" }), { t: "browser_result", result: { op: "request_takeover", message: "They have it." } }],
      [call(27, "request_takeover", { reason: "captcha" }), { t: "browser_result", error: { code: "failed", message: "no session" } }],
      [call(28, "agents", {}), "not json"],
      [call(29, "agents", {}), { t: "lead_call", call: {} }],
      [call(30, "agents", {}), { t: "lead_result", result: { op: "task_list", tasks: [] }, error: { code: "failed", message: "x" } }],
      [call(31, "agents", {}), { t: "lead_result" }],
      [call(32, "agents", {}), { t: "held", steps: 2 }],
      [call(33, "agents", {}), "close"],
      [call(34, "agents", {}), { t: "lead_result", result: null, error: { code: "failed", message: "x" } }],
    ];
    const worker: [Line, unknown][] = [
      [call(1, "report", { blocking: 0, nonBlocking: 1, summary: "ok" }), { t: "lead_result", error: { code: "forbidden", message: "not a reviewer" } }],
      [call(2, "spawn_agent", {}), undefined],
      [call(3, "ask_lead", { question: "why?" }), { t: "lead_result", result: { op: "ask_lead", taskId: "T4", next: "End your turn." } }],
    ];
    for (const [role, cases] of [["lead", lead], ["worker", worker]] as const) {
      const lines = cases.map(([line]) => line);
      const answers = cases.map(([, answer]) => answer).filter((a) => a !== undefined);
      const [rust, bun] = [await run(RUST, role, lines, answers), await run(undefined, role, lines, answers)];
      expect(bun.stdout.split("\n")).toEqual(rust.stdout.split("\n"));
      expect(bun.frames).toEqual(rust.frames);
    }
  }, 30_000);

  test("a bad role is refused with the same usage and code", async () => {
    for (const argv of [[], ["--role"], ["--role", "admin"], ["--role", "lead", "x"]]) {
      const rust = Bun.spawnSync([RUST!, "agent-mcp", ...argv], { env: { FLEETD_HOME: home.dir } });
      const bun = Bun.spawnSync([process.execPath, MAIN, "agent-mcp", ...argv], { env: { FLEETD_HOME: home.dir } });
      expect([bun.exitCode, bun.stderr.toString(), bun.stdout.toString()]).toEqual([
        rust.exitCode,
        rust.stderr.toString(),
        rust.stdout.toString(),
      ]);
    }
  });
});
