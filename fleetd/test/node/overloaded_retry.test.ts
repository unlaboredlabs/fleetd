// B1 of the Nov 26 sweep: Claude overloaded, then back. The lead showed "retrying…" for 17 minutes, and a message sent
// once Claude was back got no reply until Stop, because the node's retry waited out its delay (1, 4, then 15 min)
// whatever came meanwhile. Here claude (test/node/fake-host.ts) asks a stand-in endpoint that answers 529, then
// recovers: a new message sends the waiting retry at once, and both turns complete without waiting out the delay.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { retryDelayMs, SessionService, type SessionConfig } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(30_000);
const home = tempHome();
let overloaded = true;
let asked = 0;
const endpoint = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => {
    asked++;
    return overloaded ? new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 }) : Response.json({ ok: true });
  },
});
let service: SessionService;

// A wait no test sits through: only a message cuts it short.
const WAIT_MS = 120_000;
const config = (): SessionConfig => ({
  home: join(home.dir, "node"),
  claudeEnv: join(home.dir, "claude.env"),
  baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
  claudeBin: "/bin/true",
  fleetd: [join(import.meta.dir, "fake-host.sh")],
  retryScheduleMs: [WAIT_MS, WAIT_MS, WAIT_MS],
  idleReapMs: 60_000,
});

let calls = 0;
const ok = async (op: string, args: Record<string, unknown> = {}) => {
  const reply = await service.handle({ id: `c${++calls}`, call: { op, ...args } as never });
  if (!("ok" in reply.result)) throw new Error(`${op}: ${JSON.stringify(reply.result)}`);
  return reply.result.ok as Record<string, any>;
};
const until = async <T>(what: string, fn: () => T | undefined, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got !== undefined && got !== false) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};
const run = (id: string) => service.store.runs("s1").find((r) => r.id === id);

beforeAll(async () => {
  const repo = join(home.dir, "repo");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "-C", repo, "init", "-q", "-b", "main"]);
  Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  writeFileSync(join(home.dir, "claude.env"), `ANTHROPIC_BASE_URL=http://127.0.0.1:${endpoint.port}\n`);
  service = await SessionService.start(config());
  service.attach(() => {});
  await ok("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
});

afterAll(async () => {
  await service.stopAll();
  endpoint.stop(true);
  home.done();
});

test("the node's retries are short and capped: 15 s, 30 s, 1 min, then every 2 min for about an hour", () => {
  expect([1, 2, 3, 4, 5, 30].map((a) => retryDelayMs(a, 0.5))).toEqual([15_000, 30_000, 60_000, 120_000, 120_000, 120_000]);
  expect(retryDelayMs(31, 0.5)).toBeUndefined();
});

test("a message sent while a turn waits out an Overloaded retry sends the retry at once, and both turns complete", async () => {
  await ok("launch", { sessionId: "s1", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hello", runId: "r1" });
  // Claude gave up on the 529s: the node keeps the turn and says when it goes again.
  const retry = await until("the node's retry", () => service.store.item("s1", "node-retry-r1-1"));
  expect(retry.kind).toMatchObject({ type: "node_retry", attempt: 1, delayMs: WAIT_MS, reason: { class: "overloaded" } });
  const retryAt = Date.parse((retry.kind as { retryAt: string }).retryAt);
  expect(retryAt - Date.parse(retry.completedAt!)).toBe(WAIT_MS);
  expect(run("r1")?.status).toBe("running");

  // Claude is back; the person writes again, well before the retry's time.
  overloaded = false;
  const before = asked;
  await ok("send", { sessionId: "s1", runId: "r2", text: "are you there?" });
  await until("both turns", () => run("r1")?.status === "completed" && run("r2")?.status === "completed");
  expect(Date.now()).toBeLessThan(retryAt);
  // The retry went first, then the message, each one call.
  expect(asked - before).toBe(2);
  expect(service.store.message("s1", "msg-r2")?.text).toBe("ok: are you there?");
});

test("a retry that meets Claude still overloaded waits its next delay, and the next message cuts that short too", async () => {
  overloaded = true;
  await ok("send", { sessionId: "s1", runId: "r3", text: "again" });
  await until("the first retry's wait", () => service.store.item("s1", "node-retry-r3-1"));
  await ok("send", { sessionId: "s1", runId: "r4", text: "still there?" });
  // The retry went at once and failed again: its second wait.
  await until("the second retry's wait", () => service.store.item("s1", "node-retry-r3-2"));
  overloaded = false;
  await ok("send", { sessionId: "s1", runId: "r5", text: "now?" });
  await until("every turn", () => ["r3", "r4", "r5"].every((r) => run(r)?.status === "completed"));
});
