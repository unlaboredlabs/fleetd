// The hub's GitHub App against a fake GitHub that checks each JWT's signature (crates/fleetd/src/hub/github_app/
// tests.rs): the manifest, the code traded and the keys sealed to the hub's box key and never shown, Test reading
// installations, tokens only for the repositories the App reaches and minted again near their end, `gh` run as the
// App, people's own connections, the orders' tokens handed to nodes, and an admin-only surface.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { Registry, type Caller } from "../src/hub/api/registry.ts";
import { AppGh, repoOf } from "../src/hub/github_app/gh.ts";
import { githubApps, manifest } from "../src/hub/github_app/index.ts";
import { BLOCKED_TOKEN, deliver, kept, renew, refusal, UNRENEWED_TOKEN } from "../src/hub/github_app/sessions.ts";
import { isoMs } from "../src/hub/train/seams.ts";
import { loadOrCreateBoxKey, openSealed, publicKeyOf } from "../src/shared/sealed_box.ts";
import type { Grant } from "../src/shared/contracts.ts";
import { openHubDb, tempHome } from "./helpers.ts";

const KEY = readFileSync(join(import.meta.dir, "fixtures/app-test-key.pem"), "utf8");
const CLIENT_SECRET = "client-secret-never-shown";
const WEBHOOK_SECRET = "webhook-secret-never-shown";
const APP_ID = 4242;

class ManualClock {
  constructor(public ms: number) {}
  now() {
    return this.ms;
  }
  advance(ms: number) {
    this.ms += ms;
  }
}

type Fake = {
  minted: string[];
  badJwts: number;
  issued: number;
  refuseRefresh: boolean;
  liveRefresh: string[];
  down: boolean;
  revoked: number;
};

const publicKey = createPublicKey(KEY);

function verified(req: Request): boolean {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const dot = jwt.lastIndexOf(".");
  if (dot < 0) return false;
  const signed = jwt.slice(0, dot);
  const claims = JSON.parse(Buffer.from(signed.split(".")[1] ?? "", "base64url").toString() || "{}") as { iss?: string };
  return verify("sha256", Buffer.from(signed), publicKey, Buffer.from(jwt.slice(dot + 1), "base64url")) && claims.iss === String(APP_ID);
}

const bearer = (req: Request) => (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
const refused = (status: number, message: string) => Response.json({ message }, { status });

function fakeGithub(clock: ManualClock) {
  const fake: Fake = { minted: [], badJwts: 0, issued: 0, refuseRefresh: false, liveRefresh: [], down: false, revoked: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const conversion = p.match(/^\/app-manifests\/([^/]+)\/conversions$/);
      if (conversion && req.method === "POST") {
        if (conversion[1] !== "good-code") return refused(404, "Not Found");
        return Response.json({
          id: APP_ID,
          slug: "fleetd-on-devbox-2",
          name: "fleetd on devbox 2",
          owner: { login: "acme", type: "Organization" },
          html_url: "https://github.com/apps/fleetd-on-devbox-2",
          client_id: "Iv23liTEST",
          client_secret: CLIENT_SECRET,
          webhook_secret: WEBHOOK_SECRET,
          pem: KEY,
        });
      }
      if (p === "/app" || p === "/app/installations") {
        if (!verified(req)) {
          fake.badJwts++;
          return refused(401, "A JSON web token could not be decoded");
        }
        if (p === "/app") return Response.json({ id: APP_ID, slug: "fleetd-on-devbox-2" });
        return Response.json([
          { id: 7, account: { login: "acme" }, repository_selection: "selected" },
          { id: 8, account: { login: "Solo" }, repository_selection: "all" },
        ]);
      }
      const access = p.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (access) {
        if (fake.down) return refused(503, "Unicorn");
        if (!verified(req)) {
          fake.badJwts++;
          return refused(401, "A JSON web token could not be decoded");
        }
        const token = `ghs_${access[1]}_${fake.minted.length}`;
        fake.minted.push(token);
        return Response.json({ token, expires_at: isoMs(clock.now() + 60 * 60_000) }, { status: 201 });
      }
      if (p === "/installation/repositories") {
        const token = bearer(req);
        if (token.startsWith("ghs_7_")) {
          return Response.json({ total_count: 2, repositories: [{ full_name: "acme/web" }, { full_name: "acme/api" }] });
        }
        if (token.startsWith("ghs_8_")) return Response.json({ total_count: 31, repositories: [{ full_name: "Solo/notes" }] });
        return refused(401, "Bad credentials");
      }
      if (p === "/login/oauth/access_token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const field = (k: string) => form.get(k) ?? "";
        if (field("client_id") !== "Iv23liTEST" || field("client_secret") !== CLIENT_SECRET) {
          return Response.json({ error: "incorrect_client_credentials" });
        }
        if (fake.down) return refused(503, "Unicorn");
        let ok: boolean;
        if (field("grant_type") === "refresh_token") {
          const given = field("refresh_token");
          const live = fake.liveRefresh.includes(given);
          fake.liveRefresh = fake.liveRefresh.filter((r) => r !== given);
          ok = !fake.refuseRefresh && live;
        } else {
          ok = field("code") === "good-user-code" && field("code_verifier").length >= 43 && field("redirect_uri").startsWith("http://127.0.0.1:");
        }
        if (!ok) {
          return Response.json({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." });
        }
        const n = ++fake.issued;
        fake.liveRefresh.push(`ghr_${n}`);
        return Response.json({
          access_token: `ghu_${n}`,
          expires_in: 28800,
          refresh_token: `ghr_${n}`,
          refresh_token_expires_in: 15_811_200,
          token_type: "bearer",
        });
      }
      if (p === "/user") {
        if (!bearer(req).startsWith("ghu_")) return refused(401, "Bad credentials");
        return Response.json({ login: "sam-rivera", id: 583231 });
      }
      if (/^\/applications\/[^/]+\/grant$/.test(p) && req.method === "DELETE") {
        fake.revoked++;
        return new Response(null, { status: 204 });
      }
      return refused(404, "Not Found");
    },
  });
  return { fake, base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

type Lab = { hub: Hub; tools: Registry; clock: ManualClock; fake: Fake; home: string };
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

function lab(home = tempHome()): Lab {
  cleanups.push(home.done);
  const clock = new ManualClock(1_792_000_000_000);
  const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 0 }, url: "http://devbox.example.ts.net:4790" }, openHubDb(home.dir), clock);
  cleanups.push(() => hub.db.close());
  const tools = new Registry();
  registerAll(tools);
  const gh = fakeGithub(clock);
  cleanups.push(gh.stop);
  githubApps(hub).setEndpoints({ api: gh.base, web: gh.base });
  return { hub, tools, clock, fake: gh.fake, home: home.dir };
}

let n = 0;
function person(hub: Hub, name: string, role: string): string {
  const id = `P${++n}`;
  hub.db.conn.query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, ?, ?, ?)").run(id, name, role, n);
  return id;
}

function device(hub: Hub, personId: string, role: Grant["role"]): Caller {
  const grants: Grant[] = [{ role, machines: "*" }];
  return {
    keyId: `key_${personId}`,
    name: "desk",
    kind: "human",
    prefix: "fld_aaaaaa",
    grants,
    createdAt: isoMs(0),
    person: { personId, name: hub.db.conn.query<{ name: string }, [string]>("SELECT name FROM people WHERE person_id = ?").get(personId)!.name },
  };
}

const admin = (hub: Hub) => device(hub, person(hub, "Owner", "owner"), "admin");
const member = (hub: Hub) => device(hub, person(hub, "Bob", "member"), "operate");
const agent: Caller = { keyId: "key_agent", name: "agent", prefix: "fld_bbbbbb", grants: [{ role: "admin", machines: "*" }], createdAt: isoMs(0) };

async function call(l: Lab, caller: Caller, tool: string, input: unknown = {}): Promise<Record<string, any>> {
  const out = await l.tools.call(l.hub, caller, tool, input);
  if ("error" in out) throw new Error(JSON.stringify(out.error.kind === "tool" ? out.error.error.toJSON() : out.error));
  return out.output as Record<string, any>;
}

async function refusedWith(l: Lab, caller: Caller, tool: string, input: unknown = {}): Promise<{ code: string; message: string }> {
  const out = await l.tools.call(l.hub, caller, tool, input);
  if (!("error" in out) || out.error.kind !== "tool") throw new Error(`expected a refusal, got ${JSON.stringify(out)}`);
  return out.error.error.toJSON();
}

const created = (l: Lab) => call(l, admin(l.hub), "github_app_create", { code: "good-code" });

test("the manifest asks for what the train needs and sets no webhook", () => {
  const m = manifest("fleetd on devbox", "http://devbox:4790", "http://127.0.0.1:5555/cb") as Record<string, any>;
  expect(m.default_events).toEqual([]);
  expect(m.hook_attributes).toBeUndefined();
  expect(m.public).toBe(false);
  expect(m.default_permissions).toEqual({
    contents: "write",
    pull_requests: "write",
    issues: "write",
    workflows: "write",
    statuses: "write",
    actions: "write",
    checks: "read",
    metadata: "read",
  });
  expect(m.callback_urls).toEqual(["http://127.0.0.1/github/callback"]);
});

test("a gh run names its repository in each shape the hub uses", () => {
  expect(repoOf(["pr", "view", "7", "--repo", "acme/web"])).toBe("acme/web");
  expect(repoOf(["pr", "view", "7", "-R", "acme/web"])).toBe("acme/web");
  expect(repoOf(["pr", "list", "--repo=acme/web"])).toBe("acme/web");
  expect(repoOf(["api", "repos/acme/web/pulls/7"])).toBe("acme/web");
  expect(repoOf(["api", "/repos/acme/web/commits/abc/check-runs?per_page=100"])).toBe("acme/web");
  expect(repoOf(["api", "graphql", "-f", "query=…", "-f", "owner=acme", "-F", "name=web"])).toBe("acme/web");
  expect(repoOf(["api", "user"])).toBeUndefined();
  expect(repoOf(["pr", "view", "--repo", "not a repo"])).toBeUndefined();
});

test("the code becomes the App, its keys sealed to the hub and never shown", async () => {
  const l = lab();
  const out = await created(l);
  expect(out.app.appId).toBe(APP_ID);
  expect(out.app.slug).toBe("fleetd-on-devbox-2");
  expect(out.app.settingsUrl).toEndWith("/organizations/acme/settings/apps/fleetd-on-devbox-2");
  const shown = JSON.stringify(out) + JSON.stringify(await call(l, admin(l.hub), "github_app_get"));
  for (const secret of [CLIENT_SECRET, WEBHOOK_SECRET, "PRIVATE KEY"]) expect(shown).not.toContain(secret);
  const row = l.hub.db.conn
    .query<{ data: string; sealed_key: Uint8Array; sealed_client_secret: Uint8Array; sealed_webhook_secret: Uint8Array }, []>(
      "SELECT * FROM github_app",
    )
    .get()!;
  expect(row.data).not.toContain(CLIENT_SECRET);
  const box = loadOrCreateBoxKey(l.home);
  expect(new TextDecoder().decode(openSealed(box, new Uint8Array(row.sealed_key))!)).toBe(KEY);
  expect(new TextDecoder().decode(openSealed(box, new Uint8Array(row.sealed_client_secret))!)).toBe(CLIENT_SECRET);
  expect(new TextDecoder().decode(openSealed(box, new Uint8Array(row.sealed_webhook_secret))!)).toBe(WEBHOOK_SECRET);
});

test("a used code says to create the App again", async () => {
  const l = lab();
  const e = await refusedWith(l, admin(l.hub), "github_app_create", { code: "used-code" });
  expect(e.code).toBe("failed");
  expect(e.message).toBe("GitHub doesn't know that code: each one is used once, within an hour. Create the App again");
});

test("only an owner or admin sets it up; the manifest goes to the account or the organization", async () => {
  const l = lab();
  for (const caller of [member(l.hub), agent]) {
    for (const tool of ["github_app_manifest", "github_app_create", "github_app_test", "github_app_remove"]) {
      const e = await refusedWith(l, caller, tool, { name: "fleetd", redirect: "http://127.0.0.1:5555/cb", code: "good-code" });
      expect(e.code).toBe("forbidden");
    }
  }
  const a = admin(l.hub);
  const mine = await call(l, a, "github_app_manifest", { name: "fleetd on devbox", redirect: "http://127.0.0.1:5555/cb" });
  expect(mine.postTo).toEndWith("/settings/apps/new");
  expect(JSON.parse(mine.manifest).url).toBe("http://devbox.example.ts.net:4790");
  const org = await call(l, a, "github_app_manifest", { name: "fleetd", redirect: "http://127.0.0.1:5555/cb", organization: "acme" });
  expect(org.postTo).toEndWith("/organizations/acme/settings/apps/new");
  const bad = await l.tools.call(l.hub, a, "github_app_manifest", { name: "x", redirect: "https://example.com/" });
  expect("error" in bad && bad.error.kind).toBe("invalid");
  expect((await refusedWith(l, a, "github_app_test")).code).toBe("not_found");
});

test("Test reads where it is installed, with a token for each", async () => {
  const l = lab();
  await created(l);
  const out = await call(l, admin(l.hub), "github_app_test");
  expect(out.app.installations).toEqual([
    { installationId: 7, account: "acme", allRepositories: false, repositoryCount: 2, repositories: ["acme/web", "acme/api"] },
    { installationId: 8, account: "Solo", allRepositories: true, repositoryCount: 31, repositories: [] },
  ]);
  expect(out.app.lastTest.ok).toBe(true);
  expect(out.app.lastTest.said).toBe('"fleetd on devbox 2" is installed on acme (2 repositories), Solo (all 31 repositories), and its tokens work.');
  expect(l.fake.badJwts).toBe(0);
  expect(l.fake.minted).toEqual(["ghs_7_0", "ghs_8_1"]);
});

test("tokens reach only installed repositories and are minted again near their end", async () => {
  const l = lab();
  await created(l);
  const apps = githubApps(l.hub);
  expect(await apps.tokenFor("acme/web")).toBe("ghs_7_0");
  expect(await apps.tokenFor("ACME/api")).toBe("ghs_7_0");
  expect(await apps.tokenFor("solo/anything")).toBe("ghs_8_1");
  expect(await apps.tokenFor("acme/other")).toBeUndefined();
  expect(await apps.tokenFor("someone/else")).toBeUndefined();
  expect(apps.reaches("acme/web") && apps.reaches("solo/x") && !apps.reaches("acme/other")).toBe(true);
  l.clock.advance(56 * 60_000);
  expect(await apps.tokenFor("acme/web")).not.toBe("ghs_7_0");
  expect(l.fake.badJwts).toBe(0);
});

test("a failed Test clears once a later read of its installations works", async () => {
  const l = lab();
  await created(l);
  l.fake.down = true;
  const failed = await call(l, admin(l.hub), "github_app_test");
  expect(failed.app.lastTest.ok).toBe(false);
  expect(failed.app.lastTest.said).toStartWith("GitHub refused (503): Unicorn");
  l.fake.down = false;
  l.clock.advance(2 * 60_000);
  expect(await githubApps(l.hub).tokenFor("acme/web")).toStartWith("ghs_7_");
  expect(githubApps(l.hub).get()!.lastTest!.ok).toBe(true);
});

test("gh runs as the App on its repositories and on its own login elsewhere", async () => {
  const l = lab();
  await created(l);
  const stub = join(l.home, "gh-stub");
  writeFileSync(
    stub,
    `#!/bin/sh\nif [ "$GH_TOKEN" = "" ]; then echo "login"; exit 0; fi\ncase "$*" in *refuse*) echo "Resource not accessible by integration" >&2; exit 1;; esac\necho "token:$GH_TOKEN"\n`,
  );
  chmodSync(stub, 0o755);
  const gh = new AppGh(githubApps(l.hub), stub, { PATH: process.env.PATH ?? "/usr/bin:/bin" });
  expect((await gh.run(["pr", "view", "1", "--repo", "acme/web"])).stdout.trim()).toBe("token:ghs_7_0");
  expect((await gh.run(["api", "repos/acme/other/pulls"])).stdout.trim()).toBe("login");
  expect((await gh.run(["api", "user"])).stdout.trim()).toBe("login");
  // GitHub refusing the App itself runs once more on the machine's login.
  expect((await gh.run(["api", "repos/acme/web/refuse"])).stdout.trim()).toBe("login");
});

test("a person connects their GitHub, kept sealed and refreshed; a refused refresh lapses it; a disconnect revokes", async () => {
  const l = lab();
  const sam = device(l.hub, person(l.hub, "Sam", "member"), "operate");
  const before = await refusedWith(l, sam, "github_connect", connectInput());
  expect(before.message).toContain("This hub has no GitHub App yet");
  await created(l);
  expect((await refusedWith(l, agent, "github_connect", connectInput())).code).toBe("forbidden");
  const out = await call(l, sam, "github_connect", connectInput());
  expect(out.me.login).toBe("sam-rivera");
  const row = l.hub.db.conn.query<{ data: string; sealed_access: Uint8Array }, []>("SELECT data, sealed_access FROM github_accounts").get()!;
  expect(row.data).not.toContain("ghu_");
  expect((await call(l, sam, "github_app_get")).me.login).toBe("sam-rivera");
  const { userToken } = await import("../src/hub/github_app/people.ts");
  const apps = githubApps(l.hub);
  expect((await userToken(apps, sam.person!.personId))!.token).toBe("ghu_1");
  // Within two hours of its end, it is refreshed first.
  l.clock.advance(7 * 60 * 60_000);
  expect((await userToken(apps, sam.person!.personId))!.token).toBe("ghu_2");
  l.clock.advance(7 * 60 * 60_000);
  l.fake.refuseRefresh = true;
  await expect(userToken(apps, sam.person!.personId)).rejects.toThrow("GitHub no longer takes sam-rivera's connection");
  expect((await call(l, sam, "github_app_get")).me.lapsed).toBe(true);
  const gone = await call(l, sam, "github_disconnect");
  expect(gone.revoked).toBe(true);
  expect(l.fake.revoked).toBe(1);
  expect((await call(l, sam, "github_app_get")).me).toBeUndefined();
});

const connectInput = () => ({ code: "good-user-code", codeVerifier: "v".repeat(43), redirectUri: "http://127.0.0.1:5123/github/callback" });

/** A machine whose node keeps what it is handed: each `secret_deliver` opened with its box key. */
function node(l: Lab, machineId: string) {
  const box = crypto.getRandomValues(new Uint8Array(32));
  const machine = { machineId, name: machineId, status: "online", boxPubKey: Buffer.from(publicKeyOf(box)).toString("base64") };
  l.hub.db.conn.query("INSERT INTO machines (machine_id, data) VALUES (?, ?)").run(machineId, JSON.stringify(machine));
  const got: { sink: string; token: string }[] = [];
  const state = { online: true, drops: 0 };
  const deliver = async (_m: string, frame: Record<string, unknown>) => {
    const token = new TextDecoder().decode(openSealed(box, new Uint8Array(Buffer.from(String(frame.sealed), "base64")))!);
    got.push({ sink: String(frame.sink), token });
    return { id: "1", fingerprint: `sha256:${got.length}` };
  };
  l.hub.area("link", () => ({
    can: (m: string) => state.online && m === machineId,
    lacks: () => false,
    linkId: (m: string) => (state.online && m === machineId ? 1 : undefined),
    request: async (_m: string, frame: Record<string, unknown>) => {
      if (frame.t === "session_call") state.drops++;
      return { id: "1", output: {} };
    },
    commands: { deliverSecret: deliver },
  }));
  return { got, state };
}

/** A project on `machineId` whose repo is `repo` on GitHub, with an open order started by `starter`. */
function order(l: Lab, machineId: string, repo: string, starter?: string): { r: { machineId: string; projectId: string }; w: string } {
  const r = { machineId, projectId: "p1" };
  l.hub.db.conn
    .query("INSERT INTO repos (name, checkout_machine_id, checkout_project_id, repo_key, machine_id, project_id) VALUES ('web', ?, 'p1', ?, ?, 'p1')")
    .run(machineId, `github.com/${repo}`, machineId);
  // The project's work is bound to the repo, as adding it from a GitHub checkout does.
  l.hub.db.conn.query("INSERT INTO work_projects (machine_id, project_id, repo_key, base, updated_ms) VALUES (?, 'p1', ?, 'main', 0)").run(machineId, `github.com/${repo}`);
  const data = {
    workstreamId: "W1",
    projectRef: r,
    title: "t",
    state: "open",
    ...(starter ? { startedBy: { personId: starter, name: "Sam" } } : {}),
  };
  l.hub.db.conn.query("INSERT INTO workstreams (machine_id, project_id, state, data) VALUES (?, 'p1', 'open', ?)").run(machineId, JSON.stringify(data));
  return { r, w: "W1" };
}

test("an order nobody started gets the App's token on its node, kept as the order's; a repo it doesn't reach gets none", async () => {
  const l = lab();
  await created(l);
  await githubApps(l.hub).test();
  const n1 = node(l, "devbox");
  const { r, w } = order(l, "devbox", "acme/web");
  await deliver(l.hub, r, w, undefined, true);
  expect(n1.got).toEqual([{ sink: "order:devbox:W1", token: "ghs_7_0" }]);
  expect(kept(l.hub)).toMatchObject([{ order: "W1", blocked: false }]);
  const env = l.hub.db.conn.query<{ name: string; request_id: string }, []>("SELECT name, request_id FROM order_env").get();
  expect(env).toEqual({ name: "GH_TOKEN", request_id: "github" });
});

test("a writer waits for its starter to connect, and a disconnect blocks their orders, never the machine's login", async () => {
  const l = lab();
  await created(l);
  await githubApps(l.hub).test();
  const n1 = node(l, "devbox");
  const sam = device(l.hub, person(l.hub, "Sam", "member"), "operate");
  const { r, w } = order(l, "devbox", "acme/web", sam.person!.personId);
  const why = refusal(l.hub, r, w, "write");
  expect(why!.message).toBe("Connect your GitHub to open this order's PRs. Sam started it and hasn't connected their GitHub, and its PRs open as them.");
  await expect(deliver(l.hub, r, w, undefined, true)).rejects.toThrow("Connect your GitHub");
  await call(l, sam, "github_connect", connectInput());
  expect(refusal(l.hub, r, w, "write")).toBeUndefined();
  await deliver(l.hub, r, w, undefined, true);
  expect(n1.got.at(-1)).toEqual({ sink: "order:devbox:W1", token: "ghu_1" });
  await call(l, sam, "github_disconnect");
  expect(n1.got.at(-1)!.token).toBe(BLOCKED_TOKEN);
  expect(kept(l.hub)[0]!.blocked).toBe(true);
});

test("a node offline gets its token at the next sweep; one that ends unrenewed is replaced, never the machine's login", async () => {
  const l = lab();
  await created(l);
  await githubApps(l.hub).test();
  const n1 = node(l, "devbox");
  const { r, w } = order(l, "devbox", "acme/web");
  await deliver(l.hub, r, w, undefined, true);
  // Within its 30-minute margin, the sweep delivers it again.
  l.clock.advance(31 * 60_000);
  await renew(l.hub);
  expect(n1.got.length).toBe(2);
  expect(n1.got[1]!.token).not.toBe(n1.got[0]!.token);
  // GitHub down until the token ends: the agents hold the placeholder.
  l.fake.down = true;
  l.clock.advance(61 * 60_000);
  await renew(l.hub);
  expect(n1.got.at(-1)!.token).toBe(UNRENEWED_TOKEN);
  l.fake.down = false;
  l.clock.advance(2 * 60_000);
  await renew(l.hub);
  expect(n1.got.at(-1)!.token).toStartWith("ghs_7_");
  // A closed order's record goes.
  l.hub.db.conn.run("UPDATE workstreams SET data = json_set(data, '$.state', 'done')");
  await renew(l.hub);
  expect(kept(l.hub)).toEqual([]);
});

test("removing the App forgets everyone's connection and takes back what it handed to orders", async () => {
  const l = lab();
  await created(l);
  await githubApps(l.hub).test();
  const n1 = node(l, "devbox");
  const sam = device(l.hub, person(l.hub, "Sam", "member"), "operate");
  await call(l, sam, "github_connect", connectInput());
  const { r, w } = order(l, "devbox", "acme/web");
  await deliver(l.hub, r, w, undefined, true);
  const out = await call(l, admin(l.hub), "github_app_remove");
  expect(out.settingsUrl).toEndWith("/organizations/acme/settings/apps/fleetd-on-devbox-2");
  expect(n1.state.drops).toBe(1);
  expect(kept(l.hub)).toEqual([]);
  expect(l.hub.db.conn.query("SELECT * FROM github_accounts").all()).toEqual([]);
  expect((await call(l, sam, "github_app_get")).app).toBeUndefined();
});

beforeEach(() => {
  n = 0;
});
