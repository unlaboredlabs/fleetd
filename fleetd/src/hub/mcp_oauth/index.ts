// MCP servers that sign in with OAuth, with no fleetd-run OAuth app: the
// hub registers itself with the service where it may, else takes the person's own client. `mcp_oauth_start` discovers
// where a saved server signs in and hands the app the service's sign-in page, opened with PKCE and a redirect to
// `<hub>/oauth/callback`. The callback trades the code for the tokens (`finish`). The hub keeps them sealed to its own
// box key in `mcp_oauth`, and seals each access token to the project's machine as the server's `Authorization`
// header (`push`). `renewDue` renews a token before it ends; a service that refuses signs the server out.
import { createHash } from "node:crypto";
import type { McpOauth, McpScope, McpServer, ProjectRef } from "../../shared/contracts.ts";
import { loadOrCreateBoxKey, openSealed, publicKeyOf, seal } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { linked, nodeCan, sessionCall } from "../link/node_port.ts";
import { mcpServers, OAUTH_HEADER, scopeKey, secretScope, transportOf, valuesOf } from "../mcp_servers/index.ts";
import { sameTransport } from "../mcp_servers/rules.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { CAP_MCP_SERVERS, nodeReady } from "../mcp_servers/tools.ts";
import { returnState } from "../../shared/oauth_return.ts";
import { isReturnPage } from "./sign_ins.ts";
import * as oauth from "./oauth.ts";
import { type Client, clientOf, due, PENDING_MS, projectOfRow, type Record_, recordText, RETRY_MS, type Row, tidy } from "./record.ts";

export { type Client, type Pending, PENDING_MS, projectOfRow, type Record_, RENEW_TICK_MS, type Row } from "./record.ts";

const COLUMNS = "machine_id, project_id, name, data, state, sealed_access, sealed_refresh";
type DbRow = {
  machine_id: string;
  project_id: string;
  name: string;
  data: string;
  state: string | null;
  sealed_access: Uint8Array | null;
  sealed_refresh: Uint8Array | null;
};

function rowOf(r: DbRow): Row | undefined {
  const scope: McpScope = r.machine_id === "" && r.project_id === "" ? { kind: "global" } : { kind: "project", machineId: r.machine_id, projectId: r.project_id };
  let record: Record_;
  try {
    // serde writes an absent Option as null: read as absent.
    record = JSON.parse(r.data, (_k, v) => (v === null ? undefined : v)) as Record_;
  } catch {
    return undefined;
  }
  return {
    scope,
    name: r.name,
    record,
    ...(r.state !== null ? { state: r.state } : {}),
    ...(r.sealed_access !== null ? { access: new Uint8Array(r.sealed_access) } : {}),
    ...(r.sealed_refresh !== null ? { refresh: new Uint8Array(r.sealed_refresh) } : {}),
  };
}

export function getRow(hub: Hub, scope: McpScope, name: string): Row | undefined {
  const [m, p] = scopeKey(scope);
  const r = hub.db.conn
    .query<DbRow, [string, string, string]>(`SELECT ${COLUMNS} FROM mcp_oauth WHERE machine_id = ? AND project_id = ? AND name = ?`)
    .get(m, p, name);
  return r ? rowOf(r) : undefined;
}

function byState(hub: Hub, st: string): Row | undefined {
  const r = hub.db.conn.query<DbRow, [string]>(`SELECT ${COLUMNS} FROM mcp_oauth WHERE state = ?`).get(st);
  return r ? rowOf(r) : undefined;
}

const allRows = (hub: Hub) =>
  hub.db.conn
    .query<DbRow, []>(`SELECT ${COLUMNS} FROM mcp_oauth`)
    .all()
    .map(rowOf)
    .filter((r): r is Row => r !== undefined);

export function putRow(hub: Hub, row: Row): void {
  const [m, p] = scopeKey(row.scope);
  hub.db.conn
    .query(
      `INSERT INTO mcp_oauth (machine_id, project_id, name, data, state, sealed_access, sealed_refresh)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (machine_id, project_id, name) DO UPDATE SET data = excluded.data, state = excluded.state,
         sealed_access = excluded.sealed_access, sealed_refresh = excluded.sealed_refresh`,
    )
    .run(m, p, row.name, recordText(row.record), row.state ?? null, row.access ?? null, row.refresh ?? null);
}

function removeRow(hub: Hub, scope: McpScope, name: string): void {
  const [m, p] = scopeKey(scope);
  hub.db.conn.query("DELETE FROM mcp_oauth WHERE machine_id = ? AND project_id = ? AND name = ?").run(m, p, name);
}

/** The hub's own box key (auth/box_key.ts's, the same `<home>/node-box-key.pem`), read once for this area (D354: under its own name). */
export const hubBoxKey = (hub: Hub) => hub.area("mcp_oauth_box_key", (h) => loadOrCreateBoxKey(h.config.home));
export const hubBoxPublic = (hub: Hub) => Buffer.from(publicKeyOf(hubBoxKey(hub))).toString("base64");

function sealOwn(hub: Hub, plain: string): Uint8Array {
  let key: Uint8Array;
  try {
    key = hubBoxKey(hub);
  } catch (e) {
    throw new Error(`the workspace's box key can't be read: ${(e as Error).message}`);
  }
  return seal(publicKeyOf(key), new TextEncoder().encode(plain));
}

export function openOwn(hub: Hub, sealed: Uint8Array): string {
  let key: Uint8Array;
  try {
    key = hubBoxKey(hub);
  } catch (e) {
    throw new Error(`the workspace's box key can't be read: ${(e as Error).message}`);
  }
  const plain = openSealed(key, sealed);
  if (!plain) throw new Error("a token was sealed to another box key: the workspace's home changed. Sign in again");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    throw new Error("a sealed token isn't text");
  }
}

function clientSecret(hub: Hub, client: Client): string | undefined {
  if (client.sealedSecret === undefined) return undefined;
  const bytes = Buffer.from(client.sealedSecret, "base64");
  if (bytes.toString("base64") !== client.sealedSecret) throw new Error("a client secret isn't base64");
  return openOwn(hub, new Uint8Array(bytes));
}

const tokenClient = (hub: Hub, c: Client): oauth.Client => {
  const secret = clientSecret(hub, c);
  return { id: c.clientId, ...(secret !== undefined ? { secret } : {}), ...(c.tokenAuth !== undefined ? { auth: c.tokenAuth } : {}) };
};

/** Changes the server's row in one step, so a save in between isn't lost; the server as it is now. */
function updateServer(hub: Hub, scope: McpScope, name: string, change: (s: McpServer) => void): McpServer | undefined {
  return hub.db.transaction(() => {
    const servers = mcpServers(hub);
    const s = servers.get(scope, name);
    if (!s) return undefined;
    change(s);
    servers.put(s);
    return s;
  });
}

/** Sets the server's sign-in as the app sees it, and tells the app. */
function show(hub: Hub, row: Row, change: (o: McpOauth) => void): void {
  const issuer = (row.record.pending?.client ?? row.record.client)?.issuer ?? "";
  const server = updateServer(hub, row.scope, row.name, (s) => {
    const o: McpOauth = s.oauth ?? { status: "signed_out", issuer, signingIn: false };
    change(o);
    s.oauth = tidy(o);
  });
  if (!server) return;
  const project = projectOfRow(row);
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "mcp.oauth",
    ...(project ? { machineId: project.machineId, projectId: project.projectId } : {}),
    summary: `${row.name}'s sign-in changed`,
    data: { projectRef: project ?? null, name: row.name, status: server.oauth?.status ?? null },
  });
}

/** `mcp.oauth` for a server removed from `scope`: every open app reads its servers again. */
export function removed(hub: Hub, scope: McpScope, name: string): void {
  const project = scope.kind === "project" ? { machineId: scope.machineId, projectId: scope.projectId } : undefined;
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "mcp.oauth",
    ...(project ? { machineId: project.machineId, projectId: project.projectId } : {}),
    summary: `${name} removed`,
    data: { projectRef: project ?? null, name, removed: true },
  });
}

/** What the chat area sets: a system line in a project's chat (chat `system_line`). */
export type OauthHooks = { say(r: ProjectRef, text: string): void };
export const oauthHooks = (hub: Hub) =>
  hub.area<OauthHooks>("mcp_oauth_hooks", () => ({
    say: (r, text) => console.warn(`mcp_oauth: no chat in this build; a line for ${r.machineId}/${r.projectId} not said: ${text}`),
  }));

/** A line in the chat of the server's bot, or of every bot for the team's (D592). */
function say(hub: Hub, row: Row, text: string): void {
  const own = projectOfRow(row);
  const bots = own ? [own] : store(hub).projectsList().map((p) => ({ machineId: p.machineId, projectId: p.projectId }));
  for (const r of bots) {
    try {
      oauthHooks(hub).say(r, text);
    } catch (e) {
      console.warn(`an MCP sign-in line was not said in the chat (${row.name}):`, e);
    }
  }
}

/** Where a person signs the server in again. */
const reconnectAt = (_row: Row) => "Connections";

/** The machines that keep the server's token: its bot's, or, for the team's, every machine a bot runs on. */
export function machinesOf(hub: Hub, row: Row): string[] {
  const own = projectOfRow(row);
  if (own) return [own.machineId];
  return [...new Set(store(hub).projectsList().map((p) => p.machineId))].sort();
}

/** The fingerprint a node answers for the header holding `access`: what it keeps, unopened. */
const printOf = (access: string) => createHash("sha256").update(`Bearer ${access}`).digest("hex").slice(0, 8);

const reachable = (hub: Hub, m: string) => linked(hub, m) && nodeCan(hub, m, CAP_MCP_SERVERS);

/** The URL and transport kind of a server that can sign in. */
export function urlOf(s: McpServer): [string, boolean] | undefined {
  if (s.transport.type === "http") return [s.transport.url, false];
  if (s.transport.type === "sse") return [s.transport.url, true];
  return undefined;
}

/** One token change at a time, hub-wide: a renewal and a sign-in of one server would each replace the other's tokens. */
const locks = new WeakMap<Hub, Promise<unknown>>();
async function one<T>(hub: Hub, f: () => Promise<T>): Promise<T> {
  const before = locks.get(hub) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  locks.set(hub, before.then(() => mine));
  await before.catch(() => {});
  try {
    return await f();
  } finally {
    release();
  }
}

export type Started = { signIn: string } | { needsClient: string };

/**
 * Opens a sign-in for a saved HTTP or SSE server of a project: where it signs in, which client (the one it signed in
 * with before, the person's own, or one fleetd registers now for `redirect`), and the sign-in page to open; `via`, the
 * workspace's address fleetd's return page forwards to when the client's redirect is that page. Errors are for the
 * person.
 */
export async function start(hub: Hub, server: McpServer, redirect: string, own?: { id: string; secret?: string }, via?: string): Promise<Started> {
  const at = urlOf(server);
  if (!at) throw new Error("only a server reached by URL signs in");
  const found = await oauth.discover(at[0], at[1]);
  const before = getRow(hub, server.scope, server.name);
  const earlierAny = before?.record.pending?.client ?? before?.record.client;
  const earlier = earlierAny && earlierAny.issuer === found.issuer ? earlierAny : undefined;
  let client: Client;
  if (own) {
    const sealedSecret = own.secret !== undefined ? Buffer.from(sealOwn(hub, own.secret)).toString("base64") : undefined;
    client = {
      ...clientOf(found),
      clientId: own.id,
      registered: false,
      redirectUri: redirect,
      ...(sealedSecret !== undefined ? { sealedSecret, tokenAuth: oauth.tokenAuthFor(found.authMethods) } : {}),
    };
  } else if (earlier && (!earlier.registered || (earlier.redirectUri === redirect && earlier.scope === found.scope))) {
    // The person's own client keeps the redirect they gave it; a registered one is fleetd's for its redirect and the
    // scope it registered with, so a service now asked for more registers fleetd again.
    client = {
      ...clientOf(found),
      clientId: earlier.clientId,
      registered: earlier.registered,
      redirectUri: earlier.redirectUri,
      ...(earlier.sealedSecret !== undefined ? { sealedSecret: earlier.sealedSecret } : {}),
      ...(earlier.tokenAuth !== undefined ? { tokenAuth: earlier.tokenAuth } : {}),
    };
  } else if (found.registrationEndpoint !== undefined) {
    const reg = await oauth.register(found, redirect);
    const sealedSecret = reg.clientSecret !== undefined ? Buffer.from(sealOwn(hub, reg.clientSecret)).toString("base64") : undefined;
    client = {
      ...clientOf(found),
      clientId: reg.clientId,
      registered: true,
      redirectUri: redirect,
      ...(sealedSecret !== undefined ? { sealedSecret } : {}),
      ...(reg.tokenAuth !== undefined ? { tokenAuth: reg.tokenAuth } : {}),
    };
  } else {
    return { needsClient: found.issuer };
  }
  const [verifier, challenge] = oauth.pkce();
  // Through fleetd's return page, the state carries the workspace's address there (shared/oauth_return.ts): whenever
  // the client's redirect is the page, as one registered or given earlier keeps it after the workspace stops using it.
  let st = oauth.state();
  if (isReturnPage(client.redirectUri)) {
    if (via === undefined) throw new Error("it signs in through fleetd's return page, which needs the workspace's tailnet or network address: sign in from an app that reaches it there");
    st = returnState(st, via);
  }
  const url = oauth.authorizeUrl(client.authorizationEndpoint, client.clientId, client.redirectUri, challenge, st, client.scope, client.resource);
  return one(hub, async () => {
    const row: Row = getRow(hub, server.scope, server.name) ?? { scope: server.scope, name: server.name, record: {} };
    const ownId = client.registered ? undefined : client.clientId;
    row.record.pending = { client, verifier, startedMs: hub.clock.now() };
    row.state = st;
    putRow(hub, row);
    show(hub, row, (o) => {
      o.signingIn = true;
      o.issuer = found.issuer;
      o.clientId = ownId;
      o.problem = undefined;
    });
    return { signIn: url };
  });
}

export type Finished = { connected: string; onMachine: boolean } | { failed: string; name?: string };

/** The service sent the browser back with `state` and a `code`, or an `error`: trades the code for the tokens. */
export function finish(hub: Hub, st: string, code: string | undefined, error: string | undefined): Promise<Finished> {
  return one(hub, async () => {
    let row: Row | undefined;
    try {
      row = byState(hub, st);
    } catch (e) {
      return { failed: `The workspace can't read its sign-ins: ${(e as Error).message}` };
    }
    if (!row) {
      return { failed: "This sign-in link was already used, or replaced by a newer one. Start the sign-in again from fleetd." };
    }
    const name = row.name;
    try {
      return { connected: name, onMachine: await exchange(hub, row, code, error) };
    } catch (e) {
      return { failed: (e as Error).message, name };
    }
  });
}

async function exchange(hub: Hub, row: Row, code: string | undefined, error: string | undefined): Promise<boolean> {
  const pending = row.record.pending;
  if (!pending) throw new Error("This sign-in was already finished. Start it again from fleetd.");
  delete row.record.pending;
  delete row.state;
  const host = oauth.hostOf(pending.client.issuer);
  let tokens: oauth.Tokens;
  try {
    if (hub.clock.now() - pending.startedMs > PENDING_MS) throw new Error("This sign-in took over 15 minutes. Start it again from fleetd.");
    if (error !== undefined) throw new Error(`${host} didn't sign you in (${error}).`);
    if (code === undefined) throw new Error(`${host} sent the browser back without a sign-in code.`);
    try {
      tokens = await oauth.token(pending.client.tokenEndpoint, tokenClient(hub, pending.client), pending.client.resource, [
        ["grant_type", "authorization_code"],
        ["code", code],
        ["redirect_uri", pending.client.redirectUri],
        ["code_verifier", pending.verifier],
      ]);
    } catch (e) {
      if (e instanceof oauth.TokenError) {
        throw new Error(e.kind === "refused" ? `${host} refused the sign-in (${e.message}). Start it again.` : `Signing in failed: ${e.message}.`);
      }
      throw e;
    }
  } catch (e) {
    const problem = (e as Error).message;
    putRow(hub, row);
    show(hub, row, (o) => {
      o.signingIn = false;
      o.problem = problem;
    });
    throw e;
  }
  const at = hub.clock.now();
  row.record.client = pending.client;
  keepTokens(hub, row, tokens, at);
  putRow(hub, row);
  // The token goes to the machine first: the app tests the server as soon as it reads Connected.
  let onMachine = true;
  try {
    await push(hub, row);
  } catch (e) {
    console.info(`a signed-in MCP server's token waits for its machine (${row.name}): ${(e as Error).message}`);
    onMachine = false;
  }
  const expires = row.record.expiresMs;
  show(hub, row, (o) => {
    o.status = "connected";
    o.signingIn = false;
    o.signedInAt = isoMs(at);
    o.expiresAt = expires !== undefined ? isoMs(expires) : undefined;
    o.problem = undefined;
  });
  return onMachine;
}

/** Seals new tokens in the row: a refresh token the service didn't replace stays. */
function keepTokens(hub: Hub, row: Row, tokens: oauth.Tokens, at: number): void {
  row.access = sealOwn(hub, tokens.access);
  if (tokens.refresh !== undefined) row.refresh = sealOwn(hub, tokens.refresh);
  row.record.lifetimeMs = tokens.expiresIn !== undefined ? tokens.expiresIn * 1000 : undefined;
  row.record.expiresMs = tokens.expiresIn !== undefined ? at + tokens.expiresIn * 1000 : undefined;
  row.record.pushed = false;
  delete row.record.failingSinceMs;
  delete row.record.retryMs;
}

/**
 * Seals the access token to each machine that keeps it (`machinesOf`) as the server's `Authorization` header, keeping
 * its other secrets there, and records the fingerprint each node answers. A machine that holds it already is skipped;
 * one offline gets it on a later round of the renewal loop. A bot's server needs its one machine (else it throws);
 * the team's throws only when it reached none.
 */
export async function push(hub: Hub, row: Row): Promise<void> {
  const own = projectOfRow(row);
  if (own) nodeReady(hub, own.machineId);
  if (!row.access) throw new Error("no token to hand over");
  const access = openOwn(hub, row.access);
  const print = printOf(access);
  const server = mcpServers(hub).get(row.scope, row.name);
  if (!server) throw new Error("the server was removed");
  const holding = (server.headers ?? []).find((v) => isToken("header", v.name))?.sealedOn ?? [];
  const held: { machineId: string; fingerprint: string }[] = [];
  const missed: string[] = [];
  for (const m of machinesOf(hub, row)) {
    if (holding.some((x) => x.machineId === m && x.fingerprint === print)) continue;
    if (!reachable(hub, m)) {
      missed.push(`${m} is offline`);
      continue;
    }
    const boxKey = store(hub).machineGet(m)?.boxPubKey;
    const pub = boxKey ? Buffer.from(boxKey, "base64") : undefined;
    if (!pub || pub.length !== 32) {
      missed.push(`${m} has no box key to seal the token to`);
      continue;
    }
    const sealedBox = Buffer.from(seal(new Uint8Array(pub), new TextEncoder().encode(`Bearer ${access}`))).toString("base64");
    try {
      const out = await sessionCall(hub, m, {
        op: "mcp_secrets",
        scope: secretScope(row.scope),
        server: row.name,
        set: [{ field: "header", name: OAUTH_HEADER, sealed: sealedBox }],
        keep: othersOn(server, m),
      });
      const saved = (out.secrets as { field: string; name: string; fingerprint: string }[] | undefined) ?? [];
      const fingerprint = saved.find((x) => x.field === "header" && x.name === OAUTH_HEADER)?.fingerprint;
      if (!fingerprint) throw new Error(`${m} didn't keep the token`);
      held.push({ machineId: m, fingerprint });
    } catch (e) {
      if (own) throw e;
      missed.push(`${m}: ${(e as Error).message}`);
    }
  }
  if (held.length > 0) {
    updateServer(hub, row.scope, row.name, (s) => {
      const before = (s.headers ?? []).find((v) => isToken("header", v.name))?.sealedOn ?? [];
      const sealedOn = [...before.filter((x) => !held.some((h) => h.machineId === x.machineId)), ...held].sort((x, y) => (x.machineId < y.machineId ? -1 : 1));
      s.headers = (s.headers ?? []).filter((v) => !isToken("header", v.name));
      s.headers.push({ name: OAUTH_HEADER, kind: "secret", sealedOn });
    });
  }
  row.record.pushed = missed.length === 0;
  putRow(hub, row);
  if (missed.length > 0 && held.length === 0 && !holding.some((x) => x.fingerprint === print)) throw new Error(missed.join("; "));
}

/** The server's secrets on machine `m` other than its token: they stay there when the token changes or goes. */
const othersOn = (server: McpServer, m: string) =>
  valuesOf(server)
    .filter(([f, v]) => v.kind === "secret" && !isToken(f, v.name) && (v.sealedOn ?? []).some((s) => s.machineId === m))
    .map(([field, v]) => ({ field, name: v.name }));

const isToken = (field: string, name: string) => field === "header" && name.toLowerCase() === OAUTH_HEADER.toLowerCase();

/**
 * Takes a signed-out server's dead token off each machine holding it, keeping its other secrets there, then out of
 * the server's headers: no session gets the server again, and a running agent's relay hears that it is signed out. A
 * machine offline now has it taken on a later round of the renewal loop (`renewOne`).
 */
export async function erase(hub: Hub, row: Row): Promise<void> {
  const server = mcpServers(hub).get(row.scope, row.name);
  const holding = (server?.headers ?? []).find((v) => isToken("header", v.name));
  if (!server || row.access || !holding) return;
  const own = projectOfRow(row);
  if (own) nodeReady(hub, own.machineId);
  const gone: string[] = [];
  for (const { machineId: m } of holding.sealedOn ?? []) {
    if (!reachable(hub, m)) continue;
    await sessionCall(hub, m, { op: "mcp_secrets", scope: secretScope(row.scope), server: row.name, set: [], keep: othersOn(server, m) });
    gone.push(m);
  }
  updateServer(hub, row.scope, row.name, (s) => {
    const token = (s.headers ?? []).find((v) => isToken("header", v.name));
    const left = (token?.sealedOn ?? []).filter((x) => !gone.includes(x.machineId));
    s.headers = (s.headers ?? []).filter((v) => !isToken("header", v.name));
    if (left.length > 0) s.headers.push({ name: OAUTH_HEADER, kind: "secret", sealedOn: left });
  });
}

/** The service won't renew: agents go without the server until the person signs in again. Its token leaves the
 * machine as well (`erase`). */
async function signOut(hub: Hub, row: Row, problem: string): Promise<void> {
  delete row.access;
  delete row.refresh;
  delete row.record.expiresMs;
  row.record.pushed = false;
  delete row.record.failingSinceMs;
  delete row.record.retryMs;
  row.record.told = false;
  putRow(hub, row);
  show(hub, row, (o) => {
    o.status = "signed_out";
    o.expiresAt = undefined;
    o.problem = problem;
  });
  say(
    hub,
    row,
    `${row.name} is signed out: ${problem} ${row.scope.kind === "global" ? "No bot can" : "Its bot can't"} use it until you sign in again on it in ${reconnectAt(row)}.`,
  );
  try {
    await erase(hub, row);
  } catch (e) {
    console.info(`a signed-out MCP server's token waits to leave its machine (${row.name}): ${(e as Error).message}`);
  }
}

export type Renewed = "yes" | "later" | "signed_out";

/** Renews the server's access token with its refresh token, and hands the new one to the machine. */
export async function renew(hub: Hub, row: Row): Promise<Renewed> {
  const at = hub.clock.now();
  const client = row.record.client;
  if (!client) return "signed_out";
  const host = oauth.hostOf(client.issuer);
  if (!row.refresh) {
    if (row.record.expiresMs !== undefined && row.record.expiresMs <= at) {
      await signOut(hub, row, `its sign-in ended, and ${host} gives no way to renew it.`);
      return "signed_out";
    }
    return "later";
  }
  const refresh = openOwn(hub, row.refresh);
  let tokens: oauth.Tokens;
  try {
    tokens = await oauth.token(client.tokenEndpoint, tokenClient(hub, client), client.resource, [
      ["grant_type", "refresh_token"],
      ["refresh_token", refresh],
    ]);
  } catch (e) {
    if (!(e instanceof oauth.TokenError)) throw e;
    if (e.kind === "refused") {
      await signOut(hub, row, `${host} ended the sign-in (${e.message}), so you need to sign in again.`);
      return "signed_out";
    }
    row.record.failingSinceMs ??= at;
    row.record.retryMs = at + RETRY_MS;
    const ended = row.record.expiresMs !== undefined && row.record.expiresMs <= at;
    const tell = ended && !row.record.told;
    if (tell) row.record.told = true;
    putRow(hub, row);
    if (tell) {
      const problem = `fleetd can't renew its sign-in: ${e.message}. It keeps trying.`;
      show(hub, row, (o) => {
        o.problem = problem;
      });
      say(hub, row, `${row.name} isn't working: ${problem} the lead can't use it until then.`);
    }
    return "later";
  }
  const told = row.record.told ?? false;
  keepTokens(hub, row, tokens, at);
  row.record.told = false;
  putRow(hub, row);
  const expires = row.record.expiresMs;
  show(hub, row, (o) => {
    o.expiresAt = expires !== undefined ? isoMs(expires) : undefined;
    o.problem = undefined;
  });
  if (told) say(hub, row, `${row.name} works again: the lead can use it.`);
  try {
    await push(hub, row);
  } catch (e) {
    console.info(`a renewed MCP token waits for its machine (${row.name}): ${(e as Error).message}`);
  }
  return "yes";
}

const TEAM: McpScope = { kind: "global" };

/** The newest working sign-in first: connected before not, then signed in last. */
const newestFirst = (a: McpServer, b: McpServer) => {
  const on = (s: McpServer) => (s.oauth?.status === "connected" ? 1 : 0);
  return on(b) - on(a) || (b.oauth?.signedInAt ?? "").localeCompare(a.oauth?.signedInAt ?? "");
};

/** A bot's server goes, with its sign-in, and its machine forgets the secrets it kept for it. */
function dropBots(hub: Hub, server: McpServer): void {
  if (server.scope.kind !== "project") return;
  const s = mcpServers(hub);
  s.remove(server.scope, server.name);
  removeRow(hub, server.scope, server.name);
  s.forget(server.scope.machineId, server.scope.projectId, server.name);
  removed(hub, server.scope, server.name);
}

/**
 * A bot's signed-in server becomes the team's (D592), with its sign-in, so nobody signs in again: the server and its
 * tokens move to the global scope, and the token goes to every bot's machine on its next push. Another bot's sign-in
 * to the same server goes (not revoked: the service may hold one grant for both). One whose name a team server with
 * a key of its own already has stays the bot's.
 */
function toTeam(hub: Hub, servers: McpServer[]): Row | undefined {
  const s = mcpServers(hub);
  const name = servers[0]!.name;
  const team = s.get(TEAM, name);
  // The team has a server of that name with a key of its own, or another service under it: these stay the bots'.
  if (team && (team.oauth === undefined || !sameTransport(team.transport, servers[0]!.transport))) return undefined;
  const [keep, ...rest] = team ? [undefined, ...servers] : [...servers].sort(newestFirst);
  let moved: Row | undefined;
  if (keep) {
    const row = getRow(hub, keep.scope, name);
    // The token is on its bot's machine under the bot's scope: it is pushed again under the team's.
    s.put({ ...keep, scope: TEAM, headers: (keep.headers ?? []).map((v) => (isToken("header", v.name) ? { name: v.name, kind: "secret" } : v)) });
    if (row) {
      moved = { ...row, scope: TEAM, record: { ...row.record, pushed: false } };
      putRow(hub, moved);
    }
    dropBots(hub, keep);
  }
  for (const other of rest) if (other) dropBots(hub, other);
  return moved;
}

/** The server a carry-over groups by: one service is its name at one address. */
const serviceOf = (s: McpServer) => `${s.name}\u0000${JSON.stringify(transportOf(s.transport))}`;

/** Every bot's signed-in server with no key of its own (`teamable`) becomes the team's (`toTeam`), and its token goes
 * to every bot's machine. One with a key of its own stays the bot's: its key is sealed under the bot's scope. */
export async function carryOver(hub: Hub): Promise<void> {
  const byService = new Map<string, McpServer[]>();
  for (const server of mcpServers(hub).perBot()) {
    if (server.oauth && teamable(server)) byService.set(serviceOf(server), [...(byService.get(serviceOf(server)) ?? []), server]);
  }
  for (const servers of byService.values()) {
    const row = await one(hub, async () => toTeam(hub, servers));
    if (row?.access) await push(hub, row).catch((e) => console.info(`a team sign-in's token waits for its machines (${row.name}): ${(e as Error).message}`));
  }
}

/** A server that signs in with an account and has no key of its own, which the team connects once. */
export const teamable = (s: McpServer) =>
  s.transport.type !== "stdio" && (s.env ?? []).length === 0 && (s.headers ?? []).every((v) => v.kind === "secret" && isToken("header", v.name));

/**
 * A sign-in opened on a bot's server signs the team in instead (D592): the server is the team's from then on, unless
 * another bot's sign-in to it is newer, which the team keeps.
 */
export async function teamScope(hub: Hub, server: McpServer, by?: string): Promise<McpServer> {
  const at = server.scope;
  if (at.kind === "global" || !teamable(server)) return server;
  const same = mcpServers(hub)
    .perBot()
    .filter(
      (s) =>
        serviceOf(s) === serviceOf(server) &&
        ((s.oauth !== undefined && teamable(s)) || (s.scope.kind === "project" && s.scope.machineId === at.machineId && s.scope.projectId === at.projectId)),
    );
  const had = mcpServers(hub).get(TEAM, server.name);
  const row = await one(hub, async () => toTeam(hub, same));
  if (row?.access) await push(hub, row).catch(() => {});
  // The team's only when the bot's went to it; else (the team keeps a server of that name of its own) the bot's.
  const team = mcpServers(hub).get(TEAM, server.name);
  if (!team || mcpServers(hub).get(at, server.name) !== undefined || !sameTransport(team.transport, server.transport)) return server;
  // Made the team's now, by this sign-in: who signs it in connected it for the team.
  if (by !== undefined && had === undefined && team.connectedBy === undefined) {
    return (
      updateServer(hub, TEAM, server.name, (s) => {
        s.connectedBy = by;
      }) ?? team
    );
  }
  return team;
}

/** One round of the renewal loop: ends sign-ins left unfinished, renews tokens near their end, pushes missed ones. */
export async function renewDue(hub: Hub): Promise<void> {
  try {
    await carryOver(hub);
  } catch (e) {
    console.warn("bots' MCP sign-ins not carried over to the team:", e);
  }
  let rows: Row[];
  try {
    rows = allRows(hub);
  } catch (e) {
    console.warn("MCP sign-ins not read:", e);
    return;
  }
  for (const listed of rows) {
    await one(hub, async () => {
      // Read again under the lock: a callback may have changed it.
      const row = getRow(hub, listed.scope, listed.name);
      if (!row) return;
      try {
        await renewOne(hub, row);
      } catch (e) {
        console.warn(`MCP sign-in not renewed (${row.name}): ${(e as Error).message}`);
      }
    });
  }
}

async function renewOne(hub: Hub, row: Row): Promise<void> {
  const at = hub.clock.now();
  if (row.record.pending && at - row.record.pending.startedMs > PENDING_MS) {
    delete row.record.pending;
    delete row.state;
    putRow(hub, row);
    show(hub, row, (o) => {
      o.signingIn = false;
      o.problem = "The sign-in wasn't finished within 15 minutes. Start it again.";
    });
  }
  if (!row.access) {
    // Signed out while its machine was offline: the dead token leaves it now.
    await erase(hub, row).catch(() => {});
    return;
  }
  if (due(row.record, at) && (row.record.retryMs === undefined || row.record.retryMs <= at)) await renew(hub, row);
  if (row.access && (!row.record.pushed || lacking(hub, row))) {
    // A machine offline now, or one that has run a bot only since, gets it on a later round.
    await push(hub, row).catch(() => {});
  }
}

/** A machine that keeps the server's token (`machinesOf`) doesn't hold the current one: one that got its first bot
 * since the last push. */
function lacking(hub: Hub, row: Row): boolean {
  if (!row.access) return false;
  const print = printOf(openOwn(hub, row.access));
  const holding = (mcpServers(hub).get(row.scope, row.name)?.headers ?? []).find((v) => isToken("header", v.name))?.sealedOn ?? [];
  return machinesOf(hub, row).some((m) => !holding.some((x) => x.machineId === m && x.fingerprint === print));
}

/**
 * The server was removed, or no longer signs in: forgets its sign-in, and revokes the token where the service
 * offers it.
 */
export function forget(hub: Hub, scope: McpScope, name: string): Promise<void> {
  return one(hub, async () => {
    let row: Row | undefined;
    try {
      row = getRow(hub, scope, name);
    } catch (e) {
      console.warn(`MCP sign-in not read (${name}):`, e);
      return;
    }
    if (!row) return;
    removeRow(hub, scope, name);
    const client = row.record.client;
    const endpoint = client?.revocationEndpoint;
    if (!client || endpoint === undefined) return;
    const [sealedToken, hint] = row.refresh ? [row.refresh, "refresh_token"] : row.access ? [row.access, "access_token"] : [undefined, ""];
    if (!sealedToken) return;
    let tok: string;
    let c: oauth.Client;
    try {
      tok = openOwn(hub, sealedToken);
      c = tokenClient(hub, client);
    } catch {
      return;
    }
    if (!(await oauth.revoke(endpoint, c, tok, hint))) console.info(`the service didn't confirm the MCP token's revocation (${name})`);
  });
}

/**
 * The token an agent was turned away with (`stale`, the fingerprint its node holds) is older than the hub's: another
 * agent's turn-away renewed it in between. Nothing is renewed or signed out for it; the current token goes to the
 * machines that still lack it, and the agent tries that one.
 */
async function superseded(hub: Hub, row: Row, stale: string | undefined): Promise<boolean> {
  if (stale === undefined || !row.access || printOf(openOwn(hub, row.access)) === stale) return false;
  await push(hub, row).catch((e) => console.info(`a renewed MCP token waits for its machine (${row.name}): ${(e as Error).message}`));
  return true;
}

/** Renews the server's token now, as when the server turned the token away before it was due: unless `stale`, the
 * token it turned away, is older than the hub's current one (`superseded`). */
export function renewNow(hub: Hub, scope: McpScope, name: string, stale?: string): Promise<Renewed> {
  return one(hub, async () => {
    const row = getRow(hub, scope, name);
    if (!row?.access) return "signed_out";
    if (await superseded(hub, row, stale)) return "yes";
    return renew(hub, row);
  });
}

/**
 * An agent's relay was turned away with the token just renewed (`mcp_oauth_renew` with `refused`): the service no
 * longer takes this sign-in, so the server is signed out, which Settings and the chat say, and its token leaves the
 * machines. Only for the hub's current token: one older than it (`stale`, superseded by another agent's renewal)
 * never signs out.
 */
export function turnedAway(hub: Hub, scope: McpScope, name: string, stale?: string): Promise<Renewed> {
  return one(hub, async (): Promise<Renewed> => {
    const row = getRow(hub, scope, name);
    if (!row?.access) return "signed_out";
    if (await superseded(hub, row, stale)) return "yes";
    const host = row.record.client ? oauth.hostOf(row.record.client.issuer) : name;
    await signOut(hub, row, `${host} turned away the sign-in fleetd had just renewed, so you need to sign in again.`);
    return "signed_out";
  });
}
