// Ports the core of crates/fleetd/src/hub/mcp_servers/tests.rs, mcp_oauth/tests.rs and integrations/tests.rs: a fake
// OAuth service on 127.0.0.1 and a fake node link; nothing leaves this machine.
import { afterAll, expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { fakeNodePort, type Link } from "../src/hub/link/node_port.ts";
import { never, toolPolicy, verdict } from "../src/hub/integrations/policy.ts";
import { getRow, hubBoxKey, openOwn, putRow, renewDue } from "../src/hub/mcp_oauth/index.ts";
import { registerLeadCalls } from "../src/hub/mcp_oauth/calls.ts";
import { leadCalls, type LeadCaller } from "../src/hub/lead_calls/index.ts";
import { challengeParam, secure } from "../src/hub/mcp_oauth/oauth.ts";
import { oauthCallback } from "../src/hub/mcp_oauth/callback.ts";
import { type ServeStatus, serveFront } from "../src/hub/mcp_oauth/https_front.ts";
import { mcpServers } from "../src/hub/mcp_servers/index.ts";
import { plainKeyless } from "../src/hub/mcp_servers/tools.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { redact } from "../src/hub/redact.ts";
import { openSealed, publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import type { McpServer } from "../src/shared/contracts.ts";
import { people } from "../src/hub/people/store.ts";
import { tinyMcp } from "./tiny_mcp.ts";
import { tempHome } from "./helpers.ts";

/** A service that signs in with OAuth as MCP's spec has it, with dynamic client registration. */
function service() {
  const seen = { registered: 0, tokens: [] as Record<string, string>[], revoked: [] as string[], refreshes: 0, refuseRefresh: false };
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
            if (form.refresh_token === "rt-revoked" || seen.refuseRefresh) return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
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
/** A server that asks no one to sign in, as a plain MCP server on a tailnet host is. */
const open = tinyMcp({ name: "open" });
const home = tempHome();
afterAll(() => {
  svc.server.stop(true);
  open.server.stop(true);
  home.done();
});

const NODE_SECRET = crypto.getRandomValues(new Uint8Array(32));

/** A node: keeps MCP secrets by fingerprint (sha256 prefix of the opened value), lists a server's tools. */
class FakeLink implements Link {
  calls: Record<string, unknown>[] = [];
  /** What the node's test of a server finds. */
  tested: Record<string, unknown> = { server: "crm", tools: [{ name: "list_contacts" }, { name: "send_email" }] };
  opened: string[] = [];
  /** The machine of each call. */
  to: string[] = [];
  async request(m: string, frame: Record<string, unknown>) {
    const call = frame.call as Record<string, unknown>;
    this.calls.push(call);
    this.to.push(m);
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
    if (call.op === "mcp_test") return { result: { ok: { kind: "mcp_tested", ...this.tested } } };
    throw new Error(`unexpected ${String(call.op)}`);
  }
  /** The machine is offline: no link. */
  offline = false;
  can = () => true;
  linkId = () => (this.offline ? undefined : "L1");
}

/** A hub on 127.0.0.1:4795; `serve` stands in for `tailscale serve status --json` (none by default). */
function lab(serve: ServeStatus = async () => undefined) {
  let now = Date.parse("2026-11-08T10:00:00Z");
  const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 4795 } }, HubDb.memory(), { now: () => now });
  const link = new FakeLink();
  hub.area("node_port", () => fakeNodePort(link));
  hub.area("tailscale_serve", () => serve);
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
/** Where a server that signs in is once signed in: the team's, for every bot (D592). */
const team = { kind: "global" } as const;
const sealedFor = (value: string) => Buffer.from(seal(publicKeyOf(NODE_SECRET), new TextEncoder().encode(value))).toString("base64");

test("a bot's server keeps only its secrets' fingerprints, and its sessions get them by name", async () => {
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
  // A hub that had the machines' own servers turned off gives them again: the switch is gone (W817).
  hub.db.conn.query("INSERT INTO mcp_settings (key, value) VALUES ('user_servers', 0)").run();
  expect(mcpServers(hub).sessionConfig({ machineId: "lab", projectId: "p1" }).userServers).toBe(true);
  const set = mcpServers(hub).leadSet({ machineId: "lab", projectId: "p1" });
  expect(set.userServers).toBe(true);
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
  const server = mcpServers(hub).get(team, "docs")!;
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
  expect(getRow(hub, team, "docs")!.record.pushed).toBe(true);
  // Removed: revoked where the service offers it.
  await call("mcp_server_remove", { scope: team, name: "docs" });
  expect(svc.seen.revoked).toEqual(["rt-2"]);
  expect(getRow(hub, team, "docs")).toBeUndefined();
});

/**
 * A service shaped like an OpenID Connect sign-in in front of an MCP server: its resource names no scopes, its
 * authorization server lists `offline_access` (unless `renews` is off), and it registers only https or loopback
 * redirects.
 */
function oidcService() {
  const seen = { registered: [] as Record<string, unknown>[] };
  const config = { renews: true };
  let port = 0;
  const server: Bun.Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${port}`;
      if (url.pathname === "/") {
        return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` } });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource") return Response.json({ resource: base, authorization_servers: [`${base}/login`] });
      if (url.pathname === "/.well-known/oauth-authorization-server/login") {
        return Response.json({
          issuer: `${base}/login`,
          authorization_endpoint: `${base}/login/authorize`,
          token_endpoint: `${base}/login/token`,
          registration_endpoint: `${base}/login/register`,
          code_challenge_methods_supported: ["S256"],
          scopes_supported: config.renews ? ["email", "offline_access", "openid", "profile"] : ["email", "openid", "profile"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        });
      }
      if (url.pathname === "/login/register") {
        const body = (await req.json()) as { redirect_uris: string[] };
        const to = new URL(body.redirect_uris[0]!);
        if (to.protocol === "http:" && to.hostname !== "127.0.0.1" && to.hostname !== "localhost") {
          return Response.json({ error: "invalid_redirect_uri", error_description: `Invalid redirect URI: '${to}'` }, { status: 400 });
        }
        seen.registered.push(body);
        return Response.json({ client_id: `client-${seen.registered.length}` }, { status: 201 });
      }
      return new Response("no", { status: 404 });
    },
  });
  port = server.port ?? 0;
  return { server, seen, config, base: `http://127.0.0.1:${port}` };
}

test("asks for offline_access where the sign-in lists it, so the server can be renewed, and says why a plain-http callback is refused", async () => {
  const oidc = oidcService();
  try {
    const { call } = lab();
    await call("mcp_server_set", {
      scope,
      name: "canvas",
      enabled: true,
      roles: { lead: true, writers: true, reviewers: true },
      transport: { type: "http", url: `${oidc.base}/` },
      integration: { readTools: [] },
    });
    // No scope named by the resource; the authorization server lists offline_access and the refresh grant.
    oidc.config.renews = false;
    const plain = new URL((await call("mcp_oauth_start", { scope, name: "canvas", hubUrl: "http://127.0.0.1:4795" })).authorizeUrl as string);
    expect(plain.searchParams.get("scope")).toBeNull();
    expect(oidc.seen.registered).toHaveLength(1);
    oidc.config.renews = true;
    const renewing = new URL((await call("mcp_oauth_start", { scope, name: "canvas", hubUrl: "http://127.0.0.1:4795" })).authorizeUrl as string);
    expect(renewing.searchParams.get("scope")).toBe("openid offline_access");
    // The client registered without that scope isn't reused: fleetd registers again, asking for it.
    expect(oidc.seen.registered).toHaveLength(2);
    expect(oidc.seen.registered[1]).toMatchObject({ scope: "openid offline_access", grant_types: ["authorization_code", "refresh_token"] });
    expect(renewing.searchParams.get("client_id")).toBe("client-2");
    // A hub reached over plain http on a tailnet: the service refuses the callback, and the person hears how to fix it.
    await expect(call("mcp_oauth_start", { scope, name: "canvas", hubUrl: "http://devbox.example.ts.net:4790" })).rejects.toThrow(
      /Invalid redirect URI.*takes only an https or loopback callback/,
    );
  } finally {
    oidc.server.stop(true);
  }
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

/** Tailscale Serve's status with an https front on `port` proxying to `to`, beside another site's. */
const serving = (port: number, to: string) =>
  JSON.stringify({
    TCP: { [String(port)]: { HTTPS: true } },
    Web: {
      "devbox.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8425" } } },
      [`devbox.example.ts.net:${port}`]: { Handlers: { "/": { Proxy: to } } },
    },
  });

test("the hub finds its Tailscale Serve https front by the port it proxies to", () => {
  expect(serveFront(serving(4791, "http://100.100.1.2:4790"), { host: "100.100.1.2", port: 4790 })).toBe("https://devbox.example.ts.net:4791");
  expect(serveFront(serving(4791, "http://127.0.0.1:4790"), { host: "localhost", port: 4790 })).toBe("https://devbox.example.ts.net:4791");
  expect(serveFront(serving(4791, "http://100.100.1.2:4790"), { host: "0.0.0.0", port: 4790 })).toBe("https://devbox.example.ts.net:4791");
  // Port 443 is https's own: the address carries none.
  expect(serveFront(serving(443, "http://127.0.0.1:4790"), { host: "127.0.0.1", port: 4790 })).toBe("https://devbox.example.ts.net");
  // Another port, another host, or nothing served: no front.
  expect(serveFront(serving(4791, "http://127.0.0.1:4790"), { host: "100.100.1.2", port: 4790 })).toBeUndefined();
  expect(serveFront(serving(4791, "http://127.0.0.1:5000"), { host: "127.0.0.1", port: 4790 })).toBeUndefined();
  expect(serveFront("{}", { host: "127.0.0.1", port: 4790 })).toBeUndefined();
  expect(serveFront("not json", { host: "127.0.0.1", port: 4790 })).toBeUndefined();
});

/** A service that registers only an https or loopback callback, as many hosted MCP servers' sign-ins do. */
function httpsOnlyService() {
  let port = 0;
  const server: Bun.Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${port}`;
      if (url.pathname === "/mcp") {
        return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` } });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource") return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/register") {
        const to = new URL(((await req.json()) as { redirect_uris: string[] }).redirect_uris[0]!);
        if (to.protocol !== "https:" && to.hostname !== "127.0.0.1") {
          return Response.json({ error: "invalid_redirect_uri", error_description: `Invalid redirect URI: '${to}'` }, { status: 400 });
        }
        return Response.json({ client_id: "https-client" }, { status: 201 });
      }
      if (url.pathname === "/token") return Response.json({ access_token: "at-https", refresh_token: "rt-https", token_type: "Bearer", expires_in: 3600 });
      return new Response("no", { status: 404 });
    },
  });
  port = server.port ?? 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

test("a sign-in from an app on plain http calls back at the hub's https front, and the app's dialog carries on", async () => {
  const svc2 = httpsOnlyService();
  try {
    const server = {
      scope,
      name: "canvas",
      enabled: true,
      roles: { lead: true, writers: true, reviewers: true },
      transport: { type: "http", url: `${svc2.base}/mcp` },
      integration: { readTools: [] },
    };
    // No https front: the app's own plain-http address, which the service refuses.
    const bare = lab();
    await bare.call("mcp_server_set", server);
    await expect(bare.call("mcp_oauth_start", { scope, name: "canvas", hubUrl: "http://devbox.example.ts.net:4795" })).rejects.toThrow("Invalid redirect URI");
    // Tailscale Serve fronts the hub over https: the callback goes there, whatever address the app is on.
    const { hub, call } = lab(async () => serving(4791, "http://127.0.0.1:4795"));
    await call("mcp_server_set", server);
    const started = await call("mcp_oauth_start", { scope, name: "canvas", hubUrl: "http://devbox.example.ts.net:4795" });
    expect(started.redirectUri).toBe("https://devbox.example.ts.net:4791/oauth/callback");
    const authorize = new URL(started.authorizeUrl as string);
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://devbox.example.ts.net:4791/oauth/callback");
    // The browser lands on the https address; the hub finds the sign-in by its state, and the server the app shows connects.
    const st = authorize.searchParams.get("state")!;
    const page = (await oauthCallback(new Request(`https://devbox.example.ts.net:4791/oauth/callback?state=${st}&code=c-1`), { hub } as never))!;
    expect(page.status).toBe(200);
    expect(mcpServers(hub).get(team, "canvas")!.oauth).toMatchObject({ status: "connected", signingIn: false });
    // An app already on https keeps its own address.
    const own = await call("mcp_oauth_start", { scope, name: "canvas", hubUrl: "https://hub.example.com" });
    expect(own.redirectUri).toBe("https://hub.example.com/oauth/callback");
  } finally {
    svc2.server.stop(true);
  }
});

/** A project's "docs" server, signed in through the fake service: its token is on the machine. */
async function signedIn(l: ReturnType<typeof lab>) {
  await l.call("mcp_server_set", {
    scope,
    name: "docs",
    enabled: true,
    roles: { lead: true, writers: true, reviewers: true },
    transport: { type: "http", url: `${svc.base}/mcp` },
  });
  const started = await l.call("mcp_oauth_start", { scope, name: "docs", hubUrl: "http://127.0.0.1:4795" });
  const st = new URL(started.authorizeUrl as string).searchParams.get("state")!;
  await oauthCallback(new Request(`http://127.0.0.1:4795/oauth/callback?state=${st}&code=c-1`), { hub: l.hub } as never);
  expect(mcpServers(l.hub).get(team, "docs")!.oauth?.status).toBe("connected");
}

const agentCaller: LeadCaller = { projectRef: { machineId: "lab", projectId: "p1" }, by: "lead:lab/p1", agent: { kind: "task", taskId: "T1" }, threadId: "th-1" };

test("an agent's relay has a turned-away token renewed, and one that renewing can't cure signs the server out for real", async () => {
  const l = lab();
  await signedIn(l);
  registerLeadCalls(l.hub);
  const renew = leadCalls(l.hub).handler("mcp_oauth_renew")!;
  // A session's server, relayed: the hub marks it so the node writes `fleetd mcp-relay` for it.
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab", projectId: "p1" }).servers[0]).toMatchObject({ name: "docs", oauth: true });

  // Turned away: renewed now, and the new token is on the machine before the answer.
  const before = l.link.opened.length;
  expect(await renew(agentCaller, { op: "mcp_oauth_renew", server: "docs" })).toEqual({ renewed: "yes" });
  expect(l.link.opened.length).toBe(before + 1);
  expect(l.link.opened.at(-1)).toMatch(/^Bearer at-\d+$/);

  // The token just renewed was turned away too: Settings stops saying Connected, and the chat says what to do.
  const out = await renew(agentCaller, { op: "mcp_oauth_renew", server: "docs", refused: true });
  expect(out).toMatchObject({ renewed: "signed_out", problem: expect.stringContaining("turned away the sign-in fleetd had just renewed") });
  const server = mcpServers(l.hub).get(team, "docs")!;
  expect(server.oauth).toMatchObject({ status: "signed_out", problem: expect.stringContaining("sign in again") });
  // Its dead token leaves the machine and the server's headers: no new session gets the server.
  expect(l.link.calls.at(-1)).toEqual({ op: "mcp_secrets", scope: { kind: "global" }, server: "docs", set: [], keep: [] });
  expect(server.headers).toEqual([]);
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab", projectId: "p1" }).servers).toEqual([]);

  // Only a session's relay asks, and only for a server its bot gets that signs in.
  await expect(Promise.resolve().then(() => renew({ ...agentCaller, threadId: undefined }, { op: "mcp_oauth_renew", server: "docs" }))).rejects.toMatchObject({ code: "forbidden" });
  expect(await renew(agentCaller, { op: "mcp_oauth_renew", server: "nope" })).toMatchObject({ renewed: "signed_out" });
});

test("a sign-in the service ends takes its token off the machine, at once or once the machine is back", async () => {
  const l = lab();
  await signedIn(l);
  try {
    svc.seen.refuseRefresh = true;
    l.link.offline = true;
    // Due for renewal; the service refuses: signed out, but the machine can't be told yet.
    l.tick(31 * 60_000);
    await renewDue(l.hub);
    expect(mcpServers(l.hub).get(team, "docs")!.oauth?.status).toBe("signed_out");
    expect(mcpServers(l.hub).get(team, "docs")!.headers).toEqual([expect.objectContaining({ name: "Authorization" })]);
    // Back: the next round takes the token off it.
    l.link.offline = false;
    await renewDue(l.hub);
    expect(l.link.calls.at(-1)).toEqual({ op: "mcp_secrets", scope: { kind: "global" }, server: "docs", set: [], keep: [] });
    expect(mcpServers(l.hub).get(team, "docs")!.headers).toEqual([]);
    const calls = l.link.calls.length;
    await renewDue(l.hub);
    expect(l.link.calls.length).toBe(calls);
  } finally {
    svc.seen.refuseRefresh = false;
  }
});

test("bots' own sign-ins become the team's at upgrade, the newest kept, with no new sign-in, and reach every bot's machine", async () => {
  const l = lab();
  await signedIn(l);
  const client = getRow(l.hub, team, "docs")!.record.client!;
  const at = "2026-11-08T10:00:00.000Z";
  store(l.hub).machineUpsert({ machineId: "lab2", name: "lab2", nodeVersion: "1", status: "online", lastSeenAt: at, boxPubKey: Buffer.from(publicKeyOf(NODE_SECRET)).toString("base64") } as never);
  store(l.hub).projectsUpsertMany("lab2", [{ machineId: "lab2", projectId: "p2", title: "P2", workspaceRoot: "/w2", lastActivityAt: at, threads: { running: 0, total: 0 } } as never]);
  const sealHub = (v: string) => seal(publicKeyOf(hubBoxKey(l.hub)), new TextEncoder().encode(v));
  // As an older hub left them: Paper signed in on each of two bots, each token on its own bot's machine.
  for (const [m, p, signedInAt, token] of [
    ["lab", "p1", "2026-11-01T10:00:00.000Z", "at-p1"],
    ["lab2", "p2", "2026-11-05T10:00:00.000Z", "at-p2"],
  ] as const) {
    const bot = { kind: "project", machineId: m, projectId: p } as const;
    mcpServers(l.hub).put({
      scope: bot,
      name: "paper",
      enabled: true,
      roles: { lead: true, writers: true, reviewers: true },
      transport: { type: "http", url: `${svc.base}/mcp` },
      env: [],
      headers: [{ name: "Authorization", kind: "secret", sealedOn: [{ machineId: m, fingerprint: "0000aaaa" }] }],
      oauth: { status: "connected", issuer: client.issuer, signedInAt },
      updatedAt: at,
    });
    putRow(l.hub, { scope: bot, name: "paper", record: { client, lifetimeMs: 3_600_000, expiresMs: Date.parse(at) + 3_600_000, pushed: true }, access: sealHub(token), refresh: sealHub(`rt-${p}`) });
  }
  const trades = svc.seen.tokens.length;
  l.link.opened = [];
  l.link.to = [];
  await renewDue(l.hub);
  // One team server, from the newest sign-in, its token on both machines under the team's scope.
  const paper = mcpServers(l.hub).get(team, "paper")!;
  expect(paper.oauth).toMatchObject({ status: "connected", signedInAt: "2026-11-05T10:00:00.000Z" });
  expect(mcpServers(l.hub).perBot().filter((x) => x.name === "paper")).toEqual([]);
  expect(getRow(l.hub, team, "paper")).toBeDefined();
  expect(getRow(l.hub, { kind: "project", machineId: "lab", projectId: "p1" }, "paper")).toBeUndefined();
  expect(l.link.opened.filter((x) => x === "Bearer at-p2")).toHaveLength(2);
  expect(l.link.to.filter((_, i) => l.link.opened[i] === "Bearer at-p2")).toEqual(["lab", "lab2"]);
  expect(l.link.calls.filter((c) => c.server === "paper").at(-1)).toMatchObject({ op: "mcp_secrets", scope: { kind: "global" }, server: "paper" });
  expect(paper.headers![0]!.sealedOn!.map((x) => x.machineId)).toEqual(["lab", "lab2"]);
  // Nobody signs in again: no code was traded.
  expect(svc.seen.tokens.length).toBe(trades);
  // Every bot's agents get it, from the team.
  for (const r of [{ machineId: "lab", projectId: "p1" }, { machineId: "lab2", projectId: "p2" }]) {
    expect(mcpServers(l.hub).sessionConfig(r).servers.find((x) => x.name === "paper")).toMatchObject({ secrets: { kind: "global" }, oauth: true });
  }
  // Each bot's machine forgets what it kept for the bot.
  expect(mcpServers(l.hub).forgets()).toEqual(
    expect.arrayContaining([
      ["lab", { kind: "project", projectId: "p1" }, "paper"],
      ["lab2", { kind: "project", projectId: "p2" }, "paper"],
    ]),
  );
  // Done once.
  const calls = l.link.calls.length;
  await renewDue(l.hub);
  expect(l.link.calls.length).toBe(calls);
});

test("any person connects and signs in to a service for the team; its connector or an admin disconnects it", async () => {
  const l = lab();
  const member: Caller = { ...l.person, keyId: "k2", grants: [{ role: "operate", machines: ["lab"] }], person: { personId: "p_bbbbbbbb", name: "Bo" } };
  const other: Caller = { ...member, keyId: "k3", person: { personId: "p_cccccccc", name: "Cy" } };
  const input = { scope: team, name: "paper", enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: `${svc.base}/mcp` }, env: [], headers: [] };
  const saved = (await l.call("mcp_server_set", input, member)).server as McpServer;
  expect(saved).toMatchObject({ scope: team, connectedBy: "p_bbbbbbbb" });
  // Not signed in yet: no bot's agents get it.
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab", projectId: "p1" }).servers).toEqual([]);
  // Anyone signs the team in.
  expect((await l.call("mcp_oauth_start", { scope: team, name: "paper", hubUrl: "http://127.0.0.1:4795" }, other)).authorizeUrl).toBeString();
  // Only its connector or an admin changes or disconnects it.
  await expect(l.call("mcp_server_set", { ...input, enabled: false }, other)).rejects.toMatchObject({ code: "forbidden" });
  await expect(l.call("mcp_server_remove", { scope: team, name: "paper" }, other)).rejects.toMatchObject({ code: "forbidden" });
  await l.call("mcp_server_remove", { scope: team, name: "paper" }, member);
  expect(mcpServers(l.hub).get(team, "paper")).toBeUndefined();
  // A server with a key of its own for every bot stays the admins'.
  const keyed = { ...input, name: "crm", headers: [{ kind: "secret", name: "X-Key", sealed: [{ machineId: "lab", sealed: sealedFor("k") }] }] };
  await expect(l.call("mcp_server_set", keyed, member)).rejects.toMatchObject({ code: "forbidden" });
});

test("two accounts of one service at one URL each sign in, take their own bots and disconnect on their own", async () => {
  const l = lab();
  const at = "2026-11-08T10:00:00.000Z";
  store(l.hub).projectsUpsertMany("lab", [
    { machineId: "lab", projectId: "p1", title: "P1", workspaceRoot: "/w", lastActivityAt: at, threads: { running: 0, total: 0 } } as never,
    { machineId: "lab", projectId: "p2", title: "P2", workspaceRoot: "/w2", lastActivityAt: at, threads: { running: 0, total: 0 } } as never,
  ]);
  const p1 = { machineId: "lab", projectId: "p1" };
  const p2 = { machineId: "lab", projectId: "p2" };
  const account = { scope: team, enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: `${svc.base}/mcp` }, env: [], headers: [] };
  await l.call("mcp_server_set", { ...account, name: "notion", projects: [p1] });
  await l.call("mcp_server_set", { ...account, name: "notion-work", projects: [p2] });
  // Both sign-ins open at once, each its own; the second finishes first.
  const states: string[] = [];
  for (const name of ["notion", "notion-work"]) {
    const started = await l.call("mcp_oauth_start", { scope: team, name, hubUrl: "http://127.0.0.1:4795" });
    states.push(new URL(started.authorizeUrl as string).searchParams.get("state") ?? "");
  }
  expect(new Set(states).size).toBe(2);
  for (const st of [...states].reverse()) await oauthCallback(new Request(`http://127.0.0.1:4795/oauth/callback?state=${st}&code=c-${st.slice(0, 4)}`), { hub: l.hub } as never);
  const token = (name: string) => openOwn(l.hub, getRow(l.hub, team, name)!.access!);
  for (const name of ["notion", "notion-work"]) expect(mcpServers(l.hub).get(team, name)!.oauth?.status).toBe("connected");
  expect(token("notion")).not.toBe(token("notion-work"));
  // Each account reaches only the bot it was given.
  const names = (r: typeof p1) => mcpServers(l.hub).sessionConfig(r).servers.map((x) => x.name);
  expect(names(p1)).toEqual(["notion"]);
  expect(names(p2)).toEqual(["notion-work"]);
  // Disconnecting one leaves the other signed in, its token kept.
  const kept = token("notion-work");
  await l.call("mcp_server_remove", { scope: team, name: "notion" });
  expect(mcpServers(l.hub).get(team, "notion")).toBeUndefined();
  expect(getRow(l.hub, team, "notion")).toBeUndefined();
  expect(mcpServers(l.hub).get(team, "notion-work")!.oauth?.status).toBe("connected");
  expect(token("notion-work")).toBe(kept);
  expect(names(p2)).toEqual(["notion-work"]);
});

test("a bot's server signs the team in: Connect from an older app, on a bot, ends as the team's", async () => {
  const l = lab();
  await l.call("mcp_server_set", { scope, name: "paper", enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: `${svc.base}/mcp` }, env: [], headers: [] });
  const started = await l.call("mcp_oauth_start", { scope, name: "paper", hubUrl: "http://127.0.0.1:4795" });
  expect(started.scope).toEqual(team);
  expect(mcpServers(l.hub).get(scope, "paper")).toBeUndefined();
  const st = new URL(started.authorizeUrl as string).searchParams.get("state")!;
  await oauthCallback(new Request(`http://127.0.0.1:4795/oauth/callback?state=${st}&code=c-1`), { hub: l.hub } as never);
  expect(mcpServers(l.hub).get(team, "paper")!.oauth?.status).toBe("connected");
  // The app still asking for it as the bot's reaches the team's.
  expect(((await l.call("mcp_server_test", { scope, name: "paper" })).result as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
});

test("two agents turned away at once: the older token's refusal never signs out the token just renewed", async () => {
  const l = lab();
  await signedIn(l);
  registerLeadCalls(l.hub);
  const renew = leadCalls(l.hub).handler("mcp_oauth_renew")!;
  const print = (header: string) => new Bun.CryptoHasher("sha256").update(header).digest("hex").slice(0, 8);
  const first = print(l.link.opened.at(-1)!);
  const renewals = svc.seen.refreshes;
  // Both held the first token. One has it renewed; the other, a moment behind, says the first token was refused
  // after its renewal, before the new one reached its node.
  const [a, b] = await Promise.all([
    renew(agentCaller, { op: "mcp_oauth_renew", server: "docs", fingerprint: first }),
    renew({ ...agentCaller, threadId: "th-2" }, { op: "mcp_oauth_renew", server: "docs", fingerprint: first, refused: true }),
  ]);
  expect([a, b]).toEqual([{ renewed: "yes" }, { renewed: "yes" }]);
  expect(svc.seen.refreshes).toBe(renewals + 1);
  expect(mcpServers(l.hub).get(team, "docs")!.oauth).toMatchObject({ status: "connected" });
  // A second turn-away of the first token renews nothing again either.
  expect(await renew(agentCaller, { op: "mcp_oauth_renew", server: "docs", fingerprint: first })).toEqual({ renewed: "yes" });
  expect(svc.seen.refreshes).toBe(renewals + 1);
  // The current token refused after its renewal does sign out.
  const now = print(l.link.opened.at(-1)!);
  expect(await renew(agentCaller, { op: "mcp_oauth_renew", server: "docs", fingerprint: now, refused: true })).toMatchObject({ renewed: "signed_out" });
});

test("a machine that runs its first bot after the token went out gets the team's token on the next round", async () => {
  const l = lab();
  await signedIn(l);
  // Pushed to every machine there was, and not due for renewal for a long while.
  await renewDue(l.hub);
  const calls = l.link.calls.length;
  await renewDue(l.hub);
  expect(l.link.calls.length).toBe(calls);
  const at = "2026-11-08T10:00:00.000Z";
  store(l.hub).machineUpsert({ machineId: "lab3", name: "lab3", nodeVersion: "1", status: "online", lastSeenAt: at, boxPubKey: Buffer.from(publicKeyOf(NODE_SECRET)).toString("base64") } as never);
  store(l.hub).projectsUpsertMany("lab3", [{ machineId: "lab3", projectId: "p3", title: "P3", workspaceRoot: "/w3", lastActivityAt: at, threads: { running: 0, total: 0 } } as never]);
  await renewDue(l.hub);
  expect(l.link.to.at(-1)).toBe("lab3");
  expect(l.link.calls.at(-1)).toMatchObject({ op: "mcp_secrets", scope: { kind: "global" }, server: "docs" });
  expect(mcpServers(l.hub).get(team, "docs")!.headers![0]!.sealedOn!.map((x) => x.machineId)).toEqual(["lab", "lab3"]);
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab3", projectId: "p3" }).servers.map((x) => x.name)).toEqual(["docs"]);
});

test("Add on a bot, then its second save of the tools that only read, ends as the team's server, not a bot copy without its sign-in", async () => {
  const l = lab();
  await signedIn(l);
  // The app still saves it as the bot's: the save is the team's, and the bot has no copy hiding it.
  await l.call("mcp_server_set", { scope, name: "docs", enabled: true, roles: { lead: true, writers: false, reviewers: false }, transport: { type: "http", url: `${svc.base}/mcp` }, env: [], headers: [], integration: { readTools: ["read_doc"] } });
  expect(mcpServers(l.hub).get(scope, "docs")).toBeUndefined();
  expect(mcpServers(l.hub).get(team, "docs")).toMatchObject({ integration: { readTools: ["read_doc"] }, oauth: { status: "connected" } });
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab", projectId: "p1" }).servers.find((x) => x.name === "docs")).toMatchObject({ secrets: { kind: "global" }, oauth: true });
});

test("only a bot's sign-in with no key of its own is carried over, one service per name and address; a team server of that name of its own is never taken over", async () => {
  const l = lab();
  const at = "2026-11-08T10:00:00.000Z";
  store(l.hub).machineUpsert({ machineId: "lab2", name: "lab2", nodeVersion: "1", status: "online", lastSeenAt: at, boxPubKey: Buffer.from(publicKeyOf(NODE_SECRET)).toString("base64") } as never);
  store(l.hub).projectsUpsertMany("lab2", [{ machineId: "lab2", projectId: "p2", title: "P2", workspaceRoot: "/w2", lastActivityAt: at, threads: { running: 0, total: 0 } } as never]);
  const bot2 = { kind: "project", machineId: "lab2", projectId: "p2" } as const;
  const base = { enabled: true, roles: { lead: true, writers: true, reviewers: true }, env: [], updatedAt: at };
  const signedInAs = { status: "connected" as const, issuer: `${svc.base}/as`, signedInAt: at };
  // A sign-in with a key of its own beside it stays the bot's, key and all.
  mcpServers(l.hub).put({ ...base, scope, name: "crm", transport: { type: "http", url: `${svc.base}/crm` }, headers: [{ name: "X-Workspace", kind: "secret", sealedOn: [{ machineId: "lab", fingerprint: "0000aaaa" }] }, { name: "Authorization", kind: "secret", sealedOn: [{ machineId: "lab", fingerprint: "0000bbbb" }] }], oauth: signedInAs });
  // Two bots' different services under one name: one is carried over, the other stays its bot's.
  mcpServers(l.hub).put({ ...base, scope, name: "docs", transport: { type: "http", url: `${svc.base}/mcp` }, headers: [{ name: "Authorization", kind: "secret", sealedOn: [{ machineId: "lab", fingerprint: "0000cccc" }] }], oauth: signedInAs });
  mcpServers(l.hub).put({ ...base, scope: bot2, name: "docs", transport: { type: "http", url: "https://docs.other.example/mcp" }, headers: [{ name: "Authorization", kind: "secret", sealedOn: [{ machineId: "lab2", fingerprint: "0000dddd" }] }], oauth: signedInAs });
  await renewDue(l.hub);
  expect(mcpServers(l.hub).get(scope, "crm")?.headers?.map((v) => v.name)).toEqual(["X-Workspace", "Authorization"]);
  expect(mcpServers(l.hub).get(team, "crm")).toBeUndefined();
  const moved = [mcpServers(l.hub).get(team, "docs")?.transport, mcpServers(l.hub).get(scope, "docs")?.transport, mcpServers(l.hub).get(bot2, "docs")?.transport].filter((t) => t !== undefined);
  expect(moved).toHaveLength(2);
  expect(mcpServers(l.hub).forgets().map(([m]) => m)).toEqual(["lab"]);

  // A team server of a bot's server's name with a key of its own: signing in on the bot's stays the bot's.
  await l.call("mcp_server_set", { scope: team, name: "tickets", enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: `${svc.base}/mcp` }, env: [], headers: [{ kind: "secret", name: "X-Key", sealed: [{ machineId: "lab", sealed: sealedFor("k") }] }] });
  await l.call("mcp_server_set", { scope, name: "tickets", enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: `${svc.base}/mcp` }, env: [], headers: [] });
  const started = await l.call("mcp_oauth_start", { scope, name: "tickets", hubUrl: "http://127.0.0.1:4795" });
  expect(started.scope).toEqual(scope);
  expect(mcpServers(l.hub).get(team, "tickets")!.oauth).toBeUndefined();
  expect(getRow(l.hub, team, "tickets")).toBeUndefined();
});

test("a team server with no key that asks no one to sign in reaches the agents of the bots it names, and Test says so", async () => {
  const l = lab();
  const at = "2026-11-08T10:00:00.000Z";
  store(l.hub).projectsUpsertMany("lab", [{ machineId: "lab", projectId: "p2", title: "P2", workspaceRoot: "/w2", lastActivityAt: at, threads: { running: 0, total: 0 } } as never]);
  const input = { scope: team, name: "open", enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: open.url }, env: [], headers: [], projects: [{ machineId: "lab", projectId: "p1" }] };
  const saved = (await l.call("mcp_server_set", input)).server as McpServer;
  // A plain server, not a sign-in waiting to finish.
  expect(saved.oauth).toBeUndefined();
  expect(saved.connectedBy).toBeUndefined();
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab", projectId: "p1" }).servers).toEqual([
    { name: "open", secrets: { kind: "global" }, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: open.url }, env: [], headers: [] },
  ]);
  // Only the bots it names.
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab", projectId: "p2" }).servers).toEqual([]);
  const tested = (await l.call("mcp_server_test", { scope: team, name: "open" })).result as Record<string, unknown>;
  expect(tested.error).toBeUndefined();
  expect(tested.signIn).toBeUndefined();
  expect((tested.tools as unknown[]).length).toBe(2);

  // One the hub can't reach to ask (a tailnet host only the machines reach) is plain too: Test on a machine says the rest.
  const far = (await l.call("mcp_server_set", { ...input, name: "far", transport: { type: "http", url: "http://127.0.0.1:1/mcp" } })).server as McpServer;
  expect([far.oauth, far.connectedBy]).toEqual([undefined, undefined]);
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab", projectId: "p1" }).servers.map((x) => x.name)).toEqual(["far", "open"]);

  // A member doesn't give every bot a server with no sign-in, and is told why.
  const member: Caller = { ...l.person, keyId: "k2", grants: [{ role: "operate", machines: ["lab"] }], person: { personId: "p_bbbbbbbb", name: "Bo" } };
  await expect(l.call("mcp_server_set", { ...input, name: "open2" }, member)).rejects.toMatchObject({
    code: "forbidden",
    message: expect.stringContaining("doesn't ask anyone to sign in"),
  });
  expect(mcpServers(l.hub).get(team, "open2")).toBeUndefined();

  // One with a key saved: a member's save keeping it is refused as a team server's change, not as one with no key.
  const keyed = { ...input, name: "keyed", headers: [{ kind: "secret", name: "Authorization", sealed: [{ machineId: "lab", sealed: sealedFor("k") }] }] };
  await l.call("mcp_server_set", keyed);
  const kept = { ...keyed, headers: [{ kind: "keep", name: "Authorization" }] };
  const refused = l.call("mcp_server_set", kept, member);
  await expect(refused).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("only the hub's owners and admins change them") });
  await expect(refused).rejects.not.toMatchObject({ message: expect.stringContaining("doesn't ask anyone to sign in") });
});

test("a team server with no key that answers with OAuth waits for its sign-in, and Test says it asks you to sign in", async () => {
  const l = lab();
  const saved = (await l.call("mcp_server_set", { scope: team, name: "docs", enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: `${svc.base}/mcp` }, env: [], headers: [] })).server as McpServer;
  expect(saved.oauth).toMatchObject({ status: "signed_out", issuer: `${svc.base}/as` });
  expect(saved.connectedBy).toBe("p_aaaaaaaa");
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab", projectId: "p1" }).servers).toEqual([]);
  const tested = (await l.call("mcp_server_test", { scope: team, name: "docs" })).result as Record<string, unknown>;
  expect(tested).toMatchObject({ signIn: true, error: "docs asks you to sign in: sign in with your own account." });
});

test("a keyless server that turns fleetd away with no sign-in to offer is said to want a key", async () => {
  const l = lab();
  const keyed = tinyMcp({ name: "keyed", key: "k-1" });
  try {
    await l.call("mcp_server_set", { scope: team, name: "keyed", enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: keyed.url }, env: [], headers: [] });
    expect(mcpServers(l.hub).get(team, "keyed")!.oauth).toBeUndefined();
    l.link.tested = { tools: [], error: "HTTP 401: who are you" };
    const tested = (await l.call("mcp_server_test", { scope: team, name: "keyed" })).result as Record<string, unknown>;
    expect(tested.signIn).toBeUndefined();
    expect(tested.error).toBe("keyed turned fleetd away (HTTP 401) without asking anyone to sign in: it wants a key, added under Headers.");
  } finally {
    keyed.server.stop(true);
  }
});

test("a team server with a key of its own reaches agents with its header, as before", async () => {
  const l = lab();
  const saved = (await l.call("mcp_server_set", { scope: team, name: "crm", enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: open.url }, env: [], headers: [{ kind: "secret", name: "X-Key", sealed: [{ machineId: "lab", sealed: sealedFor("k-crm") }] }] })).server as McpServer;
  expect(saved.oauth).toBeUndefined();
  expect(saved.connectedBy).toBeUndefined();
  expect(l.link.opened).toContain("k-crm");
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab", projectId: "p1" }).servers).toMatchObject([{ name: "crm", headers: [{ kind: "secret", name: "X-Key" }] }]);
});

test("a keyless team server an owner or admin added before as a sign-in that never came is a plain server now; a member's stays off, with why", async () => {
  const l = lab();
  const ann = people(l.hub).create("Ann", "admin");
  const bo = people(l.hub).create("Bo", "member");
  const row = (name: string, by: string): McpServer => ({ scope: team, name, enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: open.url }, env: [], headers: [], connectedBy: by, updatedAt: "2026-11-08T10:00:00.000Z" });
  mcpServers(l.hub).put(row("anns", ann.personId));
  mcpServers(l.hub).put(row("bos", bo.personId));
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab", projectId: "p1" }).servers).toEqual([]);
  plainKeyless(l.hub);
  expect(mcpServers(l.hub).get(team, "anns")!.connectedBy).toBeUndefined();
  expect(mcpServers(l.hub).sessionConfig({ machineId: "lab", projectId: "p1" }).servers.map((x) => x.name)).toEqual(["anns"]);
  const tested = (await l.call("mcp_server_test", { scope: team, name: "bos" })).result as Record<string, unknown>;
  expect(tested.signIn).toBeUndefined();
  expect(tested.error).toBe("bos asks no one to sign in, and only an owner or admin gives every bot a server with no key: ask one to save it again in Connections.");
});
