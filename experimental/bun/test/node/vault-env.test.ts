// Env vars from the vault reach agents' sessions as today's did (vault-design §4.4): the hub delivers a project's
// variables with `project_env` and an order's with an `order:` sink's `secret_deliver`, each secret sealed to this
// node, and the node gives them to each claude it starts by today's scoping: a project's to its sessions, an order's
// only to that order's (in place of the project's of the same name), none to another project's. A secret one is masked
// in what the session reports, and the node keeps no copy of a value beyond its own 0600 files and the claude's
// environment.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadOrCreateBoxKey } from "../../src/node/identity.ts";
import { deliverSecret } from "../../src/node/secrets/index.ts";
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
const summary = (id: string) => service.store.session(id)?.summary;
const until = async (what: string, fn: () => boolean) => {
  for (const end = Date.now() + 20_000; !fn(); await Bun.sleep(20)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};
/** The environment the session's claude was started with (the fake host writes it). */
const envOf = (id: string) => JSON.parse(readFileSync(join(nodeHome, "hosts", id, "env.json"), "utf8")) as Record<string, string>;

const PROJECT_SECRET = "vault-project-Secr3t-7781";
const ORDER_SECRET = "vault-order-Secr3t-4412";

beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  service = await SessionService.start({
    home: nodeHome,
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    nativeBin: join(import.meta.dir, "fake-host.sh"),
    retryScheduleMs: [50, 50, 50],
    idleReapMs: 60_000,
    boxKey,
  });
  for (const p of ["p1", "p2"]) await ok("project_upsert", { projectId: p, title: p, workspaceRoot: repo });
});

afterAll(async () => {
  await service.stopAll();
  home.done();
});

test("vault variables reach a project's sessions, an order's only that order's, and never another project's; secrets masked", async () => {
  // As the vault delivers them: the project's set (a plain one, a secret sealed to this node), then an order's.
  const saved = await ok("project_env", {
    projectId: "p1",
    set: [
      { name: "API_URL", value: "https://api.devbox.test" },
      { name: "SHARED", value: "from-project" },
      { name: "STRIPE_KEY", sealed: sealed(PROJECT_SECRET) },
    ],
    remove: [],
  });
  expect(saved.secrets.map((s: { name: string }) => s.name)).toEqual(["STRIPE_KEY"]);
  const ctx = { machineId: "devbox", roots: [repo], home: nodeHome, boxKey };
  for (const [name, value] of [["DEPLOY_TOKEN", ORDER_SECRET], ["SHARED", "from-order"]] as const) {
    const delivered = deliverSecret({ id: `d-${name}`, sink: "order:devbox:W7", sealed: sealed(value), secretKey: `vault.${name}`, envName: name, projectId: "p1" } as never, ctx);
    expect(delivered.error).toBeUndefined();
  }
  // The node's files are its own: 0600.
  for (const file of [join(nodeHome, "project-env", "p1.json"), join(nodeHome, "order-env", "p1", "W7.json")]) expect(statSync(file).mode & 0o777).toBe(0o600);

  const launch = (sessionId: string, projectId: string, prompt: string, orderId?: string) =>
    ok("launch", { sessionId, projectId, runtimeMode: "full-access", workspace: { type: "root" }, prompt, runId: `r-${sessionId}`, ...(orderId ? { orderId } : {}) });
  await launch("s-project", "p1", `typed ${PROJECT_SECRET}`);
  await launch("s-order", "p1", `typed ${ORDER_SECRET} and ${PROJECT_SECRET}`, "W7");
  await launch("s-other", "p2", "hello");
  for (const id of ["s-project", "s-order", "s-other"]) await until(`${id}'s run`, () => summary(id)?.latestRun?.status === "completed");

  const project = envOf("s-project");
  expect([project.API_URL, project.SHARED, project.STRIPE_KEY, project.DEPLOY_TOKEN]).toEqual(["https://api.devbox.test", "from-project", PROJECT_SECRET, undefined]);
  const order = envOf("s-order");
  expect([order.API_URL, order.SHARED, order.STRIPE_KEY, order.DEPLOY_TOKEN]).toEqual(["https://api.devbox.test", "from-order", PROJECT_SECRET, ORDER_SECRET]);
  const other = envOf("s-other");
  expect([other.API_URL, other.SHARED, other.STRIPE_KEY, other.DEPLOY_TOKEN]).toEqual([undefined, undefined, undefined, undefined]);
  // What a session reports is masked by name.
  expect(summary("s-project")?.latestAssistantTail).toBe("ok: typed ***STRIPE_KEY***");
  expect(summary("s-order")?.latestAssistantTail).toBe("ok: typed ***DEPLOY_TOKEN*** and ***STRIPE_KEY***");
  // The node's session store holds no value it got from the vault (a title is the person's own prompt, as typed).
  const store = JSON.stringify([{ ...summary("s-project"), title: "" }, { ...summary("s-order"), title: "" }, service.store.session("s-order")?.local]);
  for (const value of [PROJECT_SECRET, ORDER_SECRET]) expect(store).not.toContain(value);
});
