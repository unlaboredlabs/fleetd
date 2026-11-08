// The session service over a session host (test/node/fake-host.ts, the Rust `session-host`'s socket protocol):
// projects, launches in the root and a worktree, the machine and thread streams, a permission asked and answered,
// a stop that removes its worktree, and a session re-adopted from its host after the node restarted.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
  nativeBin: join(import.meta.dir, "fake-host.sh"),
});

const git = (...args: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
let calls = 0;
const call = (op: string, args: Record<string, unknown> = {}) => service.handle({ id: `c${++calls}`, call: { op, ...args } as never });
const ok = async (op: string, args: Record<string, unknown> = {}) => {
  const reply = await call(op, args);
  if (!("ok" in reply.result)) throw new Error(`${op}: ${JSON.stringify(reply.result)}`);
  return reply.result.ok as Record<string, any>;
};
const until = async <T>(what: string, fn: () => T | undefined, ms = 5000): Promise<T> => {
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
  expect((await ok("project_worktrees", { projectId: "p1" })).worktrees).toEqual([]);
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
