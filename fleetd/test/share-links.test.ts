// Share links end to end on a workspace: an agent shares its dev server's port, a member's device opens it through the
// one-time code and gets the link's cookie, HTTP and the hot-reload WebSocket reach the dev server over the machine's
// dial-back (the node's own code, node/share), and the gate refuses the signed-out, non-members, ended and stopped
// links, and links while the switch is off. Each step lands in the audit log.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Server } from "bun";
import type { AuditListOutput, ShareLink, ShareLinkOpenOutput, ShareLinksListOutput, SharePortOutput } from "../src/shared/contracts.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import type { SocketData } from "../src/hub/http/route.ts";
import { people } from "../src/hub/people/store.ts";
import { LOCAL_COOKIE } from "../src/hub/share_links/cookie.ts";
import { start } from "../src/hub/share_links/loops.ts";
import { dial, fleetdsOwn, type Reach } from "../src/node/share/index.ts";
import net from "node:net";
import { refusal, testHub } from "./people-kit.ts";
import { addMachine, agent, FakeLink } from "./screens_helpers.ts";

// The dev server: a page, and an HMR socket that pushes an update when told to.
const hmr = new Set<import("bun").ServerWebSocket<unknown>>();
const dev = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, server): Response | undefined {
    if (new URL(req.url).pathname === "/hmr") {
      return server.upgrade(req, { headers: { "sec-websocket-protocol": "vite-hmr" } }) ? undefined : new Response("no", { status: 400 });
    }
    return new Response(`<h1>app ${new URL(req.url).pathname}</h1> host=${req.headers.get("host")} cookie=${req.headers.get("cookie") ?? ""}`, {
      headers: { "content-type": "text/html" },
    });
  },
  websocket: {
    open: (ws) => void hmr.add(ws),
    close: (ws) => void hmr.delete(ws),
    message: (ws, m) => void ws.send(`pong ${m}`),
  },
});
afterAll(() => dev.stop(true));
const DEV = dev.port!;

// Whether the agent's session runs in a hosted box, and the box's own ports: by default none is boxed.
let boxed: { up: boolean; ports: Record<number, number> } | undefined;
const reach: Reach = {
  boxed: (thread) => thread === "th7" && boxed !== undefined,
  boxDial: (_thread, port) => {
    if (!boxed?.up) return undefined;
    const to = boxed.ports[port];
    if (to === undefined) return Promise.reject(new Error("ECONNREFUSED"));
    const s = net.connect(to, "127.0.0.1");
    return new Promise((resolve, reject) => (s.once("connect", () => resolve(s)), s.once("error", reject)));
  },
};
let t: ReturnType<typeof rig>;
let server: Server<SocketData>;
beforeEach(() => {
  t = rig();
  server = serve(t.hub, t.tools, 0);
  t.fake.onSend = (_machine, f) => {
    if (f.t === "preview_dial") void dial(`http://127.0.0.1:${server.port}`, String(f.token), Number(f.port), f.thread as string | undefined, reach);
  };
  t.hub.db.conn.query("INSERT INTO share_link_settings (key, value) VALUES ('preview_url', ?)").run(`http://localhost:${server.port}`);
});
afterEach(async () => {
  boxed = undefined;
  await stop(server);
  t.hub.shutdown.abort();
});

function rig() {
  const k = testHub();
  const fake = k.hub.area("link", () => new FakeLink() as never) as unknown as FakeLink;
  addMachine(k.hub, "devbox");
  fake.link("devbox", []);
  k.hub.db.conn.query("INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (7, 'devbox', 'p1', 'W1', 'running', 'th7', '{}')").run();
  start(k.hub);
  const ownerId = people(k.hub).list(false)[0]!.personId;
  const owner = k.device(undefined, ownerId, "desk");
  const bob = people(k.hub).create("Bob", "member");
  const bobsPhone = k.device([{ role: "operate", machines: "*" }], bob.personId, "phone");
  return { ...k, fake, owner, ownerId, bob, bobsPhone };
}

/** A request to the link's own host, as a browser at `<name>.localhost` sends it. */
const at = (l: ShareLink, path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { host: new URL(l.url).host, ...headers }, redirect: "manual" });

async function agentShares(port = DEV): Promise<SharePortOutput & { block: Record<string, unknown> }> {
  const handler = leadCalls(t.hub).handler("share_port")!;
  return (await handler(agent("devbox", "p1", "T7"), { op: "share_port", port, label: "The shop" })) as SharePortOutput & { block: Record<string, unknown> };
}

/** The member's way in: a code from their device, then the cookie it sets. */
async function signIn(l: ShareLink, as = t.bobsPhone): Promise<string> {
  const { url } = await t.call<ShareLinkOpenOutput>(as, "share_link_open", { name: l.name, to: "/cart?x=1" });
  const entered = await at(l, new URL(url).pathname + new URL(url).search);
  expect(entered.status).toBe(302);
  expect(entered.headers.get("location")).toBe("/cart?x=1");
  const set = entered.headers.get("set-cookie")!;
  // The test's preview address is http on localhost: the cookie without __Host- and Secure, which Safari drops there.
  expect(set).toMatch(/^fleetd_preview=/);
  expect(set).toContain("HttpOnly; SameSite=Lax");
  expect(set).not.toContain("Domain");
  return set.split(";")[0]!;
}

const audit = async () => (await t.call<AuditListOutput>(t.owner, "audit_list", { kind: "share_link" })).events.map((e) => [e.kind, e.actor.name, e.summary]);

test("an agent's link opens for a signed-in member, HTTP and hot reload alike", async () => {
  const { link, block } = await agentShares();
  expect(link.url).toBe(`http://${link.name}.localhost:${server.port}`);
  expect(link.threadRef).toEqual({ machineId: "devbox", threadId: "th7" });
  expect(block).toEqual({ v: 1, kind: "preview", name: link.name, port: DEV, label: "The shop" });
  // Signed out: the sign-in page, never the app, whatever the path (the workspace's own routes too).
  for (const path of ["/", "/healthz", "/mcp"]) {
    const out = await at(link, path);
    expect(out.status).toBe(401);
    expect(await out.text()).toContain(`fleetd://preview?url=${encodeURIComponent(link.url + path)}`);
  }
  const cookie = await signIn(link);
  const page = await at(link, "/cart", { cookie: `${cookie}; theirs=1` });
  expect(page.status).toBe(200);
  // The dev server sees a visit from its own machine, without the preview's cookie.
  expect(await page.text()).toBe(`<h1>app /cart</h1> host=localhost:${DEV} cookie=theirs=1`);
  // A code is good once.
  const { url } = await t.call<ShareLinkOpenOutput>(t.bobsPhone, "share_link_open", { name: link.name });
  expect((await at(link, new URL(url).pathname + new URL(url).search)).status).toBe(302);
  expect((await at(link, new URL(url).pathname + new URL(url).search)).status).toBe(401);
  // Hot reload: the subprotocol comes back, the dev server's push reaches the page, and the page's ping it.
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hmr`, { headers: { host: new URL(link.url).host, cookie }, protocols: ["vite-hmr"] } as never);
  const got: string[] = [];
  ws.onmessage = (e) => got.push(String(e.data));
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  expect(ws.protocol).toBe("vite-hmr");
  for (let i = 0; i < 50 && hmr.size === 0; i++) await Bun.sleep(10);
  for (const s of hmr) s.send(JSON.stringify({ type: "update", updates: [{ path: "/src/App.tsx" }] }));
  ws.send("ping");
  for (let i = 0; i < 100 && got.length < 2; i++) await Bun.sleep(10);
  expect(got.sort()).toEqual(["pong ping", '{"type":"update","updates":[{"path":"/src/App.tsx"}]}']);
  // Stopping the link closes its hot reload and every later visit.
  const closed = new Promise((r) => (ws.onclose = r));
  await t.call(t.owner, "share_link_revoke", { name: link.name });
  await closed;
  expect((await at(link, "/", { cookie })).status).toBe(410);
  expect(await audit()).toEqual([
    ["share_link.revoke", expect.any(String), `Stopped the share link of port ${DEV} on devbox`],
    ["share_link.open", "Bob", `Opened the share link of port ${DEV} on devbox`],
    ["share_link.open", "Bob", `Opened the share link of port ${DEV} on devbox`],
    ["share_link.create", "An agent", `Shared port ${DEV} on devbox for 120 minutes`],
  ]);
});

test("the gate: non-members, removed people, ended links and the switch", async () => {
  const { link } = await agentShares();
  // An agent's key is no member's device.
  expect((await refusal(t.call(t.agent(), "share_link_open", { name: link.name }))).code).toBe("forbidden");
  const cookie = await signIn(link);
  // A cookie of another link opens nothing here.
  const other = await t.call<SharePortOutput>(t.owner, "share_port", { machineId: "devbox", port: DEV + 1 });
  expect((await at(other.link, "/", { cookie: cookie })).status).toBe(401);
  // A forged one neither.
  expect((await at(link, "/", { cookie: `${LOCAL_COOKIE}=${link.name}.eA.9999999999999.bad` })).status).toBe(401);
  // Bob leaves the workspace: his cookie stops at once.
  people(t.hub).remove(t.bob.personId);
  const gone = await at(link, "/", { cookie });
  expect(gone.status).toBe(403);
  expect(await gone.text()).toContain("Ask its owner to invite you.");
  // The owner's way in still works; then the admin turns links off.
  const owners = await signIn(link, t.owner);
  expect((await at(link, "/", { cookie: owners })).status).toBe(200);
  expect((await refusal(t.call(t.bobsPhone, "share_links_settings_set", { enabled: false }))).code).toBe("forbidden");
  await t.call(t.owner, "share_links_settings_set", { enabled: false });
  expect((await at(link, "/", { cookie: owners })).status).toBe(403);
  expect((await refusal(agentShares())).message).toBe("Share links are off in this workspace.");
  await t.call(t.owner, "share_links_settings_set", { enabled: true });
  expect((await at(link, "/", { cookie: owners })).status).toBe(200);
  // The cookie lasts an hour, a visit in its second half gets a new one, and an hour unvisited signs out.
  t.clock.advance(40 * 60_000);
  const fresh = (await at(link, "/", { cookie: owners })).headers.get("set-cookie")!.split(";")[0]!;
  t.clock.advance(40 * 60_000);
  expect((await at(link, "/", { cookie: owners })).status).toBe(401);
  expect((await at(link, "/", { cookie: fresh })).status).toBe(200);
  // Two hours on, the link has ended; renewing it first would have kept it.
  t.clock.advance(39 * 60_000);
  await t.call(t.owner, "share_link_renew", { name: link.name, minutes: 30 });
  const late = await signIn(link, t.owner);
  t.clock.advance(20 * 60_000);
  expect((await at(link, "/", { cookie: late })).status).toBe(200);
  t.clock.advance(11 * 60_000);
  expect((await at(link, "/", { cookie: late })).status).toBe(410);
  const listed = await t.call<ShareLinksListOutput>(t.owner, "share_links_list");
  expect(listed.links.map((l) => l.name)).not.toContain(link.name);
  expect((await audit()).map((r) => r[0])).toContain("share_link.switch");
});

test("a port with nothing on it is a page saying so; sharing it again renews it; the address is checked", async () => {
  const first = await agentShares(1);
  const cookie = await signIn(first.link, t.owner);
  const down = await at(first.link, "/", { cookie });
  expect(down.status).toBe(503);
  expect(await down.text()).toContain("Nothing answered on port 1");
  t.clock.advance(60 * 60_000);
  const again = await agentShares(1);
  expect(again.link.name).toBe(first.link.name);
  expect(Date.parse(again.link.expiresAt)).toBeGreaterThan(Date.parse(first.link.expiresAt));
  expect((await refusal(t.call(t.owner, "share_links_settings_set", { previewUrl: "http://preview.example.com" }))).message).toBe(
    "previewUrl: it must start with https://.",
  );
  expect((await refusal(t.call(t.owner, "share_port", { machineId: "nope", port: 3000 }))).code).toBe("not_found");
  expect(fleetdsOwn("http://127.0.0.1:4790", 4790)).toBe(true);
  expect(fleetdsOwn("https://ws.example.com", 4790)).toBe(false);
});

test("a boxed agent's link reaches the port inside its box, never this machine's", async () => {
  // The box serves the app on its port 4000; this machine has nothing there.
  boxed = { up: true, ports: { 4000: DEV } };
  const { link } = await agentShares(4000);
  expect(t.fake.sent("devbox").length).toBe(0);
  const cookie = await signIn(link, t.owner);
  const page = await at(link, "/", { cookie });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<h1>app /</h1>");
  expect(t.fake.sent("devbox").at(-1)).toMatchObject({ t: "preview_dial", port: 4000, thread: "th7" });
  // Its box down: the page says nothing answers, and the machine's own port of that number is never tried.
  boxed = { up: false, ports: {} };
  const shared = await agentShares(DEV);
  const down = await at(shared.link, "/x", { cookie: await signIn(shared.link, t.owner) });
  expect(down.status).toBe(503);
});
