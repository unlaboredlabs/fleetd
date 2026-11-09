// What the session service does for the machine around each agent (sessions/mod.rs): a worker's share of the CPUs in
// its environment and its brief, its cargo builds taking turns for the build slots, a former Navi's lead in the home it
// kept, a review at its PR's head, its screens ended when its claude exits, what its task left running ended with the
// task, a refused login shown at once; and the node's own start-up cleanups and crash guard.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guard, startupCleanups } from "../../src/node/index.ts";
import { binDir } from "../../src/node/build_slots.ts";
import { leftFile } from "../../src/node/runner/host.ts";
import { statOf } from "../../src/node/runner/procs.ts";
import { SessionService, type SessionConfig } from "../../src/node/sessions/index.ts";
import type { NodeFrame } from "../../src/node/wire.ts";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(30_000);

const home = tempHome();
const repo = join(home.dir, "repo");
const node = join(home.dir, "node");
const frames: NodeFrame[] = [];
const ended: string[] = [];
let service: SessionService;

const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
let calls = 0;
const ok = async (op: string, args: Record<string, unknown> = {}) => {
  const reply = await service.handle({ id: `c${++calls}`, call: { op, ...args } as never });
  if (!("ok" in reply.result)) throw new Error(`${op}: ${JSON.stringify(reply.result)}`);
  return reply.result.ok as Record<string, any>;
};
const until = async <T>(what: string, fn: () => T | undefined | false, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};
const settled = (id: string, run: string) => until(`${run} to end`, () => service.store.runs(id).find((r) => r.id === run && !["queued", "starting", "running", "waiting"].includes(r.status)));
const hostEnv = (id: string) => JSON.parse(readFileSync(join(node, "hosts", id, "env.json"), "utf8")) as Record<string, string>;
const launch = (sessionId: string, more: Record<string, unknown> = {}) =>
  ok("launch", { sessionId, projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "go", runId: `${sessionId}-r1`, ...more });

beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const config: SessionConfig = {
    home: node,
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    nativeBin: join(import.meta.dir, "fake-host.sh"),
    retryScheduleMs: [],
  };
  service = await SessionService.start(config);
  service.attach((f) => frames.push(f));
  service.launch = { env: () => [], pluginDirs: () => [], ended: (thread) => void ended.push(thread) };
  await ok("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
  await ok("subscribe", {});
});

afterAll(async () => {
  await service.stopAll();
  home.done();
});

test("a worker builds with its share of the machine, its cargo taking turns, and its brief says so", async () => {
  await launch("w1", { role: "worker", systemPrompt: "Be brief." });
  await settled("w1", "w1-r1");
  const env = hostEnv("w1");
  for (const k of ["CARGO_BUILD_JOBS", "CMAKE_BUILD_PARALLEL_LEVEL"]) expect(Number(env[k])).toBeGreaterThanOrEqual(2);
  expect(env.MAKEFLAGS).toMatch(/^-j\d+$/);
  expect(env.GOFLAGS).toMatch(/^-p=\d+$/);
  expect(Number(env.VITEST_MAX_WORKERS)).toBeGreaterThanOrEqual(4);
  expect(env.PATH!.split(":")[0]).toBe(binDir(node));
  expect(readFileSync(join(binDir(node), "cargo"), "utf8")).toContain(` build-slot '${node}' "$@"`);
  const prompt = service.store.session("w1")!.local.systemPrompt!;
  expect(prompt).toStartWith("Be brief.\n\n## This machine\n- Builds get ");
  expect(prompt).toContain("Scratch files go in $TMPDIR");
  // A lead's standing rules stay its own.
  await launch("l1", { role: "lead", systemPrompt: "Lead well." });
  expect(service.store.session("l1")!.local.systemPrompt).toBe("Lead well.");
  await settled("l1", "l1-r1");
});

test("a former Navi's lead runs its commands in the home it kept", async () => {
  const own = join(node, "navis", "p1", "home");
  mkdirSync(own, { recursive: true });
  await launch("n1", { role: "assistant" });
  await settled("n1", "n1-r1");
  const sourced = readFileSync(hostEnv("n1").CLAUDE_ENV_FILE!, "utf8");
  expect(sourced).toContain(`export HOME='${realpathSync(own)}'\n`);
  expect(sourced).toContain('export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$HOME/go/bin:$HOME/.bun/bin:$HOME/.deno/bin:$PATH"\n');
  expect(sourced).toContain(`export TMPDIR='${join(node, "navis", "p1", "tmp")}'`);
  expect(existsSync(join(node, "navis", "p1", "tmp"))).toBe(true);
});

test("a worker's stop ends its screens and what its session left running", async () => {
  await launch("w2", { role: "worker" });
  await settled("w2", "w2-r1");
  const left = Bun.spawn(["sleep", "30"], { detached: true });
  writeFileSync(leftFile(join(node, "hosts", "w2")), `${left.pid} ${statOf(left.pid)!.start}\n`);
  await ok("stop", { sessionId: "w2" });
  await until("its claude's exit to end its screens", () => ended.includes("w2"));
  await left.exited;
  expect(left.signalCode).toBe("SIGKILL");
  expect(existsSync(leftFile(join(node, "hosts", "w2")))).toBe(false);
});

test("a run whose login was refused shows the machine logged out at once", async () => {
  await ok("send", { sessionId: "w1", runId: "w1-auth", text: "auth: please" });
  await settled("w1", "w1-auth");
  const info = await until("runner_info logged out", () =>
    frames.flatMap((f) => (f.t === "machine_event" && (f as any).event.type === "runner_info" && (f as any).event.login === "logged_out" ? [(f as any).event] : [])).find((e) => e.problem?.startsWith("claude refused its login: Failed to authenticate. API Error: 401 OAuth token has expired. Fix: claude auth login")),
  );
  expect(info.login).toBe("logged_out");
  expect((await ok("runner_info")).login).toBe("logged_out");
});

test("a review elsewhere reads its pr's head, fetched from the remote", async () => {
  const origin = join(home.dir, "origin.git");
  const writer = join(home.dir, "writer");
  spawnSync("git", ["clone", "-q", "--no-local", repo, writer]);
  spawnSync("git", ["clone", "-q", "--bare", "--no-local", repo, origin]);
  git(writer, "commit", "-q", "--allow-empty", "-m", "the pr");
  const sha = git(writer, "rev-parse", "HEAD").stdout.trim();
  git(writer, "push", "-q", origin, "HEAD:refs/pull/9/head");
  git(repo, "remote", "add", "origin", "https://github.com/acme/shop.git");
  git(repo, "config", `url.${origin}.insteadOf`, "https://github.com/acme/shop.git");
  git(repo, "fetch", "-q", "origin");
  // The hub names a head this machine lacks: the remote's PR ref has it.
  await launch("rv1", { role: "worker", workspace: { type: "detached", baseRef: "main", pr: "https://github.com/acme/shop/pull/9", head: "f".repeat(40) } });
  const cwd = service.store.session("rv1")!.local.cwd;
  expect(git(cwd, "rev-parse", "HEAD").stdout.trim()).toBe(sha);
  await settled("rv1", "rv1-r1");
});

test("a removed project takes the home its Navi kept", async () => {
  await ok("project_remove", { projectId: "p1" });
  expect(existsSync(join(node, "navis", "p1"))).toBe(false);
});

test("a starting node clears what a stopped one left", () => {
  const h = tempHome();
  try {
    for (const d of ["sessions/s1/device-remote/bin", "sessions/s1/device-work", "telegram/journal"]) mkdirSync(join(h.dir, d), { recursive: true });
    writeFileSync(join(h.dir, "sessions/s1/mcp.json"), "{}");
    startupCleanups(h.dir);
    expect(existsSync(join(h.dir, "sessions/s1/device-remote"))).toBe(false);
    expect(existsSync(join(h.dir, "sessions/s1/device-work"))).toBe(false);
    expect(existsSync(join(h.dir, "sessions/s1/mcp.json"))).toBe(true);
    expect(existsSync(join(h.dir, "telegram"))).toBe(false);
  } finally {
    h.done();
  }
});

test("a node whose task fails carries on", async () => {
  // In a process of its own: the guard's handlers are for the whole process.
  const script = `import { guard } from ${JSON.stringify(join(import.meta.dir, "../../src/node/index.ts"))};
guard();
void Promise.reject(new Error("a handler's promise"));
setTimeout(() => { throw new Error("a timer's throw"); }, 10);
setTimeout(() => { console.log("still up"); process.exit(0); }, 200);`;
  const file = join(home.dir, "guard.ts");
  writeFileSync(file, script);
  const out = spawnSync(process.execPath, [file], { encoding: "utf8" });
  expect(out.status).toBe(0);
  expect(out.stdout).toContain("still up");
  expect(out.stderr).toContain("a handler's promise");
  expect(out.stderr).toContain("a timer's throw");
  expect(typeof guard).toBe("function");
});
