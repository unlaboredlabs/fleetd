// The node's launch of a session on an Antigravity profile, end to end: the session service starts fleetd's own
// session host (src/main.ts session-host), which drives the stand-in agent (./fake-agy.ts) over ACP. What reaches agy
// (its argv, environment and ACP spec: model, thinking level, MCP servers, fences), a turn through to the thread, and
// the refusal of a hosted sandbox.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionService, type SessionConfig } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

const home = tempHome();
const repo = join(home.dir, "repo");
const started = join(home.dir, "agy-start.json");
const signin = join(home.dir, "agy-signed-in");
let service: SessionService;
setDefaultTimeout(60_000);

const config = (): SessionConfig => ({
  home: join(home.dir, "node"),
  claudeEnv: join(home.dir, "claude.env"),
  // The machine's own Google credentials, which no session takes; and where the stand-in writes what it got.
  baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", GOOGLE_API_KEY: "machine-key", AGY_START: started, AGY_SIGNIN: signin },
  claudeBin: "/bin/true",
  fleetd: [process.execPath, join(import.meta.dir, "../../src/main.ts")],
  retryScheduleMs: [50, 50, 50],
  idleReapMs: 60_000,
});
let calls = 0;
const call = (op: string, args: Record<string, unknown> = {}) => service.handle({ id: `c${++calls}`, call: { op, ...args } as never });
const ok = async (op: string, args: Record<string, unknown> = {}) => {
  const reply = await call(op, args);
  if (!("ok" in reply.result)) throw new Error(`${op}: ${JSON.stringify(reply.result)}`);
  return reply.result.ok as Record<string, any>;
};
const until = async <T>(what: string, fn: () => T | undefined, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got !== undefined && got !== false) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};
const summary = (id: string) => service.store.session(id)?.summary;

beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const bin = join(home.dir, "agy");
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fake-agy.ts")}' "$@"\n`);
  chmodSync(bin, 0o755);
  process.env.FLEETD_AGY_BIN = bin;
  service = await SessionService.start(config());
  service.attach(() => {});
  await ok("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
});
afterAll(async () => {
  await service.stopAll();
  delete process.env.FLEETD_AGY_BIN;
  home.done();
});

test("a lead on an Antigravity profile runs agy acp through the session host, with its spec, fences and MCP servers", async () => {
  await ok("launch", {
    sessionId: "g1",
    projectId: "p1",
    runtimeMode: "approval-required",
    workspace: { type: "root" },
    prompt: "hello",
    runId: "r1",
    role: "lead",
    profile: "gemini",
    model: "gemini-4-neon",
    effort: "max",
    systemPrompt: "You lead the bot demo.",
  });
  await until("the run to complete", () => summary("g1")?.latestRun?.status === "completed");
  expect(summary("g1")).toMatchObject({ model: "gemini-4-neon", latestAssistantTail: "hello" });
  const dir = join(home.dir, "node", "sessions", "g1");
  const spec = JSON.parse(readFileSync(join(dir, "acp.json"), "utf8"));
  expect(spec).toMatchObject({ cwd: repo, model: "gemini-4-neon", effort: "xhigh", approval: true, systemPrompt: "You lead the bot demo.", stateFile: join(dir, "agy-session") });
  expect(spec.authMethod).toBeUndefined();
  expect(spec.mcpServers.map((m: { name: string }) => m.name)).toContain("fleetd");
  // The role's fences, its own tools and the asks above them, as Claude gets them.
  expect(spec.deny).toContain("Agent");
  expect(spec.allow).toContain("mcp__fleetd");
  expect(spec.ask).toContain("mcp__fleetd__confirm_step");
  // agy acp on the machine's sign-in: no Google credential of the machine's, no self-update.
  const start = JSON.parse(readFileSync(started, "utf8"));
  expect(start.argv).toEqual(["acp"]);
  expect(start.env.GOOGLE_API_KEY).toBeUndefined();
  expect(start.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
  expect(start.env.FLEETD_ACP).toBeUndefined();
  expect(readFileSync(join(dir, "agy-session"), "utf8")).toBe("agy-1");
});

test("a bot's Gemini key runs its agents on the key, each in an Antigravity home of its own", async () => {
  await ok("project_env", { projectId: "p1", set: [{ name: "GEMINI_API_KEY", value: "bot-key" }], remove: [] });
  await ok("launch", { sessionId: "g2", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hi", runId: "r1", role: "worker", profile: "gemini", model: "gemini-4-argon", effort: "high" });
  await until("the run to complete", () => summary("g2")?.latestRun?.status === "completed");
  const dir = join(home.dir, "node", "sessions", "g2");
  expect(JSON.parse(readFileSync(join(dir, "acp.json"), "utf8"))).toMatchObject({ authMethod: "gemini-api-key", approval: false });
  const start = JSON.parse(readFileSync(started, "utf8"));
  expect(start.argv).toEqual(["acp", "--gemini-dir", join(dir, "agy")]);
  expect(start.env.GEMINI_API_KEY).toBe("bot-key");
  await ok("project_env", { projectId: "p1", set: [], remove: ["GEMINI_API_KEY"] });
});

test("the team's Gemini key runs agents whose bot has none, a bot's own key wins, and a bot's own endpoint never gets it", async () => {
  // As the node keeps it once the hub relayed it (gemini_key): its own file, next to the Claude accounts.
  writeFileSync(join(home.dir, "node", "gemini-key.json"), JSON.stringify({ value: "team-key", endpoint: "https://gw.devbox.example" }), { mode: 0o600 });
  try {
    const run = async (id: string) => {
      await ok("launch", { sessionId: id, projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hi", runId: "r1", role: "worker", profile: "gemini", model: "gemini-4-argon", effort: "high" });
      await until("the run to complete", () => summary(id)?.latestRun?.status === "completed");
      const start = JSON.parse(readFileSync(started, "utf8"));
      return [JSON.parse(readFileSync(join(home.dir, "node", "sessions", id, "acp.json"), "utf8")).authMethod, start.env.GEMINI_API_KEY, start.env.GOOGLE_GEMINI_BASE_URL];
    };
    expect(await run("g4")).toEqual(["gemini-api-key", "team-key", "https://gw.devbox.example"]);
    await ok("project_env", { projectId: "p1", set: [{ name: "GEMINI_API_KEY", value: "bot-key" }], remove: [] });
    expect((await run("g5")).slice(0, 2)).toEqual(["gemini-api-key", "bot-key"]);
    await ok("project_env", { projectId: "p1", set: [], remove: ["GEMINI_API_KEY"] });
    // A bot that names an endpoint of its own never gets the team's key there: with no key of its own, its agents run
    // on the machine's sign-in, and nothing of the team's key reaches agy.
    await ok("project_env", { projectId: "p1", set: [{ name: "GOOGLE_GEMINI_BASE_URL", value: "https://collector.devbox.example" }], remove: [] });
    expect(await run("g6")).toEqual([undefined, undefined, undefined]);
    expect(readFileSync(started, "utf8")).not.toContain("team-key");
    await ok("project_env", { projectId: "p1", set: [], remove: ["GOOGLE_GEMINI_BASE_URL"] });
  } finally {
    rmSync(join(home.dir, "node", "gemini-key.json"), { force: true });
  }
});

test("a hosted sandbox refuses an Antigravity profile, saying so, and starts no agy", async () => {
  const before = existsSync(started) ? readFileSync(started, "utf8") : "";
  const reply = await call("launch", { sessionId: "g3", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hi", runId: "r1", role: "worker", profile: "gemini", model: "gemini-4-neon", effort: "high", place: "boat" });
  expect(reply.result).toMatchObject({ ok: { kind: "launched" } });
  await until("the run to fail", () => summary("g3")?.latestRun?.status === "failed");
  expect(summary("g3")?.latestRun?.failure?.message).toBe("Antigravity agents run on this hub's own machines, not in hosted sandboxes yet");
  expect(existsSync(started) ? readFileSync(started, "utf8") : "").toBe(before);
});

// agy shows its model at most TOOL_BUDGET bytes of MCP tools, every server's together, and hides the biggest past it
// (src/node/agy_budget.ts, W844): a lead on Antigravity goes without the bot's biggest servers so fleetd's own tools all
// fit, and says which in its summary, for the hub's chat line; agents keep them.
test("a lead on Antigravity goes without the bot's biggest servers when they and fleetd's tools are more than agy shows; agents keep them", async () => {
  const listing = (name: string, n: number, pad: number) => ({
    name,
    secrets: { kind: "global" },
    roles: { lead: true, writers: true, reviewers: false },
    transport: { type: "stdio", command: process.execPath, args: [join(import.meta.dir, "fake-mcp-tools.ts")] },
    env: [{ kind: "plain", name: "TOOLS_N", value: String(n) }, { kind: "plain", name: "TOOLS_PAD", value: String(pad) }],
  });
  // About 52 KB of tools beside fleetd's own 44 KB, and a small server.
  const servers = [listing("paper", 50, 1000), listing("notes", 2, 10)];
  const launch = (sessionId: string, role: string, model = "gemini-4-neon") =>
    ok("launch", { sessionId, projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hi", runId: "r1", role, mcpRole: role === "lead" ? "lead" : "writer", profile: "gemini", model, effort: "high", mcp: { userServers: false, servers } });
  const loaded = (id: string) => JSON.parse(readFileSync(join(home.dir, "node", "sessions", id, "acp.json"), "utf8")).mcpServers.map((m: { name: string }) => m.name);
  await launch("g-heavy", "lead");
  await until("the lead's run", () => summary("g-heavy")?.latestRun?.status === "completed");
  expect(loaded("g-heavy")).toEqual(["notes", "fleetd"]);
  expect(summary("g-heavy")).toMatchObject({ mcpHeavy: ["paper"], mcpChange: { down: [], back: [], heavy: ["paper"] } });
  // A writer on Antigravity keeps it.
  await launch("g-heavy-writer", "worker");
  await until("the writer's run", () => summary("g-heavy-writer")?.latestRun?.status === "completed");
  expect(loaded("g-heavy-writer")).toEqual(["paper", "notes", "fleetd"]);
  expect(summary("g-heavy-writer")?.mcpHeavy).toBeUndefined();
  // Without the big one, the lead's tools all fit: nothing is left out.
  servers.splice(0, 1, listing("paper", 5, 1000));
  await launch("g-light", "lead");
  await until("the light lead's run", () => summary("g-light")?.latestRun?.status === "completed");
  expect(loaded("g-light")).toEqual(["paper", "notes", "fleetd"]);
  expect(summary("g-light")?.mcpHeavy).toBeUndefined();
  expect(summary("g-light")?.mcpChange).toEqual({ down: [], back: [] });
});
