// The session service over a session host (test/node/fake-host.ts, the Rust `session-host`'s socket protocol):
// projects, launches in the root and a worktree, the machine and thread streams, a permission asked and answered,
// a stop that removes its worktree, and a session re-adopted from its host after the node restarted.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionService, type SessionConfig } from "../../src/node/sessions/index.ts";
import { scan } from "../../src/node/repos/index.ts";
import type { NodeFrame } from "../../src/node/wire.ts";
import { tempHome } from "../helpers.ts";

const home = tempHome();
const repo = join(home.dir, "repo");
const frames: NodeFrame[] = [];
let service: SessionService;

const config = (): SessionConfig => ({
  home: join(home.dir, "node"),
  claudeEnv: join(home.dir, "claude.env"),
  baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
  claudeBin: "/bin/true",
  fleetd: [join(import.meta.dir, "fake-host.sh")],
  retryScheduleMs: [50, 50, 50],
  idleReapMs: 60_000,
});

const git = (...args: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
let calls = 0;
const call = (op: string, args: Record<string, unknown> = {}) => service.handle({ id: `c${++calls}`, call: { op, ...args } as never });
const ok = async (op: string, args: Record<string, unknown> = {}) => {
  const reply = await call(op, args);
  if (!("ok" in reply.result)) throw new Error(`${op}: ${JSON.stringify(reply.result)}`);
  return reply.result.ok as Record<string, any>;
};
// Each launch starts a host process (sh, then bun), and a run goes through it: a loaded machine (CI, or a busy devbox)
// takes longer than bun's 5 s default.
setDefaultTimeout(30_000);
const until = async <T>(what: string, fn: () => T | undefined, ms = 20_000): Promise<T> => {
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
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  service = await SessionService.start(config());
  service.attach((f) => frames.push(f));
});

afterAll(async () => {
  await service.stopAll();
  home.done();
});

test("a project is upserted and a subscribe gets a snapshot, then live summaries", async () => {
  expect(await ok("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo })).toEqual({ kind: "done" });
  await ok("subscribe", { caughtUp: true });
  const snapshot = frames.find((f) => f.t === "machine_event" && (f.event as { type: string }).type === "snapshot") as Record<string, any>;
  expect(snapshot.event.projects.map((p: { projectId: string }) => p.projectId)).toEqual(["p1"]);
  expect(frames.some((f) => (f.event as { type?: string })?.type === "caught_up")).toBe(true);
  const missing = await call("project_upsert", { projectId: "p2", title: "x", workspaceRoot: join(home.dir, "nope") });
  expect(missing.result).toMatchObject({ err: { code: "invalid" } });
});

test("a launch runs its first message through the host, and the thread streams it to a follower", async () => {
  const launched = await ok("launch", {
    sessionId: "s1",
    projectId: "p1",
    runtimeMode: "full-access",
    workspace: { type: "root" },
    prompt: "hello there",
    runId: "r1",
    role: "lead",
  });
  expect(launched.kind).toBe("launched");
  await until("the run to complete", () => summary("s1")?.latestRun?.status === "completed");
  expect(summary("s1")).toMatchObject({ status: "idle", latestAssistantTail: "ok: hello there", model: "claude-opus-5-5", effort: "high" });
  // A retried launch gets the session the first one made.
  expect((await ok("launch", { sessionId: "s1", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "x", runId: "r9" })).summary.sessionId).toBe("s1");
  frames.length = 0;
  await ok("follow", { sessionId: "s1" });
  const snap = frames.find((f) => f.t === "thread_event") as Record<string, any>;
  expect(snap.event.type).toBe("snapshot");
  expect(snap.event.messages.map((m: { text: string }) => m.text)).toEqual(["hello there", "ok: hello there"]);
  await ok("send", { sessionId: "s1", runId: "r2", text: "again" });
  await until("the second run", () => summary("s1")?.latestRun?.id === "r2" && summary("s1")?.latestRun?.status === "completed");
  const streamed = frames.filter((f) => f.t === "thread_event").map((f) => (f.event as { type: string }).type);
  expect(streamed).toContain("message");
  expect(streamed).toContain("run");
});

test("a prompt under full access is answered by the node; one under approval waits for the hub's answer", async () => {
  await ok("send", { sessionId: "s1", runId: "r3", text: "ask: may I" });
  await until("the auto-answered run", () => summary("s1")?.latestRun?.id === "r3" && summary("s1")?.latestRun?.status === "completed");
  expect(service.store.item("s1", "perm-req-r3")).toMatchObject({ status: "completed", kind: { decision: { behavior: "allow" } } });
  await ok("launch", {
    sessionId: "s3",
    projectId: "p1",
    runtimeMode: "approval-required",
    workspace: { type: "root" },
    prompt: "ask: may I",
    runId: "a1",
  });
  const pending = await until("the prompt", () => summary("s3")?.pendingPermission);
  expect(summary("s3")?.status).toBe("waiting");
  // A message behind the waiting run is queued; one withdrawn before claude takes it in never runs.
  expect((await ok("send", { sessionId: "s3", runId: "a2", text: "behind" })).queued).toBe(true);
  expect((await ok("send", { sessionId: "s3", runId: "a3", text: "withdrawn" })).queued).toBe(true);
  expect(await ok("withdraw", { sessionId: "s3", runId: "a3" })).toEqual({ kind: "withdrawn", cancelled: true });
  expect(await ok("withdraw", { sessionId: "s3", runId: "a1" })).toEqual({ kind: "withdrawn", cancelled: false });
  const wrong = await call("answer", { sessionId: "s3", requestId: "nope", decision: { behavior: "allow" } });
  expect(wrong.result).toMatchObject({ err: { code: "not_found" } });
  await ok("answer", { sessionId: "s3", requestId: pending.requestId, decision: { behavior: "allow" } });
  await until("the answered run and the one behind it", () => summary("s3")?.latestRun?.id === "a2" && summary("s3")?.latestRun?.status === "completed");
  expect(service.store.runs("s3").find((r) => r.id === "a3")).toMatchObject({ status: "interrupted" });
  expect(service.store.item("s3", `perm-${pending.requestId}`)?.status).toBe("completed");
  expect(summary("s3")?.pendingPermission).toBeUndefined();
});

test("a writer works in a worktree of its own, and its stop removes it once nothing would be lost", async () => {
  const launched = await ok("launch", {
    sessionId: "s2",
    projectId: "p1",
    runtimeMode: "full-access",
    workspace: { type: "worktree", baseRef: "main", branch: "fleetd/t1" },
    prompt: "write it",
    runId: "w1",
    role: "worker",
  });
  const path = launched.summary.worktreePath as string;
  expect(launched.summary.branch).toBe("fleetd/t1");
  expect(launched.base).toMatchObject({ ref: "main", error: { kind: "no_remote" } });
  expect(existsSync(path)).toBe(true);
  await until("the writer's run", () => summary("s2")?.latestRun?.status === "completed");
  expect((await ok("changes", { sessionId: "s2" })).paths).toEqual([]);
  await ok("stop", { sessionId: "s2", removeWorktree: true });
  expect(existsSync(path)).toBe(false);
  expect(summary("s2")?.worktreePath).toBeUndefined();
});

test("a worktree's setup runs before its agent starts, and the brief says what it did", async () => {
  const launch = (sessionId: string, runId: string, branch: string, plan: Record<string, unknown>) =>
    ok("launch", { sessionId, projectId: "p1", runtimeMode: "full-access", workspace: { type: "worktree", baseRef: "main", branch }, prompt: "brief", runId, role: "worker", setup: plan });
  const launched = await launch("s5", "u1", "fleetd/t5", { commands: ["echo made > made.txt", "echo second"], timeoutSec: 30 });
  await until("the run after setup", () => summary("s5")?.latestRun?.status === "completed");
  expect(readFileSync(join(launched.summary.worktreePath, "made.txt"), "utf8")).toBe("made\n");
  expect(service.store.item("s5", "setup-u1-0")).toMatchObject({ status: "completed", title: "Setup: echo made > made.txt", kind: { exitCode: 0 } });
  const brief = service.store.message("s5", "u1")!.text;
  expect(brief).toStartWith("brief\n\n## Setup\nSetup ran in this worktree before you started: `echo made > made.txt` (exited 0 after 0 s), `echo second`");
  expect(service.store.session("s5")?.local.setupPending).toBeUndefined();

  // A setup that fails still starts the agent, whose brief says what failed; an older hub's runAnyway: false is ignored.
  await launch("s6", "u2", "fleetd/t6", { commands: ["echo broke; exit 3", "echo never"], runAnyway: false });
  await until("the run after the failed setup", () => summary("s6")?.latestRun?.status === "completed");
  const told = service.store.message("s6", "u2")!.text;
  expect(told).toContain("Setup failed in this worktree before you started, and you were started anyway: `echo broke; exit 3` exited 3 after 0 s. Not run after it: `echo never`.");
  expect(told).toContain("broke");

  // With inputs, a worktree set up before with the same ones is not set up again.
  const plan = { commands: ["date >> runs.txt"], inputs: ["README.md"] };
  const first = await launch("s7", "u3", "fleetd/t7", plan);
  await until("the first setup", () => summary("s7")?.latestRun?.status === "completed");
  await ok("send", { sessionId: "s7", runId: "u4", text: "again" });
  await until("the second run", () => summary("s7")?.latestRun?.id === "u4" && summary("s7")?.latestRun?.status === "completed");
  expect(readFileSync(join(first.summary.worktreePath, "runs.txt"), "utf8").trim().split("\n")).toHaveLength(1);
});

test("files: attachments are written under .fleetd/attachments and found again by their hash", async () => {
  const rel = ".fleetd/attachments/W1/a.txt";
  await ok("put_file", { projectId: "p1", relPath: rel, dataB64: Buffer.from("hi").toString("base64") });
  const sha = new Bun.CryptoHasher("sha256").update("hi").digest("hex");
  expect((await ok("has_file", { projectId: "p1", relPath: rel, sha256: sha })).has).toBe(true);
  expect((await ok("read_file", { projectId: "p1", path: rel })).contents).toBe("hi");
  const outside = await call("put_file", { projectId: "p1", relPath: "../x", dataB64: "aGk=" });
  expect(outside.result).toMatchObject({ err: { code: "invalid" } });
  expect((await ok("list_files", { projectId: "p1", query: "", limit: 10 })).paths).toEqual([]);
});

test("windows, items, spans and the project calls answer from the store and the checkout", async () => {
  frames.length = 0;
  await ok("subscribe", { after: 0, spansAfter: 0 });
  await ok("send", { sessionId: "s1", runId: "r5", text: "spans: please" });
  await until("the spans", () => frames.some((f) => f.t === "spans"));
  const spans = frames.find((f) => f.t === "spans") as Record<string, any>;
  expect(spans.spans.map((x: { key: string }) => x.key)).toEqual(["r5/1", "r5/2", "r5/3"]);
  service.spansAcked(spans.toRid, false);
  expect(service.store.spansAfter(0, 10)).toEqual([]);
  await until("the run", () => summary("s1")?.latestRun?.id === "r5" && summary("s1")?.latestRun?.status === "completed");
  // A cursor replays what came after it.
  frames.length = 0;
  await ok("subscribe", { after: service.store.latestSeq() - 1 });
  expect(frames.filter((f) => f.t === "machine_event")).toHaveLength(1);
  const item = service.store.newestItems("s3", 5)[0][0]!;
  expect((await ok("read_item", { sessionId: "s3", itemId: item.id })).item.id).toBe(item.id);
  const window = await ok("window", { sessionId: "s3", itemId: item.id, before: 2, after: 2 });
  expect(window.focus).toBeDefined();
  expect((await call("read_item", { sessionId: "s3", itemId: "nope" })).result).toMatchObject({ err: { code: "not_found" } });
  await ok("release", { sessionId: "s1" });
  expect((await ok("default_branch", { projectId: "p1" })).branch).toBe("main");
  const worktrees = (await ok("project_worktrees", { projectId: "p1" })).worktrees as { sessionId: string; branch: string; uncommitted: boolean }[];
  // s5's setup left made.txt, which git doesn't track: it holds work.
  expect(worktrees.find((w) => w.sessionId === "s5")).toMatchObject({ branch: "fleetd/t5", uncommitted: true });
  // Each worktree keeps its own answer, though git reads them all at once.
  expect(worktrees.map((w) => [w.sessionId, w.uncommitted])).toEqual([
    ["s5", true],
    ["s6", false],
    ["s7", true],
  ]);
  const made = join(home.dir, "made");
  expect(await ok("folder_make", { path: made, gitInit: true })).toEqual({ kind: "folder", path: made });
  expect(existsSync(join(made, ".git"))).toBe(true);
  expect((await call("folder_make", { path: repo })).result).toMatchObject({ err: { message: expect.stringContaining("folder not empty: ") } });
  expect((await ok("repo_inspect", { path: repo })).defaultBranch).toBe("main");
  // repo_scan reads the user's home: here, the test's own.
  mkdirSync(join(home.dir, "src"), { recursive: true });
  spawnSync("git", ["init", "-q", join(home.dir, "src", "one")]);
  expect(scan(home.dir)).toEqual({ cloneRoot: join(home.dir, "src"), repos: [{ path: join(home.dir, "src", "one") }] });
  expect(await ok("project_env", { projectId: "p1", set: [{ name: "PLAIN", value: "1" }], remove: [] })).toEqual({ kind: "project_env", secrets: [] });
  expect((await call("project_env", { projectId: "p1", set: [{ name: "CLAUDE_X", value: "1" }], remove: [] })).result).toMatchObject({ err: { code: "invalid" } });
  await ok("project_upsert", { projectId: "p9", title: "copy", workspaceRoot: made });
  await ok("project_env_copy", { from: "p1", to: "p9" });
  expect(await ok("order_env_drop", { projectId: "p1", orderId: "W1" })).toEqual({ kind: "done" });
});

test("a run that failed on the network is retried by the node under a fresh uuid, and completes as the same run", async () => {
  await ok("send", { sessionId: "s1", runId: "r6", text: "flaky: once" });
  await until("the retried run", () => summary("s1")?.latestRun?.id === "r6" && summary("s1")?.latestRun?.status === "completed");
  expect(service.store.item("s1", "node-retry-r6-1")).toMatchObject({ kind: { type: "node_retry", attempt: 1, of: 3, reason: { class: "network" } } });
  expect(service.store.runs("s1").filter((r) => r.id === "r6")).toHaveLength(1);
});

test("a model claude refuses falls back to the profile's own, once, and the session says so", async () => {
  await ok("launch", {
    sessionId: "s4",
    projectId: "p1",
    runtimeMode: "full-access",
    workspace: { type: "root" },
    prompt: "refuse-model: hi",
    runId: "m1",
    profile: "high",
    model: "claude-nonesuch-1",
    effort: "high",
  });
  await until("the run on the fallback model", () => summary("s4")?.latestRun?.status === "completed", 10_000);
  expect(summary("s4")).toMatchObject({ model: "claude-opus-5-5", modelRefused: "claude-nonesuch-1" });
});

test("a tagged send's receipts follow claude's frames: delivered as a turn, then acknowledged by its reply", async () => {
  frames.length = 0;
  await ok("subscribe", { after: service.store.latestSeq() });
  await ok("send", { sessionId: "s1", runId: "r7", text: "steer me", steer: { id: "S1", riders: ["S0"] } });
  await until("both acknowledgements", () => frames.filter((f) => (f.event as { stage?: string })?.stage === "acknowledged").length === 2);
  const receipts = frames.filter((f) => (f.event as { type?: string })?.type === "steer").map((f) => f.event as Record<string, unknown>);
  expect(receipts.filter((r) => r.steerId === "S1").map((r) => r.stage)).toEqual(["delivered", "acknowledged"]);
  expect(receipts.find((r) => r.steerId === "S1" && r.stage === "delivered")).toMatchObject({ how: "turn", runId: "r7", sessionId: "s1" });
  expect(receipts.find((r) => r.steerId === "S1" && r.stage === "acknowledged")).toMatchObject({ excerpt: "ok: steer me", messageId: "msg-r7" });
});

test("a run whose stream went quiet across a sleep is interrupted after the wake and resumed by the node's retry", async () => {
  await ok("send", { sessionId: "s1", runId: "r8", text: "hang: until woken" });
  await until("the run to start", () => summary("s1")?.latestRun?.status === "running");
  await Bun.sleep(20);
  service.woke(0);
  await until("the run resumed after the wake", () => summary("s1")?.latestRun?.id === "r8" && summary("s1")?.latestRun?.status === "completed");
  expect(service.store.item("s1", "node-retry-r8-1")).toMatchObject({ kind: { reason: { class: "network" } } });
});

test("a Monitor that dies with its claude wakes the session once to say so", async () => {
  await ok("send", { sessionId: "s1", runId: "r9", text: "monitor: wait for ci" });
  const ended: string[] = [];
  service.onItemEnded = (session, item) => ended.push(`${session}/${item.id}`);
  await until("the armed Monitor", () => service.store.session("s1")?.local.monitors?.length === 1);
  expect(ended).toEqual(["s1/mon-r9"]);
  await until("the run", () => summary("s1")?.latestRun?.id === "r9" && summary("s1")?.latestRun?.status === "completed");
  // Its claude dies while it waits.
  process.kill(service.store.session("s1")!.local.pid!, "SIGKILL");
  const woken = await until("the wake", () => service.store.runs("s1").find((r) => r.id.startsWith("s1-monitor-lost-") && r.status === "completed"));
  expect(service.store.message("s1", woken.id)?.text).toBe(
    'Your Monitor "ci" was lost when your claude process exited. Check what you were waiting for again.',
  );
  expect(service.store.session("s1")?.local.monitors).toBeUndefined();
});

test("a session whose host ran on through a node restart is re-adopted and keeps going", async () => {
  const pid = service.store.session("s1")?.local.pid;
  await service.shutdown();
  service = await SessionService.start(config());
  service.attach((f) => frames.push(f));
  expect(service.store.session("s1")?.local.pid).toBe(pid);
  await ok("send", { sessionId: "s1", runId: "r4", text: "after the restart" });
  await until("the run after the restart", () => summary("s1")?.latestRun?.id === "r4" && summary("s1")?.latestRun?.status === "completed");
  // Nothing was applied twice: each run's message is stored once.
  const [messages] = service.store.newestMessages("s1", 50);
  expect(messages.filter((m) => m.text === "ok: hello there")).toHaveLength(1);
});

test("an interrupt with no process closes the run, and a stop ends the session's process", async () => {
  await ok("stop", { sessionId: "s1" });
  expect(service.store.session("s1")?.local.pid).toBeUndefined();
  expect(await ok("interrupt", { sessionId: "s1" })).toEqual({ kind: "done" });
  await ok("project_remove", { projectId: "p9", erase: true });
  expect(service.store.project("p9")).toBeUndefined();
  const unknown = await call("bogus_op");
  expect(unknown.result).toMatchObject({ err: { code: "runner_unavailable" } });
});

test("a lead's launch tells the screens, and what its browsers filled is masked in what it reports", async () => {
  const launched: string[] = [];
  const filled: [string, string][] = [];
  service.screens = {
    launched: (thread, role, projectId) => void launched.push(`${thread} ${role} ${projectId}`),
    filledSince: (_thread, known) => (filled.length > known ? [...filled] : undefined),
    holdsScreen: () => false,
    forgetSignins: async () => {},
  };
  try {
    filled.push(["op://Team/Shop/password", "Sekr3t-Value-99"]);
    await ok("launch", { sessionId: "s-filled", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "typed Sekr3t-Value-99", runId: "rf1", role: "lead" });
    await until("the run to complete", () => summary("s-filled")?.latestRun?.status === "completed");
    expect(launched).toEqual(["s-filled lead p1"]);
    expect(summary("s-filled")?.latestAssistantTail).toBe("ok: typed ***op://Team/Shop/password***");
  } finally {
    service.screens = undefined;
  }
});
