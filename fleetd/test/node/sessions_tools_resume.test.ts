// A session's claude keeps the definition of each fleetd tool it started with, whatever a later tools/list says. After
// an update changes one, the session's next turn resumes it first, once, with a line in its steps; a message sent
// during that resume lands once. A tool that is only new reaches it through tools/list_changed, with no resume.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolMarks } from "../../src/cli/agent_mcp/tools.ts";
import { SessionService, type SessionConfig } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

const home = tempHome();
const repo = join(home.dir, "repo");
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
setDefaultTimeout(30_000);
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
    if (got !== undefined && got !== false) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

const ID = "s-lead";
const marksFile = () => join(home.dir, "node", "sessions", ID, "tools.json");
const pid = () => service.store.session(ID)!.local.pid;
const run = (runId: string) => service.store.runs(ID).find((r) => r.id === runId);
const done = (runId: string) => until(`${runId} to complete`, () => run(runId)?.status === "completed");
const said = (text: string) => service.store.newestMessages(ID, 200)[0].filter((m) => m.text === text).length;
const resumes = () => service.store.newestItems(ID, 200)[0].filter((i) => i.kind.type === "starting" && i.kind.text === "Picked up fleetd's updated tools");
const send = (runId: string, text: string) => ok("send", { sessionId: ID, runId, text });

beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  service = await SessionService.start(config());
  service.attach(() => {});
  await ok("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
  await ok("launch", { sessionId: ID, projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "one", runId: "r1", role: "lead" });
  await done("r1");
});

afterAll(async () => {
  await service.stopAll();
  home.done();
});

test("a start keeps the marks of the tools its claude got, and a turn with them unchanged runs on", async () => {
  expect(JSON.parse(readFileSync(marksFile(), "utf8"))).toEqual(toolMarks("lead"));
  const before = pid();
  await send("r2", "two");
  await done("r2");
  expect(pid()).toBe(before);
  expect(resumes()).toHaveLength(0);
});

test("a tool that is only new needs no resume", async () => {
  const { checklist: _, ...without } = toolMarks("lead");
  writeFileSync(marksFile(), JSON.stringify(without));
  const before = pid();
  await send("r3", "three");
  await done("r3");
  expect(pid()).toBe(before);
  expect(resumes()).toHaveLength(0);
});

test("after an update changes a tool it has, the next turn resumes it once, and a message sent meanwhile lands once", async () => {
  // What an older build's node kept: `checklist` as it was before the update gave it a new field.
  writeFileSync(marksFile(), JSON.stringify({ ...toolMarks("lead"), checklist: "the older checklist" }));
  const before = pid();
  const turn = send("r4", "four");
  await until("the resume's step", () => resumes().length === 1);
  // Sent while the old claude is closing and the new one starts.
  await send("r5", "five");
  await turn;
  await done("r4");
  await done("r5");
  expect(pid()).not.toBe(before);
  expect([said("four"), said("ok: four"), said("five"), said("ok: five")]).toEqual([1, 1, 1, 1]);
  expect(resumes()).toHaveLength(1);
  expect(resumes()[0]!.runId).toBe("r4");
  expect(JSON.parse(readFileSync(marksFile(), "utf8"))).toEqual(toolMarks("lead"));
  // One resume per update: the turns after it run on.
  const after = pid();
  await send("r6", "six");
  await done("r6");
  expect(pid()).toBe(after);
  expect(resumes()).toHaveLength(1);
});

test("a hosted session isn't resumed for a changed tool: its box would go with its claude", async () => {
  const row = service.store.session(ID)!;
  row.local.hosted = "boat";
  service.store.commit(row, [], false);
  writeFileSync(marksFile(), JSON.stringify({ ...toolMarks("lead"), checklist: "the older checklist" }));
  const before = pid();
  await send("r7", "seven");
  await done("r7");
  expect(pid()).toBe(before);
  expect(resumes()).toHaveLength(1);
});
