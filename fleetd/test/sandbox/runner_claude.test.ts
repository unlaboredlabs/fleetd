// The hub's runner gets the team's Claude account with nobody saving it again. On the devbox's hub the hub's API key
// (through a gateway at a tailnet address) was saved while a computer of the team's was the only machine; the hosted
// sandbox provider came later, and with it the runner, which joined holding no key: it stayed degraded with "agents in
// hosted sandboxes run on a Claude account, and none reaches them", and no hosted agent could start. Here the same:
// a computer (`devbox`, its own fleetd node in a process of its own) holds the key, then E2B's stand-in is connected,
// the runner joins, and a machine holding the key seals it to the runner (`claude_account_reseal`), endpoint and all.
// No real claude, no network beyond loopback, and the hub never sees the key.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../../src/hub/api/hub.ts";
import { type Caller, Registry } from "../../src/hub/api/registry.ts";
import { accounts } from "../../src/hub/claude_accounts/tools.ts";
import { doctor } from "../../src/hub/doctor/index.ts";
import { executors } from "../../src/hub/executor/index.ts";
import { boxKey } from "../../src/hub/hub_links/store.ts";
import { serve, stop } from "../../src/hub/http/index.ts";
import { dialUrl, Runner, runner, type Spawn } from "../../src/hub/runner/index.ts";
import { registerAll } from "../../src/hub/serve/areas.ts";
import { startAll } from "../../src/hub/serve/loops.ts";
import { HubDb } from "../../src/hub/store/db.ts";
import { store } from "../../src/hub/store/hub_store.ts";
import { readConfig, writeConfig } from "../../src/node/config.ts";
import { joinConfig, startNode, type RunningNode } from "../../src/node/index.ts";
import { useRunner } from "../../src/node/place/index.ts";
import { Boxes, setBoxes } from "../../src/node/sandbox/remote/boxes.ts";
import { provider } from "../../src/sandbox/providers/index.ts";
import { RUNNER_ID } from "../../src/shared/sandbox.ts";
import { publicKeyOf, seal } from "../../src/shared/sealed_box.ts";
import { seedHubDb } from "../helpers.ts";
import { e2bStandIn, KEY } from "./stand_ins.ts";

setDefaultTimeout(120_000);

const MAIN = join(import.meta.dir, "../../src/main.ts");
const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-runner-claude-"));
const ENV = { FLEETD_HOME: join(tmp, "fleetd"), HOME: join(tmp, "home") };
const before = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENV);
mkdirSync(ENV.HOME, { recursive: true });
// A gateway at a tailnet address, as on the devbox's hub: nothing here dials it.
const ENDPOINT = "http://100.100.1.1:8317";

const cleanups: (() => unknown)[] = [];
afterAll(async () => {
  for (const f of cleanups.reverse()) await f();
  for (const [k, v] of Object.entries(before)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function until<T>(what: string, f: () => T | undefined | Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

test("a hub key saved before the hosted provider reaches the runner, which comes online on it", async () => {
  const e2b = e2bStandIn();
  cleanups.push(() => e2b.stop());
  const home = join(tmp, "hub");
  seedHubDb(home);
  const hub = new Hub({ home, listen: { host: "127.0.0.1", port: 0 } }, HubDb.open(home), { now: () => Date.now() });
  const tools = new Registry();
  registerAll(tools);
  // The runner's node, in this process, with E2B's stand-in (as no_machine.test.ts starts it).
  let node: RunningNode | undefined;
  let url = "";
  const spawn: Spawn = (args, stdin) => {
    const nodeHome = args[args.indexOf("--home") + 1]!;
    const joining = args[1] === "join";
    const config = joining ? joinConfig(nodeHome, { hub: url, token: stdin!, machine: RUNNER_ID, runner: true }) : readConfig(nodeHome)!;
    if (joining) writeConfig(nodeHome, config);
    const started = startNode(nodeHome, config, joining ? stdin : undefined, false, {
      boxes: (h, m, k) => new Boxes(h, m, k, { provider: (p, auth) => provider(p, auth, { urls: { api: e2b.url, sandbox: (box, port) => `${e2b.url}/box/${box}/${port}` }, pollMs: 5 }) }),
    }).then((n) => (node = n));
    return { exited: started.then((n) => n.done), kill: () => void started.then((n) => n.stop()) };
  };
  hub.area("runner", (h) => new Runner(h, spawn, undefined));
  const server = serve(hub, tools, 0);
  url = dialUrl("127.0.0.1", server.port!);
  // The team's computer: a fleetd node of its own, in its own process, as `fleetd node join` runs it.
  const devboxHome = join(tmp, "devbox");
  const devbox = Bun.spawn([process.execPath, MAIN, "node", "join", "--hub", url, "--token-file", "-", "--machine", "devbox", "--home", devboxHome], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, FLEETD_HOME: devboxHome },
  });
  devbox.stdin.write(`${hub.auth.nodes.createEnrollToken("devbox", "test").token}\n`);
  void devbox.stdin.end();
  cleanups.push(async () => {
    hub.shutdown.abort();
    devbox.kill("SIGTERM");
    await devbox.exited;
    await node?.stop();
    useRunner(undefined);
    setBoxes(undefined);
    await stop(server);
    hub.db.close();
  });
  doctor(hub).runCmd = async () => ({ ran: false, error: "ENOENT" });
  doctor(hub).health = async () => ({ ok: true }) as never;
  startAll(hub);
  runner(hub).start(url);

  const ownerId = "p_aaaaaaaa";
  hub.db.conn.query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, 'Owner', 'owner', 0)").run(ownerId);
  const owner: Caller = {
    keyId: "k_owner",
    name: "owner-desk",
    prefix: "fld_x",
    grants: [{ role: "admin", machines: "*" }],
    createdAt: new Date().toISOString(),
    kind: "human",
    person: { personId: ownerId, name: "Owner" },
  };
  const call = async (tool: string, input: Record<string, unknown>): Promise<any> => {
    const r = await tools.call(hub, owner, tool, input);
    if ("output" in r) return r.output;
    throw new Error(`${tool}: ${r.error.kind === "tool" ? `${r.error.error.message} ${r.error.error.fix ?? ""}` : r.error.kind}`);
  };

  // 1. The hub's API key, through the tailnet gateway, sealed to the only machine there is.
  const pub = await until("devbox's node", () => (executors(hub).isConnected("devbox") ? store(hub).machineGet("devbox")?.boxPubKey : undefined));
  const sealed = Buffer.from(seal(Buffer.from(pub, "base64"), new TextEncoder().encode("sk-ant-test-0123456789"))).toString("base64");
  await call("claude_hub_api_set", { sealed: [{ machineId: "devbox", sealed }], endpoint: ENDPOINT });
  expect(accounts(hub).hubApi()!.sealedOn.map((s) => s.machineId)).toEqual(["devbox"]);

  // 2. Later, the team's E2B key: the hub starts its runner, which joins holding no Claude account.
  const sealedKey = Buffer.from(seal(publicKeyOf(boxKey(hub)), new TextEncoder().encode(JSON.stringify({ key: KEY })))).toString("base64");
  await call("sandbox_connect", { provider: "e2b", sealed: sealedKey, limit: 2 });
  expect(runner(hub).running).toBe(true);

  // 3. With nobody saving the key again, the runner holds it, with its endpoint, and comes online on it.
  const machine = await until("the runner online", () => {
    const m = store(hub).machineGet(RUNNER_ID);
    return m?.status === "online" ? m : undefined;
  });
  expect(machine.degradedReason ?? "").not.toContain("none reaches them");
  const held = accounts(hub).hubApi()!.sealedOn;
  expect(held.map((s) => s.machineId)).toEqual(["devbox", RUNNER_ID]);
  expect(held[1]!.fingerprint).toBe(held[0]!.fingerprint);
  const file = join(runner(hub).home, "claude-accounts", "hub.json");
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).endpoint).toBe(ENDPOINT);
});
