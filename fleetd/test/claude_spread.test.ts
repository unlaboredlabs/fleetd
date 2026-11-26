// A machine that joins after the team's secrets were saved gets them with nobody pasting them again (artifact
// enterprise-sweep-selfhosted, bug 6): the workspace's Claude API key, the team's Gemini key and a person's 1Password
// token were sealed to `devbox`, the only machine then; `dev2` joins later, and `devbox` seals each to dev2's box key
// (`claude_account_reseal`, `gemini_key_reseal`, `onepassword_token_reseal`), which the hub relays to it with the
// endpoint, keeping only the fingerprint. Two real fleetd nodes, each in a process of its own; no real claude, no
// network beyond loopback, and the hub never sees the key.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../src/hub/api/hub.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { accounts } from "../src/hub/claude_accounts/tools.ts";
import { token } from "../src/hub/onepassword/index.ts";
import { doctor } from "../src/hub/doctor/index.ts";
import { executors } from "../src/hub/executor/index.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { startAll } from "../src/hub/serve/loops.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { seal } from "../src/shared/sealed_box.ts";
import { seedHubDb } from "./helpers.ts";

setDefaultTimeout(120_000);

const MAIN = join(import.meta.dir, "../src/main.ts");
const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-claude-spread-"));
const ENV = { FLEETD_HOME: join(tmp, "fleetd"), HOME: join(tmp, "home") };
const before = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENV);
mkdirSync(ENV.HOME, { recursive: true });
// A gateway, as a company's might be: nothing here dials it.
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

test("a machine joined after the team's Claude key, Gemini key and 1Password token were saved gets each from one that holds it", async () => {
  const home = join(tmp, "hub");
  seedHubDb(home);
  const hub = new Hub({ home, listen: { host: "127.0.0.1", port: 0 } }, HubDb.open(home), { now: () => Date.now() });
  const tools = new Registry();
  registerAll(tools);
  const server = serve(hub, tools, 0);
  const url = `http://127.0.0.1:${server.port!}`;
  /** A machine of the team's: a fleetd node of its own, in its own process, as `fleetd node join` runs it. */
  const join_ = (machine: string) => {
    const nodeHome = join(tmp, machine);
    const node = Bun.spawn([process.execPath, MAIN, "node", "join", "--hub", url, "--token-file", "-", "--machine", machine, "--home", nodeHome], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, FLEETD_HOME: nodeHome },
    });
    node.stdin.write(`${hub.auth.nodes.createEnrollToken(machine, "test").token}\n`);
    void node.stdin.end();
    cleanups.push(async () => {
      node.kill("SIGTERM");
      await node.exited;
    });
    return nodeHome;
  };
  cleanups.push(async () => {
    hub.shutdown.abort();
    await stop(server);
    hub.db.close();
  });
  doctor(hub).runCmd = async () => ({ ran: false, error: "ENOENT" });
  doctor(hub).health = async () => ({ ok: true }) as never;
  startAll(hub);

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

  // 1. The workspace's API key through a gateway, the team's Gemini key and the owner's 1Password token, each sealed to
  // the only machine there is.
  join_("devbox");
  const pub = await until("devbox's node", () => (executors(hub).isConnected("devbox") ? store(hub).machineGet("devbox")?.boxPubKey : undefined));
  const sealTo = (value: string) => Buffer.from(seal(Buffer.from(pub, "base64"), new TextEncoder().encode(value))).toString("base64");
  await call("claude_hub_api_set", { sealed: [{ machineId: "devbox", sealed: sealTo("sk-ant-test-0123456789") }], endpoint: ENDPOINT });
  await call("gemini_key_set", { sealed: [{ machineId: "devbox", sealed: sealTo("AIza-test-0123456789") }] });
  await call("onepassword_set", { sealed: [{ machineId: "devbox", sealed: sealTo("ops_test0123456789") }] });
  expect(accounts(hub).hubApi()!.sealedOn.map((s) => s.machineId)).toEqual(["devbox"]);
  expect(accounts(hub).geminiKey()!.sealedOn.map((s) => s.machineId)).toEqual(["devbox"]);
  expect(token(hub.db, ownerId)!.sealedOn.map((s) => s.machineId)).toEqual(["devbox"]);

  // 2. Later, a second machine joins, as `fleetd pair --worker` lets one.
  const dev2 = join_("dev2");

  // 3. With nobody saving the key again, dev2 holds it, the same value, with its endpoint.
  const held = await until("the key on dev2", () => {
    const on = accounts(hub).hubApi()!.sealedOn;
    return on.some((s) => s.machineId === "dev2") ? on : undefined;
  });
  expect(held.map((s) => s.machineId)).toEqual(["dev2", "devbox"]);
  expect(held[0]!.fingerprint).toBe(held[1]!.fingerprint);
  const file = join(dev2, "claude-accounts", "hub.json");
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).endpoint).toBe(ENDPOINT);
  // The Gemini key and the 1Password token too, each the same value as devbox's.
  const gemini = await until("the Gemini key on dev2", () => {
    const on = accounts(hub).geminiKey()!.sealedOn;
    return on.some((s) => s.machineId === "dev2") ? on : undefined;
  });
  expect(gemini.map((s) => s.machineId)).toEqual(["dev2", "devbox"]);
  expect(gemini[0]!.fingerprint).toBe(gemini[1]!.fingerprint);
  expect(existsSync(join(dev2, "gemini-key.json"))).toBe(true);
  const onePassword = await until("the 1Password token on dev2", () => {
    const on = token(hub.db, ownerId)!.sealedOn;
    return on.some((s) => s.machineId === "dev2") ? on : undefined;
  });
  expect(onePassword.map((s) => s.machineId)).toEqual(["dev2", "devbox"]);
  expect(onePassword[0]!.fingerprint).toBe(onePassword[1]!.fingerprint);
});
