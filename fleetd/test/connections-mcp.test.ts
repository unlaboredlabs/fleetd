// Connections' custom MCP servers on the hub (W807): which bots a team server reaches, headers from vault items
// (sealed to the machines by the hub, again when the item changes, taken back when it goes), a sign-in found when a
// URL is saved, and a Test that says it reached a tailnet server through Tailscale. A fake node and a stand-in OAuth
// service on 127.0.0.1; nothing leaves this machine.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { NodePort } from "../src/hub/link/node_port.ts";
import { mcpServers } from "../src/hub/mcp_servers/index.ts";
import { forSession } from "../src/hub/mcp_servers/model.ts";
import { syncAllVault } from "../src/hub/mcp_servers/vault_sync.ts";
import { vaultProblem, vaultValue } from "../src/hub/mcp_servers/vault_values.ts";
import type { McpServer, McpTestResult } from "../src/shared/contracts.ts";
import { isTailnetHost } from "../src/shared/tailnet.ts";
import { M, OTHER, PROJECT, type VaultHub, vaultHub } from "./vault-kit.ts";

let k: VaultHub;
/** The fake node's MCP secrets, by `server/field/name`, as it opened them. */
let held: Map<string, string>;
let calls: Record<string, unknown>[];
let testAnswer: McpTestResult;

beforeEach(() => {
  k = vaultHub();
  held = new Map();
  calls = [];
  testAnswer = { tools: [{ name: "echo" }] };
  const port = k.hub.peek<NodePort>("node_port")!;
  const before = port.call.bind(port);
  port.call = async (m, operation, call, waitMs) => {
    if (call.op === "mcp_secrets") {
      calls.push(call);
      const server = String(call.server);
      const set = call.set as { field: string; name: string; sealed: string }[];
      const keep = new Set((call.keep as { field: string; name: string }[]).map((x) => `${server}/${x.field}/${x.name}`));
      for (const key of [...held.keys()]) if (key.startsWith(`${server}/`) && !keep.has(key)) held.delete(key);
      for (const s of set) held.set(`${server}/${s.field}/${s.name}`, k.open(s.sealed));
      const fp = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex").slice(0, 8);
      const secrets = [...held.entries()].filter(([key]) => key.startsWith(`${server}/`)).map(([key, v]) => {
        const [, field, name] = key.split("/");
        return { field, name, fingerprint: fp(v) };
      });
      return { kind: "mcp_secrets", secrets };
    }
    if (call.op === "mcp_test") {
      calls.push(call);
      return { kind: "mcp_tested", ...testAnswer };
    }
    return before(m, operation, call, waitMs);
  };
  k.node.caps.add("mcp_servers");
});
afterEach(() => k.done());

const roles = { lead: true, writers: true, reviewers: true };
const team = { kind: "global" } as const;
const set = (input: Record<string, unknown>) => k.call<{ server: McpServer }>(k.ownerDevice, "mcp_server_set", { enabled: true, roles, env: [], headers: [], ...input });
const save = (input: Record<string, unknown>) => k.call<{ item: { itemId: string } }>(k.ownerDevice, "vault_save", input).then((o) => o.item.itemId);
const names = (r = PROJECT) => mcpServers(k.hub).sessionConfig(r).servers.map((s) => s.name);

test("a team server reaches the bots it names, every bot with no list, and none with an empty one", async () => {
  await set({ scope: team, name: "crm", transport: { type: "stdio", command: "crm-mcp" }, projects: [PROJECT] });
  expect(names(PROJECT)).toEqual(["crm"]);
  expect(names(OTHER)).toEqual([]);
  expect(Object.keys(mcpServers(k.hub).leadSet(OTHER).servers)).toEqual([]);
  expect((await k.call<{ global: McpServer[] }>(k.ownerDevice, "mcp_servers_get", {})).global[0]!.projects).toEqual([PROJECT]);
  await set({ scope: team, name: "crm", transport: { type: "stdio", command: "crm-mcp" } });
  expect([names(PROJECT), names(OTHER)]).toEqual([["crm"], ["crm"]]);
  await set({ scope: team, name: "crm", transport: { type: "stdio", command: "crm-mcp" }, projects: [] });
  expect([names(PROJECT), names(OTHER)]).toEqual([[], []]);
});

test("a header from a team login is sealed to the machine by the hub, again when it changes, and taken back when it goes", async () => {
  const id = await save({ kind: "login", label: "CRM key", sites: ["crm.example"], sealed: k.sealToHub({ username: "ada", password: "planted-crm-1" }) });
  const out = await set({
    scope: team,
    name: "crm",
    transport: { type: "http", url: "http://127.0.0.1:9/mcp" },
    headers: [{ kind: "vault", name: "Authorization", itemId: id, prefix: "Bearer " }],
  });
  expect(held.get("crm/header/Authorization")).toBe("Bearer planted-crm-1");
  // The machine holds it now: no warning that it doesn't.
  expect((out as { missingOn?: string[] }).missingOn).toBeUndefined();
  expect((out as unknown as { next: string }).next).not.toContain("aren't on");
  const row = mcpServers(k.hub).get(team, "crm")!;
  expect(row.headers).toEqual([
    { name: "Authorization", kind: "vault", itemId: id, prefix: "Bearer ", label: "CRM key", sealedOn: [{ machineId: M, fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) }] },
  ]);
  // Nothing of the value in what the hub keeps or answers.
  expect(JSON.stringify(k.hub.db.all("SELECT data FROM mcp_servers"))).not.toContain("planted-crm-1");
  expect(JSON.stringify(out)).not.toContain("planted-crm-1");
  // Sessions get it as a secret by name, and the use is in the vault's audit.
  expect(mcpServers(k.hub).sessionConfig(PROJECT).servers[0]!.headers).toEqual([{ kind: "secret", name: "Authorization" }]);
  const audit = k.hub.db.all<{ action: string; data: string }>("SELECT action, data FROM vault_audit WHERE item_id = ?", [id]);
  expect(audit.filter((a) => a.action === "deliver").map((a) => JSON.parse(a.data))).toEqual([expect.objectContaining({ via: "mcp", names: ["crm"], label: "CRM key" })]);

  // A changed password reaches the node at the next sync; nothing is sent when nothing changed.
  await k.call(k.ownerDevice, "vault_save", { itemId: id, sealed: k.sealToHub({ username: "ada", password: "planted-crm-2" }) });
  await syncAllVault(k.hub);
  expect(held.get("crm/header/Authorization")).toBe("Bearer planted-crm-2");
  const sent = calls.length;
  await syncAllVault(k.hub);
  expect(calls.length).toBe(sent);

  // A deleted item: the node forgets the value, the row says why, and agents go without the server.
  await k.call(k.ownerDevice, "vault_delete", { itemId: id });
  await syncAllVault(k.hub);
  expect(held.has("crm/header/Authorization")).toBe(false);
  expect(mcpServers(k.hub).get(team, "crm")!.headers![0]).toMatchObject({ kind: "vault", problem: "Its vault item was deleted: pick another." });
  expect(names(PROJECT)).toEqual([]);
});

test("a team server takes only team logins; a bot's own server its own variables too", async () => {
  const variable = await save({ kind: "env", scope: "project", ...PROJECT, envName: "CRM_TOKEN", sealed: k.sealToHub({ value: "planted-var" }) });
  await expect(
    set({ scope: team, name: "crm", transport: { type: "stdio", command: "crm-mcp" }, env: [{ kind: "vault", name: "CRM_TOKEN", itemId: variable }] }),
  ).rejects.toMatchObject({ message: expect.stringContaining("this server is for every bot: pick a team login") });
  const scope = { kind: "project", ...PROJECT } as const;
  await set({ scope, name: "crm", transport: { type: "stdio", command: "crm-mcp" }, env: [{ kind: "vault", name: "CRM_TOKEN", itemId: variable }] });
  expect(held.get("crm/env/CRM_TOKEN")).toBe("planted-var");
  const other = { kind: "project", ...OTHER } as const;
  await expect(set({ scope: other, name: "crm", transport: { type: "stdio", command: "crm-mcp" }, env: [{ kind: "vault", name: "CRM_TOKEN", itemId: variable }] })).rejects.toMatchObject({
    message: expect.stringContaining("another bot's variable"),
  });
  // The pure rules the cloud shares.
  expect(vaultProblem(team, undefined)).toBe("Its vault item was deleted: pick another.");
  expect(vaultValue("login", { password: "p" }, undefined, "Bearer ")).toBe("Bearer p");
  expect(vaultValue("env", { value: "v" })).toBe("v");
  expect(vaultValue("login", { username: "only" })).toBeUndefined();
});

/** A stand-in service that asks for a sign-in as MCP's authorization spec has it. */
function signsIn() {
  let base = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/mcp") return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } });
      if (path === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${base}/mcp`, authorization_servers: [`${base}/as`] });
      if (path === "/.well-known/oauth-authorization-server/as") {
        return Response.json({ issuer: `${base}/as`, authorization_endpoint: `${base}/as/authorize`, token_endpoint: `${base}/as/token`, registration_endpoint: `${base}/as/register`, code_challenge_methods_supported: ["S256"] });
      }
      return new Response("no", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  return { server, base };
}
const oauthService = signsIn();
afterAll(() => oauthService.server.stop(true));

test("a URL that signs in is saved signed out with its issuer, before any Test, and reaches no agent yet", async () => {
  const out = await set({ scope: team, name: "notion", transport: { type: "http", url: `${oauthService.base}/mcp` } });
  expect(out.server.oauth).toEqual({ status: "signed_out", issuer: `${oauthService.base}/as` });
  expect(names(PROJECT)).toEqual([]);
  // One with a key of its own isn't asked.
  const keyed = await set({ scope: team, name: "keyed", transport: { type: "http", url: `${oauthService.base}/mcp` }, headers: [{ kind: "plain", name: "X-Api", value: "v" }] });
  expect(keyed.server.oauth).toBeUndefined();
});

test("a tailnet server's Test says it went through Tailscale, and a failed one names the fix", async () => {
  const scope = { kind: "project", ...PROJECT } as const;
  const out = await set({ scope, name: "tiny", transport: { type: "http", url: "http://100.101.102.103:8765/mcp" }, headers: [{ kind: "plain", name: "X-Who", value: "fleetd" }] });
  expect(forSession(out.server, M)?.tailnet).toBe(true);
  const ok = await k.call<{ result: McpTestResult }>(k.ownerDevice, "mcp_server_test", { scope, name: "tiny" });
  expect(ok.result.via).toBe("tailnet");
  expect((calls.at(-1)!.server as { tailnet?: boolean }).tailnet).toBe(true);
  testAnswer = { tools: [], error: "connection refused" };
  const failed = await k.call<{ result: McpTestResult }>(k.ownerDevice, "mcp_server_test", { scope, name: "tiny" });
  expect(failed.result.via).toBeUndefined();
  expect(failed.result.error).toBe(`connection refused. It's on your tailnet: put ${M} on it, or connect Tailscale in Connections so fleetd reaches it for ${M}.`);
  // A server elsewhere isn't a tailnet one.
  const public_ = await set({ scope, name: "pub", transport: { type: "http", url: "https://mcp.example.com/mcp" }, headers: [{ kind: "plain", name: "X-Who", value: "fleetd" }] });
  expect(forSession(public_.server, M)?.tailnet).toBeUndefined();
});

test("tailnet hosts: its addresses and MagicDNS names, short ones too once the suffix is known, nothing else", () => {
  expect(["100.64.0.1", "100.127.255.254", "[fd7a:115c:a1e0::1]", "devbox.tail1234.ts.net", "devbox", "DEVBOX.tail1234.ts.net."].map((h) => isTailnetHost(h, "tail1234.ts.net"))).toEqual([true, true, true, true, true, true]);
  expect(["devbox.corp.example"].map((h) => isTailnetHost(h, "corp.example"))).toEqual([true]);
  // Another tailnet's public Funnel address, a LAN name, localhost: not this tailnet's.
  expect(["shop.tail9999.ts.net", "printer.lan", "localhost", "192.168.1.5"].map((h) => isTailnetHost(h, "tail1234.ts.net"))).toEqual([false, false, false, false]);
  // No suffix known: any *.ts.net name, no short ones.
  expect(["devbox.tail1234.ts.net", "devbox", "100.63.0.1", "100.128.0.1", "example.com", "1.100.in-addr.arpa"].map((h) => isTailnetHost(h))).toEqual([true, false, false, false, false, false]);
});

test("a short MagicDNS name is a tailnet server once the hub's Tailscale route is on", async () => {
  const scope = { kind: "project", ...PROJECT } as const;
  const out = await set({ scope, name: "tiny", transport: { type: "http", url: "http://devbox:8765/mcp" }, headers: [{ kind: "plain", name: "X-Who", value: "fleetd" }] });
  expect(forSession(out.server, M)?.tailnet).toBeUndefined();
  expect(forSession(out.server, M, "tail1234.ts.net")?.tailnet).toBe(true);
  k.hub.area("tailnet.host", () => async () => ({ running: true, suffix: "tail1234.ts.net" }));
  await k.call(k.ownerDevice, "tailnet_connect");
  expect(mcpServers(k.hub).sessionConfig(PROJECT).servers[0]!.tailnet).toBe(true);
  const tested = await k.call<{ result: McpTestResult }>(k.ownerDevice, "mcp_server_test", { scope, name: "tiny" });
  expect(tested.result.via).toBe("tailnet");
});
