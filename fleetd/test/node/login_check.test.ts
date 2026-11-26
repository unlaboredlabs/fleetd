// S1 of the Nov 26 sweep: a bad key in claude.env, and Machines said Idle 0.4 s after Claude refused it. The refusal now
// stands, and the node tries the key itself on the endpoint's free model list, again and again, until it passes: a bad
// key never reads as fine, and a refusal that was a blip on Claude's side heals with nobody doing anything.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionService } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(30_000);
const home = tempHome();
let refusing = true;
const tried: string[] = [];
const endpoint = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    tried.push(new URL(req.url).pathname);
    return refusing ? new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 }) : Response.json({ data: [] });
  },
});
let service: SessionService;

beforeAll(async () => {
  const repo = join(home.dir, "repo");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "-C", repo, "init", "-q", "-b", "main"]);
  Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  writeFileSync(join(home.dir, "claude.env"), `ANTHROPIC_API_KEY=sk-test\nANTHROPIC_BASE_URL=http://127.0.0.1:${endpoint.port}\n`);
  service = await SessionService.start({
    home: join(home.dir, "node"),
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    fleetd: [join(import.meta.dir, "fake-host.sh")],
    retryScheduleMs: [],
    idleReapMs: 60_000,
    authCheckMs: [150, 150],
  });
  service.attach(() => {});
  const reply = await service.handle({ id: "c1", call: { op: "project_upsert", projectId: "p1", title: "demo", workspaceRoot: repo } as never });
  expect("ok" in reply.result).toBe(true);
});

afterAll(async () => {
  await service.stopAll();
  endpoint.stop(true);
  home.done();
});

test("a key Claude refused stays refused while the endpoint refuses it, and clears by itself once it takes it", async () => {
  await service.handle({ id: "c2", call: { op: "launch", sessionId: "s1", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hello", runId: "r1" } as never });
  for (let i = 0; i < 500 && service.store.runs("s1").find((r) => r.id === "r1")?.status !== "failed"; i++) await Bun.sleep(20);
  const refused = await service.runnerInfo();
  expect(refused.login).toBe("logged_out");
  expect(refused.problem).toContain("Fix: replace the key in");
  // Several of the node's own checks later, the key is still refused: still not usable.
  await Bun.sleep(700);
  expect(tried.filter((p) => p === "/v1/models").length).toBeGreaterThanOrEqual(2);
  expect((await service.runnerInfo()).login).toBe("logged_out");
  // Claude takes it again: the next check clears the refusal, with nobody changing anything.
  refusing = false;
  let info = await service.runnerInfo();
  for (let i = 0; i < 100 && info.login === "logged_out"; i++) {
    await Bun.sleep(20);
    info = await service.runnerInfo();
  }
  expect(info.login).not.toBe("logged_out");
  expect(info.problem ?? "").not.toContain("refused its login");
});
