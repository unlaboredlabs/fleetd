// A command that prints a session's secret by accident: whole, or line by line as `env | cut -d= -f1` prints a
// multi-line value (a PEM key's body lines, the last one cut at its `=` padding). The node's stored transcript, the
// agent's chat text, a call it posts, a screen recording's action log and claude's own conversation file (once its
// claude exits) show only the marker, and the session resumes from that file as before. Made-up values only.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { appendAction, Scrub, Steps } from "../../src/node/browser/record.ts";
import { loadOrCreateBoxKey } from "../../src/node/identity.ts";
import { SessionService } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(30_000);
const home = tempHome();
const nodeHome = join(home.dir, "node");
const repo = join(home.dir, "repo");
const boxKey = loadOrCreateBoxKey(nodeHome);
const sealed = (value: string) => Buffer.from(boxKey.seal(Buffer.from(value))).toString("base64");
let service: SessionService;
let calls = 0;
const ok = async (op: string, args: Record<string, unknown> = {}) => {
  const reply = await service.handle({ id: `c${++calls}`, call: { op, ...args } as never });
  if (!("ok" in reply.result)) throw new Error(`${op}: ${JSON.stringify(reply.result)}`);
  return reply.result.ok as Record<string, any>;
};
const until = async (what: string, fn: () => boolean) => {
  for (const end = Date.now() + 20_000; !fn(); await Bun.sleep(20)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};

const TOKEN = "made-up-token-Qx7Lw2Vb9Rt4";
// A made-up key: base64 of filler text, armored as a PEM private key, its last line ending in `=` padding.
const BODY = Buffer.from("not a real key, only filler for a test of fleetd's masking: ".repeat(7) + "end.").toString("base64");
const KEY = ["-----BEGIN PRIVATE KEY-----", ...(BODY.match(/.{1,64}/g) ?? []), "-----END PRIVATE KEY-----"].join("\n");
const BODY_LINES = KEY.split("\n").slice(1, -1);

/** Whether `text` holds any of the made-up values, or a piece of one. */
const leaks = (text: string) => [TOKEN, ...BODY_LINES, ...BODY_LINES.map((l) => l.replace(/=+$/, ""))].filter((v) => text.includes(v));

beforeAll(async () => {
  expect(BODY_LINES.length).toBeGreaterThan(3);
  expect(BODY_LINES.at(-1)).toMatch(/=$/);
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  service = await SessionService.start({
    home: nodeHome,
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    fleetd: [join(import.meta.dir, "fake-host.sh")],
    retryScheduleMs: [50, 50, 50],
    idleReapMs: 60_000,
    boxKey,
  });
  await ok("project_upsert", { projectId: "p1", title: "p1", workspaceRoot: repo });
  await ok("project_env", { projectId: "p1", set: [{ name: "DEPLOY_TOKEN", sealed: sealed(TOKEN) }, { name: "APP_KEY", sealed: sealed(KEY) }], remove: [] });
});

afterAll(async () => {
  await service.stopAll();
  home.done();
});

test("a command printing a secret, whole and line by line, leaves only the marker in the transcript, chat, recording and claude's file", async () => {
  await ok("launch", { sessionId: "s1", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "print:DEPLOY_TOKEN", runId: "r1" });
  await until("the first run", () => service.store.session("s1")?.summary.latestRun?.status === "completed");
  await ok("send", { sessionId: "s1", runId: "r2", text: "print:APP_KEY" });
  await until("the second run", () => service.store.session("s1")?.summary.latestRun?.id === "r2" && service.store.session("s1")?.summary.latestRun?.status === "completed");

  // The transcript the node keeps (and streams to the hub): each command's output, masked by name.
  const [items] = service.store.newestItems("s1", 50);
  const outputs = items.flatMap((i) => (i.kind.type === "command" ? [i.kind.output ?? ""] : []));
  expect(outputs).toHaveLength(2);
  expect(outputs[0]).toBe("***DEPLOY_TOKEN***\nDEPLOY_TOKEN\n");
  expect(outputs[1]!.split("\n").slice(0, 2)).toEqual(["***APP_KEY***", "APP_KEY"]);
  for (const line of outputs[1]!.split("\n").slice(2, 2 + BODY_LINES.length)) expect(line).toBe("***APP_KEY***");
  expect(outputs[1]).toContain("-----END PRIVATE KEY-----");
  // The agent's chat text, and what it posts to the hub (a lead channel's call masks with the same masker).
  const [messages] = service.store.newestMessages("s1", 50);
  const said = messages.map((m) => m.text).join("\n");
  expect(said).toContain("***APP_KEY***");
  expect(JSON.stringify(service.maskFor("s1").value({ op: "agent_message", text: `it printed ${KEY} and ${TOKEN}` }))).toBe(
    JSON.stringify({ op: "agent_message", text: "it printed ***APP_KEY*** and ***DEPLOY_TOKEN***" }),
  );
  // A screen's recording: its action log, scrubbed with the session's secrets.
  const dir = join(home.dir, "recording");
  appendAction(dir, { seq: 1, at: new Date(0).toISOString(), offsetMs: 0, tool: "eval", args: {}, ok: true, result: outputs.join("") + KEY, durationMs: 1 } as never, new Scrub(service.secretsFor("s1")), new Steps(), "s1");
  const log = readFileSync(join(dir, "actions.jsonl"), "utf8");
  expect(log).toContain("***APP_KEY***");
  for (const text of [JSON.stringify(items), JSON.stringify(service.store.session("s1")?.summary), said, log]) expect(leaks(text)).toEqual([]);

  // Claude's own conversation file holds what it printed until its claude exits; then only the marker.
  const file = join(home.dir, ".claude", "projects", realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-"), "s1.jsonl");
  expect(leaks(readFileSync(file, "utf8")).length).toBeGreaterThan(0);
  await ok("stop", { sessionId: "s1" });
  const scrubbed = readFileSync(file, "utf8");
  expect(leaks(scrubbed)).toEqual([]);
  const lines = scrubbed.trimEnd().split("\n").map((l) => JSON.parse(l));
  expect(lines).toHaveLength(4);
  expect(lines[3].message.content[0].content).toContain("***APP_KEY***\nAPP_KEY\n***APP_KEY***");

  // The session resumes from it.
  await ok("send", { sessionId: "s1", runId: "r3", text: "after the scrub" });
  await until("the resumed run", () => service.store.session("s1")?.summary.latestRun?.id === "r3" && service.store.session("s1")?.summary.latestRun?.status === "completed");
  const argv = JSON.parse(readFileSync(join(nodeHome, "hosts", "s1", "argv.json"), "utf8")) as string[];
  expect(argv[argv.indexOf("--resume") + 1]).toBe("s1");
});
