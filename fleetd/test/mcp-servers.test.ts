// Ports the core of crates/fleetd/src/hub/mcp_servers/tests.rs, mcp_oauth/tests.rs and integrations/tests.rs: a fake
// OAuth service on 127.0.0.1 and a fake node link; nothing leaves this machine.
import { afterAll, expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { fakeNodePort, type Link } from "../src/hub/cloud/node.ts";
import { never, toolPolicy, verdict } from "../src/hub/integrations/policy.ts";
import { getRow, renewDue } from "../src/hub/mcp_oauth/index.ts";
import { challengeParam, secure } from "../src/hub/mcp_oauth/oauth.ts";
import { oauthCallback } from "../src/hub/mcp_oauth/callback.ts";
import { mcpServers } from "../src/hub/mcp_servers/index.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { redact } from "../src/hub/redact.ts";
import { openSealed, publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import type { McpServer } from "../src/shared/contracts.ts";
import { tempHome } from "./helpers.ts";

/** A service that signs in with OAuth as MCP's spec has it, with dynamic client registration. */
function service() {
  const seen = { registered: 0, tokens: [] as Record<string, string>[], revoked: [] as string[], refreshes: 0 };
  let n = 0;
  let port = 0;
  const server: Bun.Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response | Promise<Response> {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${port}`;
      if (url.pathname === "/mcp") {
        if (req.headers.get("authorization")?.startsWith("Bearer at-")) return Response.json({ jsonrpc: "2.0", id: 0, result: {} });
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read"` },
        });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [`${base}/as`] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server/as") {
        return Response.json({
          issuer: `${base}/as`,
          authorization_endpoint: `${base}/as/authorize`,
          token_endpoint: `${base}/as/token`,
          registration_endpoint: `${base}/as/register`,
          revocation_endpoint: `${base}/as/revoke`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/as/register") {
        seen.registered++;
        return Response.json({ client_id: "fleetd-client" }, { status: 201 });
      }
      if (url.pathname === "/as/token") {
        return req.text().then((body) => {
          const form = Object.fromEntries(new URLSearchParams(body));
          seen.tokens.push(form);
          if (form.grant_type === "refresh_token") {
            seen.refreshes++;
            if (form.refresh_token === "rt-revoked") return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
          }
          n++;
          return Response.json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, token_type: "Bearer", expires_in: 3600 });
        });
      }
      if (url.pathname === "/as/revoke") {
        return req.text().then((body) => {
          seen.revoked.push(new URLSearchParams(body).get("token") ?? "");
          return new Response("");
        });
      }
      return new Response("no", { status: 404 });
    },
  });
  port = server.port ?? 0;
  return { server, seen, base: `http://127.0.0.1:${port}` };
}

const svc = service();
const home = tempHome();
afterAll(() => {
  svc.server.stop(true);
  home.done();
});

const NODE_SECRET = crypto.getRandomValues(new Uint8Array(32));

/** A node: keeps MCP secrets by fingerprint (sha256 prefix of the opened value), lists a server's tools. */
class FakeLink implements Link {
  calls: Record<string, unknown>[] = [];
  opened: string[] = [];
  async request(_m: string, frame: Record<string, unknown>) {
    const call = frame.call as Record<string, unknown>;
    this.calls.push(call);
    if (call.op === "mcp_secrets") {
      const set = call.set as { field: string; name: string; sealed: string }[];
      const keep = call.keep as { field: string; name: string }[];
      const secrets = [
        ...set.map((s) => {
          const plain = openSealed(NODE_SECRET, new Uint8Array(Buffer.from(s.sealed, "base64")));
          const text = new TextDecoder().decode(plain!);
          this.opened.push(text);
          return { field: s.field, name: s.name, fingerprint: new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 8) };
        }),
        ...keep.map((k) => ({ ...k, fingerprint: "0000aaaa" })),
      ];
      return { result: { ok: { kind: "mcp_secrets", secrets } } };
    }
    if (call.op === "mcp_test") return { result: { ok: { kind: "mcp_tested", server: "crm", tools: [{ name: "list_contacts" }, { name: "send_email" }] } } };
    throw new Error(`unexpected ${String(call.op)}`);
  }
  can = () => true;
  linkId = () => "L1";
}

function lab() {
  let now = Date.parse("2026-11-08T10:00:00Z");
  const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 4795 } }, HubDb.memory(), { now: () => now });
  const link = new FakeLink();
  hub.area("node_port", () => fakeNodePort(link));
  const at = "2026-11-08T10:00:00.000Z";
  store(hub).machineUpsert({
    machineId: "lab",
    name: "lab",
    nodeVersion: "1",
    status: "online",
    lastSeenAt: at,
    boxPubKey: Buffer.from(publicKeyOf(NODE_SECRET)).toString("base64"),
  } as never);
  store(hub).projectsUpsertMany("lab", [
    { machineId: "lab", projectId: "p1", title: "P1", workspaceRoot: "/w", lastActivityAt: at, threads: { running: 0, total: 0 } } as never,
  ]);
  const tools = new Registry();
  registerAll(tools);
  const person: Caller = {
    keyId: "k",
    name: "desk",
    prefix: "fld_x",
    grants: [{ role: "admin", machines: "*" }],
    createdAt: at,
    kind: "human",
    person: { personId: "p_aaaaaaaa", name: "Ann" },
  };
  const call = async (tool: string, input: unknown, caller = person) => {
    const r = await tools.call(hub, caller, tool, input);
    if ("error" in r) throw r.error.kind === "tool" ? r.error.error : new Error(r.error.kind);
    return r.output as Record<string, unknown>;
  };
  return { hub, link, call, person, tick: (ms: number) => (now += ms) };
}

const scope = { kind: "project", machineId: "lab", projectId: "p1" } as const;
const sealedFor = (value: string) => Buffer.from(seal(publicKeyOf(NODE_SECRET), new TextEncoder().encode(value))).toString("base64");

test("a project's server keeps only its secrets' fingerprints, and its sessions get them by name", async () => {
  const { hub, link, call, person } = lab();
  const agent = { ...person, kind: undefined } as Caller;
  const input = {
    scope,
    name: "crm",
    enabled: true,
    roles: { lead: true, writers: true, reviewers: false },
    transport: { type: "stdio", command: "crm-mcp" },
    env: [
      { kind: "plain", name: "CRM_REGION", value: "eu" },
      { kind: "secret", name: "CRM_KEY", sealed: [{ machineId: "lab", sealed: sealedFor("key-1") }] },
    ],
  };
  await expect(call("mcp_server_set", input, agent)).rejects.toMatchObject({ code: "forbidden" });
  await expect(call("mcp_server_set", { ...input, name: "FleetD" })).rejects.toMatchObject({ message: "fleetd is fleetd's own tools server: pick another name" });
  const out = await call("mcp_server_set", input);
  const server = out.server as McpServer;
  expect(server.env).toEqual([
    { name: "CRM_REGION", kind: "plain", value: "eu" },
    { name: "CRM_KEY", kind: "secret", sealedOn: [{ machineId: "lab", fingerprint: new Bun.CryptoHasher("sha256").update("key-1").digest("hex").slice(0, 8) }] },
  ]);
  expect(link.opened).toEqual(["key-1"]);
  expect(JSON.stringify(hub.db.all("SELECT data FROM mcp_servers"))).not.toContain(sealedFor("key-1").slice(0, 20));
  // One switch: an older app's writers-only pick gives it to every agent.
  expect(server.roles).toEqual({ lead: true, writers: true, reviewers: true });
  // Saved again keeping the key: the node keeps it, and nothing is sealed again.
  await call("mcp_server_set", { ...input, env: [input.env[0], { kind: "keep", name: "CRM_KEY" }] });
  expect(link.calls.at(-1)).toMatchObject({ op: "mcp_secrets", set: [], keep: [{ field: "env", name: "CRM_KEY" }] });
  const config = mcpServers(hub).sessionConfig({ machineId: "lab", projectId: "p1" });
  expect(config).toEqual({
    userServers: true,
    servers: [
      {
        name: "crm",
        secrets: { kind: "project", projectId: "p1" },
        roles: { lead: true, writers: true, reviewers: true },
        transport: { type: "stdio", command: "crm-mcp", args: [] },
        env: [
          { kind: "plain", name: "CRM_REGION", value: "eu" },
          { kind: "secret", name: "CRM_KEY" },
        ],
        headers: [],
      },
    ],
  });
  const set = mcpServers(hub).leadSet({ machineId: "lab", projectId: "p1" });
  expect(Object.keys(set.servers)).toEqual(["crm"]);
  expect(set.servers.crm).toMatch(/^[0-9a-f]{64}$/);
  const tested = await call("mcp_server_test", { scope, name: "crm" });
  expect((tested.result as { tools: unknown[] }).tools).toEqual([
    { name: "list_contacts", policy: "read" },
    { name: "send_email", policy: "ask" },
  ]);
  await call("mcp_server_remove", { scope, name: "crm" });
  expect(link.calls.at(-1)).toEqual({ op: "mcp_secrets", scope: { kind: "project", projectId: "p1" }, server: "crm", set: [], keep: [] });
  expect((await call("mcp_servers_get", { project: { machineId: "lab", projectId: "p1" } })).project).toEqual([]);
});

test("signs in with a registered client and PKCE, hands the token to the machine, renews and revokes it", async () => {
  const { hub, link, call, tick } = lab();
  await call("mcp_server_set", {
    scope,
    name: "docs",
    enabled: true,
    roles: { lead: true, writers: false, reviewers: false },
    transport: { type: "http", url: `${svc.base}/mcp` },
    integration: { readTools: [] },
  });
  const started = await call("mcp_oauth_start", { scope, name: "docs", hubUrl: "http://127.0.0.1:4795" });
  expect(started.redirectUri).toBe("http://127.0.0.1:4795/oauth/callback");
  const authorize = new URL(started.authorizeUrl as string);
  expect(authorize.origin + authorize.pathname).toBe(`${svc.base}/as/authorize`);
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
    response_type: "code",
    client_id: "fleetd-client",
    code_challenge_method: "S256",
    resource: `${svc.base}/mcp`,
    scope: "read",
  });
  expect(svc.seen.registered).toBe(1);
  const st = authorize.searchParams.get("state")!;
  const ctx = { hub } as never;
  const page = (await oauthCallback(new Request(`http://127.0.0.1:4795/oauth/callback?state=${st}&code=c-1`), ctx))!;
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Signed in to docs");
  // The code was traded with its verifier, and the token reached the machine sealed to its box key.
  const trade = svc.seen.tokens[0]!;
  expect(trade).toMatchObject({ grant_type: "authorization_code", code: "c-1", client_id: "fleetd-client" });
  const challenge = Buffer.from(new Bun.CryptoHasher("sha256").update(trade.code_verifier!).digest()).toString("base64url");
  expect(authorize.searchParams.get("code_challenge")).toBe(challenge);
  expect(link.opened).toEqual(["Bearer at-1"]);
  const server = mcpServers(hub).get(scope, "docs")!;
  expect(server.oauth).toMatchObject({ status: "connected", signingIn: false, expiresAt: "2026-11-08T11:00:00.000Z" });
  expect(server.headers).toEqual([{ name: "Authorization", kind: "secret", sealedOn: [expect.objectContaining({ machineId: "lab" })] }]);
  // Hub-side the tokens are sealed to the hub's own key: no row holds them in the clear.
  expect(JSON.stringify(hub.db.all("SELECT * FROM mcp_oauth"))).not.toContain("at-1");
  // A used link fails.
  const again = (await oauthCallback(new Request(`http://127.0.0.1:4795/oauth/callback?state=${st}&code=c-1`), ctx))!;
  expect(again.status).toBe(400);
  // Half its life left: renewed with the refresh token, and the new one goes to the machine.
  tick(31 * 60_000);
  await renewDue(hub);
  expect(svc.seen.tokens.at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-1" });
  expect(link.opened.at(-1)).toBe("Bearer at-2");
  expect(getRow(hub, scope, "docs")!.record.pushed).toBe(true);
  // Removed: revoked where the service offers it.
  await call("mcp_server_remove", { scope, name: "docs" });
  expect(svc.seen.revoked).toEqual(["rt-2"]);
  expect(getRow(hub, scope, "docs")).toBeUndefined();
});

test("the integrations policy reads names, blocks money and credentials, and asks for the rest", () => {
  const crm = {
    scope,
    name: "crm",
    enabled: true,
    roles: { lead: true, writers: false, reviewers: false },
    transport: { type: "http", url: "https://crm.example/mcp" },
    integration: { readTools: ["export_report"] },
    updatedAt: "x",
  } as McpServer;
  expect(verdict("mcp__crm__list_contacts", {}, [crm])).toEqual({ allow: true });
  expect(verdict("mcp__crm__export_report", {}, [crm])).toEqual({ allow: true });
  expect(verdict("mcp__crm__transfer_funds", {}, [crm])).toMatchObject({ block: expect.stringContaining("never moves money") });
  expect(verdict("mcp__crm__send_email", { body: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, [crm])).toMatchObject({
    block: expect.stringContaining("password, key or token"),
  });
  expect(verdict("mcp__crm__send_email", { to: "a@b.example" }, [crm])).toMatchObject({ ask: { action: "send", title: "Use send_email on crm" } });
  expect(verdict("mcp__crm__get_page", { url: "https://evil.example/?d=1" }, [crm])).toMatchObject({ ask: { action: "write" } });
  // A server saved without integration runs every tool unasked; fleetd's own and claude's aren't this table's.
  expect(verdict("mcp__plain__send_email", {}, [{ ...crm, name: "plain", integration: undefined }])).toEqual({ allow: true });
  expect(verdict("mcp__fleetd__task_spawn", {}, [crm])).toBeUndefined();
  expect(verdict("Bash", {}, [crm])).toBeUndefined();
  expect(verdict("mcp__crm__call_tool", { name: "send_message", arguments: { name: "x" } }, [crm])).toMatchObject({ ask: { action: "send" } });
  expect([never("createAccount"), never("sign_up"), never("buy_shares"), never("get_order")]).toEqual(["accounts", "accounts", "trading", undefined]);
  expect(toolPolicy(crm, "search_docs")).toBe("read");
  expect(redact("export GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("export GH=[secret]");
  expect(redact("password: string")).toBe("password: string");
  expect(redact("https://user:pass1234@host.example/x")).toBe("https://[secret]@host.example/x");
});

test("sign-in URLs stay off plain HTTP to the internet, and challenges read as the Rust hub reads them", () => {
  expect(() => secure("http://auth.example/token")).toThrow("plain HTTP");
  for (const ok of ["https://auth.example", "http://127.0.0.1:1/x", "http://devbox.tailb0000.ts.net/x", "http://100.100.1.2/x", "http://[fd7a:115c:a1e0::1]/x"]) {
    expect(secure(ok).toString()).toBeTruthy();
  }
  expect(challengeParam('Bearer realm="x", resource_metadata="https://a/b", scope="read write"', "scope")).toBe("read write");
  expect(challengeParam('Bearer error="invalid_token", error_description="a \\"quoted\\" word"', "error_description")).toBe('a "quoted" word');
  expect(challengeParam("Basic realm=x", "realm")).toBeUndefined();
});
