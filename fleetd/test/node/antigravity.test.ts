// Antigravity as a session's agent: the node's launch of `agy acp` (runner/antigravity.ts), and the session host's ACP
// driver (runner/host/acp.ts) against a stand-in agent (./fake-agy.ts): a turn streamed, MCP servers and the system
// prompt passed, the profile's model and thinking level set, permissions fenced or asked, a stop, a resume, and the
// sign-in and key failures.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as agy from "../../src/node/runner/antigravity.ts";
import { fenced, type AcpSpec } from "../../src/node/runner/host/acp.ts";
import type { RunnerEvent } from "../../src/node/runner/host/events.ts";
import { ACP_ENV, startSession, type Session } from "../../src/node/runner/host/session.ts";
import { runNodeAction } from "../../src/node/actions/index.ts";
import { roleAsk } from "../../src/node/runner/claude_spec.ts";
import { Logins } from "../../src/node/runner/login.ts";

const FAKE = join(import.meta.dir, "fake-agy.ts");
const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-agy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await Bun.sleep(5);
  }
}

/** One session of the stand-in agent, driven as the host drives it. */
class Run {
  readonly dir = join(root, `run-${++n}`);
  readonly events: RunnerEvent[] = [];
  session!: Session;
  constructor() {
    mkdirSync(this.dir);
  }
  static fresh(over: Partial<AcpSpec> = {}, env: Record<string, string> = {}): Promise<Run> {
    const run = new Run();
    return run.start(run.spec(over), env);
  }
  spec(over: Partial<AcpSpec> = {}): AcpSpec {
    return {
      cwd: this.dir,
      addDirs: [],
      mcpServers: agy.mcpServers(JSON.stringify({ mcpServers: { fleetd: { type: "stdio", command: "fleetd", args: ["agent-mcp"], env: { FLEETD_THREAD_ID: "s1" } } } })),
      systemPrompt: "You are a fleetd agent.",
      model: "gemini-4-argon",
      effort: "medium",
      approval: false,
      deny: [],
      allow: [],
      ask: [],
      stateFile: join(this.dir, "agy-session"),
      ...over,
    };
  }
  async start(spec: AcpSpec, env: Record<string, string> = {}): Promise<this> {
    writeFileSync(join(this.dir, "acp.json"), JSON.stringify(spec));
    const saved = { ...process.env };
    Object.assign(process.env, { [ACP_ENV]: join(this.dir, "acp.json"), AGY_LOG: join(this.dir, "log.jsonl"), ...env });
    try {
      this.session = await startSession(process.execPath, [FAKE], "s1", `s1.${n}`, (e) => this.events.push(e));
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    return this;
  }
  requests(): Record<string, any>[] {
    const file = join(this.dir, "log.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  }
  ended(runId: string): RunnerEvent | undefined {
    return this.events.find((e) => typeof e === "object" && "RunEnded" in e && e.RunEnded.run_id === runId);
  }
  async turn(runId: string, text: string): Promise<Extract<RunnerEvent, { RunEnded: unknown }>["RunEnded"]> {
    this.session.command({ Send: { run_id: runId, text, mode: "plain" } });
    await until(() => this.ended(runId) !== undefined, `${runId} ends`);
    return (this.ended(runId) as Extract<RunnerEvent, { RunEnded: unknown }>).RunEnded;
  }
  async end(): Promise<void> {
    this.session.command({ Shutdown: { grace: { secs: 0, nanos: 0 } } });
    await until(() => this.events.some((e) => typeof e === "object" && "Exited" in e), "the agent exits");
  }
}

const of = <K extends string>(events: RunnerEvent[], key: K) => events.filter((e): e is Extract<RunnerEvent, Record<K, unknown>> => typeof e === "object" && key in e);

test("a profile's model picks Antigravity: Gemini models and antigravity/<model>, nothing else", () => {
  expect(agy.agyModel("gemini-4-neon")).toBe("gemini-4-neon");
  expect(agy.agyModel("antigravity/claude-opus-5-5")).toBe("claude-opus-5-5");
  expect(agy.agyModel("claude-opus-5-5")).toBeUndefined();
  expect(agy.thinking("max")).toBe("xhigh");
});

test("agy starts on its own sign-in or the project's key, with no Google credential of the machine's and no self-update", () => {
  const env = { PATH: "/bin", GEMINI_API_KEY: "machine-key", GOOGLE_API_KEY: "other", AGY_ADC_AUTH: "true" };
  expect(agy.spawnEnv(env, { kind: "signin" })).toEqual({ PATH: "/bin", AGY_CLI_DISABLE_AUTO_UPDATE: "1" });
  const auth = agy.authOf({ GEMINI_API_KEY: "project-key", GOOGLE_GEMINI_BASE_URL: "https://gemini.devbox.example" });
  expect(agy.spawnEnv(env, auth)).toEqual({ PATH: "/bin", GEMINI_API_KEY: "project-key", GOOGLE_GEMINI_BASE_URL: "https://gemini.devbox.example", AGY_CLI_DISABLE_AUTO_UPDATE: "1" });
  expect(agy.args({ kind: "signin" }, "/s/agy")).toEqual(["acp"]);
  expect(agy.args(auth, "/s/agy")).toEqual(["acp", "--gemini-dir", "/s/agy"]);
  expect(agy.spec({ cwd: "/w", addDirs: [], mcpConfig: '{"mcpServers":{}}', model: "gemini-4-neon", effort: "high", auth, approval: false, deny: [], allow: [], ask: [], stateFile: "/s/x" }).authMethod).toBe("gemini-api-key");
});

test("MCP servers reach ACP as its lists: stdio with env, http with headers", () => {
  const config = { mcpServers: { fleetd: { type: "stdio", command: "fleetd", args: ["agent-mcp"], env: { A: "1" } }, docs: { type: "http", url: "https://mcp.devbox.example", headers: { Authorization: "Bearer t" } } } };
  expect(agy.mcpServers(JSON.stringify(config))).toEqual([
    { name: "fleetd", command: "fleetd", args: ["agent-mcp"], env: [{ name: "A", value: "1" }] },
    { type: "http", name: "docs", url: "https://mcp.devbox.example", headers: [{ name: "Authorization", value: "Bearer t" }] },
  ]);
});

test("a role's fences match Antigravity's tool calls in Claude's rule words", () => {
  const command = (c: string) => ({ name: "run_command", kind: "execute", rawInput: { CommandLine: c } });
  const rules = ["Bash(git push *--no-verify*)", "mcp__fleetd__spawn_agent", "Edit"];
  expect(fenced(rules, command("git push origin x --no-verify"))).toBe(true);
  expect(fenced(rules, command("git push origin x"))).toBe(false);
  expect(fenced(rules, { name: "mcp_tool", rawInput: { ServerName: "fleetd", ToolName: "spawn_agent" } })).toBe(true);
  expect(fenced(rules, { name: "replace_file_content", kind: "edit", rawInput: { TargetFile: "/w/a" } })).toBe(true);
  expect(fenced(rules, { name: "view_file", kind: "read", rawInput: { Path: "/w/a" } })).toBe(false);
  // A server's name alone is every tool of it, as a lead's `mcp__fleetd` is; another server's tool isn't.
  expect(fenced(["mcp__fleetd"], { name: "mcp_tool", rawInput: { ServerName: "fleetd", ToolName: "spawn_agent" } })).toBe(true);
  expect(fenced(["mcp__fleetd"], { name: "mcp_tool", rawInput: { ServerName: "fleetdx", ToolName: "spawn_agent" } })).toBe(false);
});

test("a turn streams and ends with its reply; MCP servers, the system prompt, model and thinking level reach the agent", async () => {
  const run = await Run.fresh();
  const ended = await run.turn("r1", "hi");
  expect(ended.outcome).toEqual({ Completed: { text: "hello" } });
  expect(ended.usage).toEqual({ inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 2, cacheCreationInputTokens: 0 });
  expect(of(run.events, "Delta").map((e) => e.Delta.append).join("")).toBe("hello");
  expect(of(run.events, "AssistantText").map((e) => e.AssistantText.text)).toEqual(["hello"]);
  expect(of(run.events, "Item").map((e) => e.Item.title)).toEqual(["Thinking: Thinking it over"]);
  expect(of(run.events, "Init")[0]!.Init.version).toBe("1.5.14");
  const sent = run.requests();
  const created = sent.find((m) => m.method === "session/new")!;
  expect(created.params.mcpServers).toEqual([{ name: "fleetd", command: "fleetd", args: ["agent-mcp"], env: [{ name: "FLEETD_THREAD_ID", value: "s1" }] }]);
  expect(created.params._meta).toEqual({ antigravity: { systemPrompt: { append: "You are a fleetd agent." } } });
  expect(sent.filter((m) => m.method === "session/set_config_option").map((m) => [m.params.configId, m.params.value])).toEqual([
    ["model", "gemini-4-argon"],
    ["thought_level", "medium"],
  ]);
  // No authenticate: it runs on the sign-in agy already has.
  expect(sent.some((m) => m.method === "authenticate")).toBe(false);
  expect(readFileSync(join(run.dir, "agy-session"), "utf8")).toBe("agy-1");
  await run.end();
});

test("the next start resumes the conversation it kept, and one Antigravity no longer has starts anew", async () => {
  const run = new Run();
  writeFileSync(join(run.dir, "agy-session"), "agy-1");
  await run.start(run.spec());
  expect((await run.turn("r1", "hi")).outcome).toEqual({ Completed: { text: "hello" } });
  expect(run.requests().map((m) => m.method).filter((m) => m?.startsWith("session/") && m !== "session/prompt" && m !== "session/set_config_option")).toEqual(["session/resume"]);
  await run.end();
  const gone = new Run();
  writeFileSync(join(gone.dir, "agy-session"), "agy-gone");
  await gone.start(gone.spec());
  expect((await gone.turn("r1", "hi")).outcome).toEqual({ Completed: { text: "hello" } });
  expect(gone.requests().map((m) => m.method)).toContain("session/new");
  expect(readFileSync(join(gone.dir, "agy-session"), "utf8")).toBe("agy-1");
  await gone.end();
});

test("a stop cancels the turn, which ends interrupted, and what waited on it ends withdrawn", async () => {
  const run = await Run.fresh();
  run.session.command({ Send: { run_id: "r1", text: "hang", mode: "plain" } });
  await until(() => of(run.events, "Delta").length > 0, "the turn streams");
  run.session.command({ Send: { run_id: "r2", text: "next", mode: "plain" } });
  expect(of(run.events, "Queued").map((e) => e.Queued.run_id)).toEqual(["r2"]);
  run.session.command("Interrupt");
  await until(() => run.ended("r1") !== undefined, "r1 ends");
  expect((run.ended("r1") as any).RunEnded.outcome).toBe("Interrupted");
  expect(of(run.events, "Withdrawn")).toEqual([{ Withdrawn: { run_id: "r2", cancelled: true, by_stop: true } }]);
  expect(run.requests().some((m) => m.method === "session/cancel")).toBe(true);
  // The session goes on: the next send is a turn of its own.
  expect((await run.turn("r3", "hi")).outcome).toEqual({ Completed: { text: "hello" } });
  await run.end();
});

test("a send with mode now cancels the running turn, which ends superseded by it", async () => {
  const run = await Run.fresh();
  run.session.command({ Send: { run_id: "r1", text: "hang", mode: "plain" } });
  await until(() => of(run.events, "Delta").length > 0, "the turn streams");
  run.session.command({ Send: { run_id: "r2", text: "hi", mode: "now" } });
  await until(() => run.ended("r2") !== undefined, "r2 ends");
  expect((run.ended("r1") as any).RunEnded.outcome).toEqual({ Superseded: { by: "r2" } });
  expect((run.ended("r2") as any).RunEnded.outcome).toEqual({ Completed: { text: "hello" } });
  await run.end();
});

test("a fenced command is denied unasked, any other runs, and in approval mode the hub answers", async () => {
  const free = await Run.fresh({ deny: ["Bash(rm *)"] });
  expect((await free.turn("r1", "cmd rm -rf /w")).outcome).toEqual({ Completed: { text: "deny" } });
  expect((await free.turn("r2", "cmd ls")).outcome).toEqual({ Completed: { text: "allow" } });
  const items = of(free.events, "Item").filter((e) => e.Item.kind.type === "command");
  expect(items.map((e) => [e.Item.title, e.Item.status])).toEqual([
    ["rm -rf /w", "running"],
    ["rm -rf /w", "failed"],
    ["ls", "running"],
    ["ls", "completed"],
  ]);
  expect(items[3]!.Item.kind).toEqual({ type: "command", command: "ls", output: "ran", outputOmitted: false, exitCode: 0 });
  await free.end();
  const asking = await Run.fresh({ approval: true });
  asking.session.command({ Send: { run_id: "r1", text: "cmd ls", mode: "plain" } });
  await until(() => of(asking.events, "PermissionRequest").length > 0, "the hub is asked");
  const asked = of(asking.events, "PermissionRequest")[0]!.PermissionRequest;
  expect([asked.tool_name, asked.summary]).toEqual(["Bash", "ls"]);
  asking.session.command({ Answer: { request_id: asked.request_id, decision: { behavior: "allow" }, by: "human" } });
  await until(() => asking.ended("r1") !== undefined, "r1 ends");
  expect((asking.ended("r1") as any).RunEnded.outcome).toEqual({ Completed: { text: "allow" } });
  await asking.end();
});

test("a machine that isn't signed in, and a key Antigravity refuses, fail the run saying so", async () => {
  const out = await Run.fresh({}, { AGY_SIGNED_OUT: "1" });
  const failed = (await out.turn("r1", "hi")).outcome as { Failed: { message: string } };
  expect(failed.Failed.message).toContain("Antigravity is not signed in on this machine");
  await out.end();
  const key = await Run.fresh({ authMethod: "gemini-api-key" });
  const refused = (await key.turn("r1", "hi")).outcome as { Failed: { message: string } };
  expect(refused.Failed.message).toContain("refused the project's Gemini API key");
  await key.end();
});

test("an install takes Google's manifest, checks the payload's sha512 and refuses one that doesn't match", async () => {
  const payload = new TextEncoder().encode("#!/bin/sh\necho 1.5.14\n");
  const sha512 = new Bun.CryptoHasher("sha512").update(payload).digest("hex");
  const target = join(root, "bin", "agy");
  const get = (bad: boolean) => async (url: string) =>
    url.endsWith(".json") ? new TextEncoder().encode(JSON.stringify({ version: "1.5.14", url: "https://dl.devbox.example/agy", sha512: bad ? "0" : sha512 })) : payload;
  await expect(agy.install(get(true), target)).rejects.toThrow("doesn't match its checksum");
  expect(existsSync(target)).toBe(false);
  expect(await agy.install(get(false), target)).toBe(target);
  expect(await agy.version(target)).toBe("1.5.14");
  expect(agy.versionOk("1.5.14")).toBe(true);
  expect(agy.versionOk("1.4.9")).toBe(false);
});

test("every agent-mcp tool's patterns compile in RE2, as Antigravity reads tool schemas: no lookaround, backreference or repeat past 1000", async () => {
  const { tools } = (await import("../../src/cli/agent_mcp/tools.json", { with: { type: "json" } })).default as { tools: unknown[] };
  const patterns: string[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) k === "pattern" && typeof v === "string" ? patterns.push(v) : walk(v);
  };
  walk(tools);
  /** The largest count a pattern repeats anything, nested groups multiplied. */
  const repeats = (p: string): number => {
    let most = 1;
    const stack: number[] = [];
    for (let i = 0; i < p.length; i++) {
      const c = p[i]!;
      if (c === "\\") i++;
      else if (c === "[") while (i < p.length && p[i] !== "]") i += p[i] === "\\" ? 2 : 1;
      else if (c === "(") stack.push(i);
      else if (c === ")" || c === "{") {
        const open = c === ")" ? stack.pop() : undefined;
        const m = /^\{(\d+)(?:,(\d*))?\}/.exec(p.slice(c === ")" ? i + 1 : i));
        if (!m) continue;
        const count = Number(m[2] || m[1]);
        const inner = open !== undefined ? repeats(p.slice(open + 1, i)) : 1;
        most = Math.max(most, count * inner);
      }
    }
    return most;
  };
  for (const p of patterns) {
    expect([p, /\(\?[=!<]|\\[1-9]/.test(p)]).toEqual([p, false]);
    expect([p, repeats(p) <= 1000]).toEqual([p, true]);
  }
  expect(repeats("^([a-z]{0,61}){1,20}$")).toBe(1220);
  expect(repeats("^(a(b{0,9})?){1,20}$")).toBe(180);
});

test("the app signs Antigravity in through the node: it checks the sign-in, runs agy acp --login, and takes the code", async () => {
  const dir = join(root, "signin");
  mkdirSync(dir);
  const bin = join(dir, "agy");
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(bin, 0o755);
  const signin = join(dir, "signed-in");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, AGY_SIGNIN: signin, DISPLAY: ":0" };
  const hooks = { antigravity: { binary: async () => bin, env: () => env, logins: new Logins(10_000) } };
  const started = await runNodeAction({ id: "a1", action: "antigravity_login" }, hooks);
  expect([started.ok, started.login_url, started.signed_in]).toEqual([true, "https://accounts.google.com/o/oauth2/auth?state=fake", undefined]);
  const bad = await runNodeAction({ id: "a2", action: "antigravity_login_code", code: "nope" }, hooks);
  expect([bad.ok, bad.message]).toEqual([false, "agy acp --login failed: That code didn't work."]);
  await runNodeAction({ id: "a3", action: "antigravity_login" }, hooks);
  const done = await runNodeAction({ id: "a4", action: "antigravity_login_code", code: "good-code" }, hooks);
  expect([done.ok, done.signed_in]).toEqual([true, "Google AI Pro"]);
  // Signed in now: a new ask starts nothing and says so.
  const again = await runNodeAction({ id: "a5", action: "antigravity_login" }, hooks);
  expect([again.ok, again.signed_in, again.login_url]).toEqual([true, "Google AI Pro", undefined]);
  // The login never opens a browser of the machine's own, and tells agy it runs over SSH.
  expect(agy.loginEnv(env)).toMatchObject({ BROWSER: "true", SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" });
  expect(agy.loginEnv(env).DISPLAY).toBeUndefined();
});

test("in approval mode a lead's own tools run unasked (fleetd's MCP server, its allowed commands); anything else asks", async () => {
  const run = await Run.fresh({ approval: true, allow: ["mcp__fleetd", "Bash(agent-device *)"] });
  expect((await run.turn("r1", "mcp fleetd spawn_agent")).outcome).toEqual({ Completed: { text: "allow" } });
  expect((await run.turn("r2", "cmd agent-device snapshot")).outcome).toEqual({ Completed: { text: "allow" } });
  expect(of(run.events, "PermissionRequest")).toEqual([]);
  run.session.command({ Send: { run_id: "r3", text: "mcp docs search", mode: "plain" } });
  await until(() => of(run.events, "PermissionRequest").length > 0, "another server's tool asks");
  expect(of(run.events, "PermissionRequest")[0]!.PermissionRequest.tool_name).toBe("mcp__docs__search");
  await run.end();
});

test("a lead's ask rules rank above its allowed ones, as on Claude: a final Confirm goes to the hub though fleetd's tools run unasked", async () => {
  const run = await Run.fresh({ approval: true, allow: ["mcp__fleetd"], ask: ["mcp__fleetd__confirm_step", "mcp__fleetd__project_propose"] });
  expect((await run.turn("r1", "mcp fleetd spawn_agent")).outcome).toEqual({ Completed: { text: "allow" } });
  run.session.command({ Send: { run_id: "r2", text: "mcp fleetd confirm_step", mode: "plain" } });
  await until(() => of(run.events, "PermissionRequest").length > 0, "the confirm asks");
  const asked = of(run.events, "PermissionRequest")[0]!.PermissionRequest;
  expect(asked.tool_name).toBe("mcp__fleetd__confirm_step");
  run.session.command({ Answer: { request_id: asked.request_id, decision: { behavior: "deny", message: "not yet" }, by: "human" } });
  await until(() => run.ended("r2") !== undefined, "r2 ends");
  expect((run.ended("r2") as any).RunEnded.outcome).toEqual({ Completed: { text: "deny" } });
  // And a lead's ask list reaches the spec the node writes: the role's, in approval mode.
  expect(agy.spec({ cwd: "/w", addDirs: [], mcpConfig: '{"mcpServers":{}}', model: "gemini-4-neon", effort: "high", auth: { kind: "signin" }, approval: true, deny: [], allow: ["mcp__fleetd"], ask: roleAsk("lead", "approval-required"), stateFile: "/s/x" }).ask).toContain("mcp__fleetd__confirm_step");
  await run.end();
});

test("a stop while a permission waits answers it cancelled, so the turn ends, and its card closes", async () => {
  const run = await Run.fresh({ approval: true });
  run.session.command({ Send: { run_id: "r1", text: "cmd ls", mode: "plain" } });
  await until(() => of(run.events, "PermissionRequest").length > 0, "the hub is asked");
  const asked = of(run.events, "PermissionRequest")[0]!.PermissionRequest;
  run.session.command("Interrupt");
  await until(() => run.ended("r1") !== undefined, "r1 ends");
  expect((run.ended("r1") as any).RunEnded.outcome).toBe("Interrupted");
  const card = of(run.events, "Item").find((e) => e.Item.id === asked.request_id)!.Item;
  expect([card.status, card.kind.type]).toEqual(["cancelled", "permission"]);
  expect(run.requests().find((m) => m.id === "perm-1" && m.method === undefined)?.result).toEqual({ outcome: { outcome: "cancelled" } });
  // Its answer, late, finds nothing waiting.
  run.session.command({ Answer: { request_id: asked.request_id, decision: { behavior: "allow" }, by: "human" } });
  expect((await run.turn("r2", "hi")).outcome).toEqual({ Completed: { text: "hello" } });
  await run.end();
});

test("the sign-in check reads agy's authenticate answer: the plan when signed in, null when not, nothing else", () => {
  expect(agy.SIGNED_IN_ASK.map((l) => JSON.parse(l).method)).toEqual(["initialize", "authenticate"]);
  expect(agy.planOf('{"jsonrpc":"2.0","id":2,"result":{"_meta":{"antigravity":{"tier":{"name":"Google AI Pro"}}}}}')).toBe("Google AI Pro");
  expect(agy.planOf('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}')).toBeNull();
  expect(agy.planOf('{"jsonrpc":"2.0","id":1,"result":{}}')).toBeUndefined();
  expect(agy.planOf("not json")).toBeUndefined();
  expect(agy.signInUrl("Open this link:\n\n  https://accounts.google.com/o/oauth2/auth?state=x\n\nThen paste")).toBe("https://accounts.google.com/o/oauth2/auth?state=x");
});
