// Re-records the runner's stream-json fixtures (crates/fleetd/src/node/runner/fixtures) from the installed `claude`,
// for a maintainer bumping TESTED in node/runner/version.rs. Never in CI. About 11 tiny haiku turns through the
// user's own claude login; the error scenarios instead point claude at a local stub that answers every request with
// a fixed error and forwards nothing. The documented usage-limit fixture is built from the Agent SDK's types and is
// not re-recorded.
//
//   node failure/recordFixtures.ts [--out <dir>] [--only name,name]     (in tests/lab; FLEETD_LAB_SLOT as usual)
//
// Files are written as claude-<version>-<name>.jsonl, one {"dir","ms","msg"|"raw"} object per line, with the scratch
// project at /work/project, the config dir at /work/claude-config and the login's values redacted.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { claudeLoginEnv, descendants, LAB, log, type ProcInfo, scrubbedEnv } from "../harness.ts";
import { FIXTURES, killSurvivors } from "./kit.ts";

type Msg = Record<string, any>;
type StubMode = "auth" | "overloaded" | "server" | "ratelimit" | "usage" | "refused";

interface Scenario {
  readonly name: string;
  /** Which recorded session it runs in; a later scenario with the same key resumes or reuses it. */
  readonly session: string;
  readonly start: "session-id" | "resume";
  readonly turns: ReadonlyArray<string>;
  readonly extra?: ReadonlyArray<string>;
  readonly model?: string;
  readonly initialize?: boolean;
  readonly answer?: "allow" | "deny";
  /** What to do 1.5 s after the first tool_use. */
  readonly onTool?: "interrupt" | "sigterm" | "sigkill-group";
  /** `empty`: an empty config dir and no login variables. */
  readonly login?: "empty" | { readonly stub: StubMode };
}

const MANUAL = ["--permission-prompt-tool", "stdio", "--permission-mode", "manual"];
const SLEEP = ["--permission-prompt-tool", "stdio", "--allowedTools", "Bash(sleep:*)"];
const SLEEP_TURN = "Use the Bash tool to run `sleep 30`, then reply DONE.";
const stub = (name: string, mode: StubMode): Scenario => ({ name, session: name, start: "session-id", turns: ["Reply OK."], login: { stub: mode } });

const SCENARIOS: ReadonlyArray<Scenario> = [
  { name: "init-partial-two-turns", session: "a", start: "session-id", initialize: true, turns: ["Reply with the word OK and nothing else.", "Reply with the word TWO and nothing else."] },
  { name: "resume", session: "a", start: "resume", turns: ["Which single words did you reply with before? Answer in one line."] },
  { name: "session-id-in-use", session: "a", start: "session-id", turns: ["Reply OK."] },
  { name: "permission-allow", session: "allow", start: "session-id", extra: MANUAL, answer: "allow", turns: ["Use the Bash tool to run `touch perm-test.txt`, then reply DONE."] },
  {
    name: "permission-deny",
    session: "deny",
    start: "session-id",
    extra: MANUAL,
    answer: "deny",
    turns: ["Use the Bash tool to run `touch perm-test.txt`, then reply DONE. If it is denied, reply DENIED and stop."],
  },
  {
    name: "allowlisted-tool",
    session: "allowlisted",
    start: "session-id",
    extra: [...MANUAL, "--allowedTools", "Bash(echo:*)"],
    turns: ["Use the Bash tool to run `echo hi`, then reply with its output only."],
  },
  { name: "interrupt-mid-tool", session: "interrupt", start: "session-id", extra: SLEEP, onTool: "interrupt", turns: [SLEEP_TURN] },
  { name: "sigterm-mid-tool", session: "term", start: "session-id", extra: SLEEP, onTool: "sigterm", turns: [SLEEP_TURN] },
  { name: "sigkill-mid-tool", session: "b", start: "session-id", extra: SLEEP, onTool: "sigkill-group", turns: [SLEEP_TURN] },
  { name: "resume-after-kill", session: "b", start: "resume", turns: ["Your last command was cut off. Do not rerun it. Reply with the word RESUMED only."] },
  { name: "compact-manual", session: "a", start: "resume", turns: ["/compact"] },
  { name: "invalid-model", session: "bad-model", start: "session-id", model: "claude-does-not-exist-9", turns: ["Reply OK."] },
  { name: "not-logged-in", session: "not-logged-in", start: "session-id", login: "empty", turns: ["Reply OK."] },
  stub("auth-expired-401", "auth"),
  stub("overloaded-529", "overloaded"),
  stub("server-500", "server"),
  stub("rate-limit-429", "ratelimit"),
  stub("usage-429-api-key", "usage"),
  stub("network-refused", "refused"),
];

/** Python's json.dumps(ensure_ascii=False) layout, which the existing fixtures use, so a re-record diffs by content. */
const pyJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  if (v !== null && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(", ")}}`;
  return JSON.stringify(v) ?? "null";
};

/** A local endpoint that answers every request with one fixed error. It never forwards anywhere. */
const startStub = async () => {
  let mode: StubMode = "overloaded";
  const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
  const errors: Record<Exclude<StubMode, "refused">, [number, string, string, Record<string, string>]> = {
    overloaded: [529, "overloaded_error", "Overloaded", {}],
    server: [500, "api_error", "Internal server error", {}],
    ratelimit: [429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit", { "retry-after": "1" }],
    usage: [
      429,
      "rate_limit_error",
      "This request would exceed your account's rate limit. Please try again later.",
      {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(reset),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-reset": String(reset),
      },
    ],
    auth: [401, "authentication_error", "OAuth token has expired. Please obtain a new token or refresh your existing token.", {}],
  };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", "request-id": "req_stub", ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST") return reply(404, { type: "error", error: { type: "not_found_error", message: "stub" } });
      if (req.url?.includes("count_tokens")) return reply(200, { input_tokens: 10 });
      const [status, type, message, headers] = errors[mode === "refused" ? "server" : mode];
      reply(status, { type: "error", error: { type, message } }, headers);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // A port that was just free and is closed again: connection refused.
  const closed = await new Promise<number>((r) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => r(port));
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    closed,
    setMode: (m: StubMode) => {
      mode = m;
    },
    close: () => new Promise((r) => server.close(r)),
  };
};

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const out = path.resolve(opt("--out") ?? FIXTURES);
  const only = opt("--only")?.split(",");
  const unknown = only?.filter((n) => !SCENARIOS.some((s) => s.name === n)) ?? [];
  if (unknown.length > 0) throw new Error(`unknown fixture ${unknown.join(", ")}; known: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  // A scenario that resumes or reuses a session needs the one that created it, recorded in the same run.
  const names = new Set(only ?? SCENARIOS.map((s) => s.name));
  for (const name of [...names]) names.add(SCENARIOS.find((f) => f.session === SCENARIOS.find((s) => s.name === name)!.session)!.name);
  const wanted = SCENARIOS.filter((s) => names.has(s.name));

  const version = /^(\d+\.\d+\.\d+)/u.exec(execFileSync("claude", ["--version"], { env: scrubbedEnv(), encoding: "utf8" }).trim())?.[1];
  if (version === undefined) throw new Error("claude --version printed no version");
  const root = path.join(LAB, `record-${version}-${Date.now()}`);
  const project = path.join(root, "project");
  const config = { login: path.join(root, "claude-config"), empty: path.join(root, "claude-config-empty"), stub: path.join(root, "claude-config-stub") };
  for (const dir of [project, ...Object.values(config)]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(out, { recursive: true });

  const login = claudeLoginEnv();
  const base = { ...scrubbedEnv(), LANG: process.env.LANG ?? "C.UTF-8" };
  const stubServer = await startStub();
  const mangled = (p: string) => p.replace(/[^a-zA-Z0-9]/gu, "-");
  const pairs: Array<[string, string]> = [
    ...Object.values(config).flatMap((d): Array<[string, string]> => [
      [d, "/work/claude-config"],
      [mangled(d), "-work-claude-config"],
    ]),
    [project, "/work/project"],
    [mangled(project), "-work-project"],
    [root, "/work"],
    [os.homedir(), "/home/user"],
    [`127.0.0.1:${stubServer.port}`, "127.0.0.1:4797"],
    [`127.0.0.1:${stubServer.closed}`, "127.0.0.1:4797"],
    ...Object.values(login).map((v): [string, string] => [v, "<redacted>"]),
  ];
  // Longest first, so a path is replaced before a shorter prefix of it.
  const replacements = pairs.toSorted((a, b) => b[0].length - a[0].length);
  const sanitize = (text: string) => replacements.reduce((t, [from, to]) => t.replaceAll(from, to), text);

  const sessions = new Map<string, string>();
  try {
    for (const s of wanted) {
      const sid = sessions.get(s.session) ?? randomUUID();
      sessions.set(s.session, sid);
      const args = [
        "-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--include-partial-messages",
        "--thinking", "adaptive", "--thinking-display", "summarized", "--effort", "low", "--strict-mcp-config", "--setting-sources", "",
        "--model", s.model ?? "claude-haiku-5-5", s.start === "resume" ? "--resume" : "--session-id", sid, ...(s.extra ?? []),
      ];
      let env: Record<string, string> = { ...base, ...login, CLAUDE_CONFIG_DIR: config.login };
      if (s.login === "empty") env = { ...base, CLAUDE_CONFIG_DIR: config.empty };
      else if (s.login !== undefined) {
        stubServer.setMode(s.login.stub);
        const port = s.login.stub === "refused" ? stubServer.closed : stubServer.port;
        env = { ...base, CLAUDE_CONFIG_DIR: config.stub, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: "stub-token", CLAUDE_CODE_MAX_RETRIES: "2" };
      }
      const lines = await record(s, args, env, project);
      const t0 = lines[0]!.t;
      const source = s.login !== undefined && s.login !== "empty" ? "observed-local-stub" : "observed";
      const body = lines.map(({ t, ...rest }, i) => {
        const line = i === 0 ? { dir: "meta", ms: 0, msg: { claude: version, source, scenario: s.name, args } } : { dir: rest.dir, ms: t - t0, ...("raw" in rest ? { raw: rest.raw } : { msg: rest.msg }) };
        return sanitize(pyJson(line));
      });
      const file = path.join(out, `claude-${version}-${s.name}.jsonl`);
      fs.writeFileSync(file, `${body.join("\n")}\n`);
      log(`recorded ${s.name}: ${lines.length} lines -> ${file}`);
    }
  } finally {
    await stubServer.close();
    // The scratch config dir holds claude's session files; nothing in it is needed after the run.
    fs.rmSync(root, { recursive: true, force: true });
  }
}

interface Recorded {
  readonly t: number;
  readonly dir: string;
  readonly msg?: Msg;
  readonly raw?: string;
}

/** Runs one claude process through the scenario and returns every line in and out, as the driver saw them. */
const record = (s: Scenario, args: ReadonlyArray<string>, env: Record<string, string>, cwd: string) =>
  new Promise<Array<Recorded>>((resolve) => {
    const lines: Array<Recorded> = [{ t: Date.now(), dir: "meta" }];
    const note = (dir: string, value: Msg | string) => lines.push({ t: Date.now(), dir, ...(typeof value === "string" ? { raw: value } : { msg: value }) });
    // Its own process group, as the node runs it, so the sigkill scenario can kill the group.
    const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const send = (m: Msg) => {
      note("in", m);
      child.stdin.write(`${JSON.stringify(m)}\n`);
    };
    let turn = 0;
    let acted = false;
    let tree: Array<ProcInfo> = [];
    const sendTurn = () => send({ type: "user", message: { role: "user", content: s.turns[turn] }, parent_tool_use_id: null, session_id: "", uuid: randomUUID() });
    child.stderr.on("data", (d: Buffer) => note("stderr", d.toString()));
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const text = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (text.trim() === "") continue;
        let m: Msg;
        try {
          m = JSON.parse(text) as Msg;
        } catch {
          note("out", text);
          continue;
        }
        note("out", m);
        if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
          const response = s.answer === "deny" ? { behavior: "deny", message: "Denied by fleetd policy (test)." } : { behavior: "allow", updatedInput: m.request.input };
          send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
        }
        const toolUse = m.type === "assistant" && (m.message?.content as Array<Msg> | undefined)?.some((c) => c.type === "tool_use");
        if (s.onTool !== undefined && toolUse && !acted) {
          acted = true;
          setTimeout(() => {
            if (s.onTool === "interrupt") return send({ type: "control_request", request_id: "fleetd-int-1", request: { subtype: "interrupt" } });
            tree = descendants(child.pid!);
            if (s.onTool === "sigterm") {
              note("meta", { action: "SIGTERM claude pid" });
              process.kill(child.pid!, "SIGTERM");
            } else {
              note("meta", { action: "SIGKILL process group" });
              process.kill(-child.pid!, "SIGKILL");
            }
          }, 1_500);
        }
        if (m.type === "result") {
          turn += 1;
          if (turn < s.turns.length) sendTurn();
          else child.stdin.end();
        }
      }
    });
    const watchdog = setTimeout(() => {
      note("meta", { action: "watchdog kill" });
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, 120_000);
    child.on("exit", (code, signal) => {
      clearTimeout(watchdog);
      note("meta", { exit: code, signal });
      // The Bash tool's child runs in its own process group and outlives a group kill; it is not ours to leave.
      const leaked = killSurvivors(tree);
      if (leaked.length > 0) log(`${s.name}: killed ${leaked.length} tool processes that outlived claude: ${leaked.map((p) => p.cmdline.join(" ")).join(" | ")}`);
      resolve(lines);
    });
    if (s.initialize === true) send({ type: "control_request", request_id: "fleetd-init-1", request: { subtype: "initialize" } });
    sendTurn();
  });

main().catch((error: unknown) => {
  log(`FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
