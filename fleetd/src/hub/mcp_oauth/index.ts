// MCP servers that sign in with OAuth, with no fleetd-run OAuth app: the
// hub registers itself with the service where it may, else takes the person's own client. `mcp_oauth_start` discovers
// where a saved server signs in and hands the app the service's sign-in page, opened with PKCE and a redirect to
// `<hub>/oauth/callback`. The callback trades the code for the tokens (`finish`). The hub keeps them sealed to its own
// box key in `mcp_oauth`, and seals each access token to the project's machine as the server's `Authorization`
// header (`push`). `renewDue` renews a token before it ends; a service that refuses signs the server out.
import type { McpOauth, McpScope, McpServer, ProjectRef } from "../../shared/contracts.ts";
import { loadOrCreateBoxKey, openSealed, publicKeyOf, seal } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { sessionCall } from "../link/node_port.ts";
import { mcpServers, OAUTH_HEADER, scopeKey, secretScope, valuesOf } from "../mcp_servers/index.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { nodeReady } from "../mcp_servers/tools.ts";
import * as oauth from "./oauth.ts";

/** How long a sign-in waits for the person to finish it in their browser. */
export const PENDING_MS = 15 * 60_000;
/** How often the renewal loop looks. */
export const RENEW_TICK_MS = 30_000;
const MARGIN_MAX_MS = 30 * 60_000;
const MARGIN_UNKNOWN_MS = 5 * 60_000;
const RETRY_MS = 2 * 60_000;

/** A client of one service: where it signs in, and as which app. */
export type Client = {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  scope?: string;
  clientId: string;
  registered: boolean;
  redirectUri: string;
  /** Its secret, sealed to the hub's own box key (standard base64); none for a public client. */
  sealedSecret?: string;
  tokenAuth?: string;
};

export type Pending = { client: Client; verifier: string; startedMs: number };

/** What the hub keeps of a server's sign-in besides its sealed tokens (`mcp_oauth.data`). */
export type Record_ = {
  client?: Client;
  expiresMs?: number;
  lifetimeMs?: number;
  pushed?: boolean;
  failingSinceMs?: number;
  retryMs?: number;
  told?: boolean;
  pending?: Pending;
};

export type Row = {
  scope: McpScope;
  name: string;
  record: Record_;
  state?: string;
  access?: Uint8Array;
  refresh?: Uint8Array;
};

export const projectOfRow = (row: Row): ProjectRef | undefined =>
  row.scope.kind === "project" ? { machineId: row.scope.machineId, projectId: row.scope.projectId } : undefined;

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

const clientText = (c: Client) => ({
  resource: c.resource,
  issuer: c.issuer,
  authorizationEndpoint: c.authorizationEndpoint,
  tokenEndpoint: c.tokenEndpoint,
  revocationEndpoint: c.revocationEndpoint ?? null,
  scope: c.scope ?? null,
  clientId: c.clientId,
  registered: c.registered,
  redirectUri: c.redirectUri,
  sealedSecret: c.sealedSecret ?? null,
  tokenAuth: c.tokenAuth ?? null,
});

/** The record as serde writes it: every field in the struct's order, an absent one as null. */
function recordText(r: Record_): string {
  return JSON.stringify({
    client: r.client ? clientText(r.client) : null,
    expiresMs: r.expiresMs ?? null,
    lifetimeMs: r.lifetimeMs ?? null,
    pushed: r.pushed ?? false,
    failingSinceMs: r.failingSinceMs ?? null,
    retryMs: r.retryMs ?? null,
    told: r.told ?? false,
    pending: r.pending ? { client: clientText(r.pending.client), verifier: r.pending.verifier, startedMs: r.pending.startedMs } : null,
  });
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

/** The hub's own box key (hub_links.rs `box_key`, the same `<home>/node-box-key.pem`), read once for this area (D354: under its own name). */
export const hubBoxKey = (hub: Hub) => hub.area("mcp_oauth_box_key", (h) => loadOrCreateBoxKey(h.config.home));
export const hubBoxPublic = (hub: Hub) => Buffer.from(publicKeyOf(hubBoxKey(hub))).toString("base64");

function sealOwn(hub: Hub, plain: string): Uint8Array {
  let key: Uint8Array;
  try {
    key = hubBoxKey(hub);
  } catch (e) {
    throw new Error(`the hub's box key can't be read: ${(e as Error).message}`);
  }
  return seal(publicKeyOf(key), new TextEncoder().encode(plain));
}

export function openOwn(hub: Hub, sealed: Uint8Array): string {
  let key: Uint8Array;
  try {
    key = hubBoxKey(hub);
  } catch (e) {
    throw new Error(`the hub's box key can't be read: ${(e as Error).message}`);
  }
  const plain = openSealed(key, sealed);
  if (!plain) throw new Error("a token was sealed to another box key: the hub's home changed. Sign in again");
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

/** McpOauth in serde's order with absent fields left out; `signingIn` always. */
function tidy(o: McpOauth): McpOauth {
  return {
    status: o.status,
    issuer: o.issuer,
    ...(o.clientId != null ? { clientId: o.clientId } : {}),
    signingIn: o.signingIn ?? false,
    ...(o.signedInAt != null ? { signedInAt: o.signedInAt } : {}),
    ...(o.expiresAt != null ? { expiresAt: o.expiresAt } : {}),
    ...(o.problem != null ? { problem: o.problem } : {}),
  };
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

function say(hub: Hub, row: Row, text: string): void {
  const r = projectOfRow(row);
  if (!r) return;
  try {
    oauthHooks(hub).say(r, text);
  } catch (e) {
    console.warn(`an MCP sign-in line was not said in the chat (${row.name}):`, e);
  }
}

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

const clientOf = (found: oauth.Discovered): Client => ({
  resource: found.resource,
  issuer: found.issuer,
  authorizationEndpoint: found.authorizationEndpoint,
  tokenEndpoint: found.tokenEndpoint,
  ...(found.revocationEndpoint !== undefined ? { revocationEndpoint: found.revocationEndpoint } : {}),
  ...(found.scope !== undefined ? { scope: found.scope } : {}),
  clientId: "",
  registered: false,
  redirectUri: "",
});

/**
 * Opens a sign-in for a saved HTTP or SSE server of a project: where it signs in, which client (the one it signed in
 * with before, the person's own, or one fleetd registers now for `redirect`), and the sign-in page to open. Errors are
 * for the person.
 */
export async function start(hub: Hub, server: McpServer, redirect: string, own?: { id: string; secret?: string }): Promise<Started> {
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
  } else if (earlier && (!earlier.registered || earlier.redirectUri === redirect)) {
    // The person's own client keeps the redirect they gave it; a registered one is fleetd's for its redirect.
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
  const st = oauth.state();
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
      return { failed: `The hub can't read its sign-ins: ${(e as Error).message}` };
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
 * Seals the access token to the project's machine as the server's `Authorization` header, keeping its other secrets
 * there, and records the fingerprint the node answers.
 */
export async function push(hub: Hub, row: Row): Promise<void> {
  const r = projectOfRow(row);
  if (!r) throw new Error("a global server doesn't sign in");
  const m = r.machineId;
  nodeReady(hub, m);
  if (!row.access) throw new Error("no token to hand over");
  const access = openOwn(hub, row.access);
  const boxKey = store(hub).machineGet(m)?.boxPubKey;
  if (!boxKey) throw new Error(`${m} has no box key to seal the token to`);
  const pub = Buffer.from(boxKey, "base64");
  if (pub.length !== 32) throw new Error(`${m}'s box key isn't 32 bytes`);
  const sealedBox = Buffer.from(seal(new Uint8Array(pub), new TextEncoder().encode(`Bearer ${access}`))).toString("base64");
  const server = mcpServers(hub).get(row.scope, row.name);
  if (!server) throw new Error("the server was removed");
  const keep = valuesOf(server)
    .filter(
      ([f, v]) =>
        v.kind === "secret" &&
        !(f === "header" && v.name.toLowerCase() === OAUTH_HEADER.toLowerCase()) &&
        (v.sealedOn ?? []).some((s) => s.machineId === m),
    )
    .map(([field, v]) => ({ field, name: v.name }));
  const out = await sessionCall(hub, m, {
    op: "mcp_secrets",
    scope: secretScope(row.scope),
    server: row.name,
    set: [{ field: "header", name: OAUTH_HEADER, sealed: sealedBox }],
    keep,
  });
  const saved = (out.secrets as { field: string; name: string; fingerprint: string }[] | undefined) ?? [];
  const fingerprint = saved.find((s) => s.field === "header" && s.name === OAUTH_HEADER)?.fingerprint;
  if (!fingerprint) throw new Error("the machine didn't keep the token");
  updateServer(hub, row.scope, row.name, (s) => {
    s.headers = (s.headers ?? []).filter((v) => v.name.toLowerCase() !== OAUTH_HEADER.toLowerCase());
    s.headers.push({ name: OAUTH_HEADER, kind: "secret", sealedOn: [{ machineId: m, fingerprint }] });
  });
  row.record.pushed = true;
  putRow(hub, row);
}

/** Whether the token should be renewed now: half its life left, at most MARGIN_MAX_MS. */
function due(record: Record_, at: number): boolean {
  if (record.expiresMs === undefined) return false;
  const margin = Math.min(record.lifetimeMs !== undefined ? Math.trunc(record.lifetimeMs / 2) : MARGIN_UNKNOWN_MS, MARGIN_MAX_MS);
  return record.expiresMs - at <= margin;
}

/** The service won't renew: agents go without the server until the person signs in again. */
function signOut(hub: Hub, row: Row, problem: string): void {
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
    `${row.name} is signed out: ${problem} Navi can't use it until you press Reconnect on it in Navi's settings › Integrations.`,
  );
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
      signOut(hub, row, `its sign-in ended, and ${host} gives no way to renew it.`);
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
      signOut(hub, row, `${host} ended the sign-in (${e.message}), so you need to sign in again.`);
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

/** One round of the renewal loop: ends sign-ins left unfinished, renews tokens near their end, pushes missed ones. */
export async function renewDue(hub: Hub): Promise<void> {
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
  if (!row.access) return;
  if (due(row.record, at) && (row.record.retryMs === undefined || row.record.retryMs <= at)) await renew(hub, row);
  if (row.access && !row.record.pushed) {
    // A machine offline now gets it on a later round.
    await push(hub, row).catch(() => {});
  }
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

/** Renews the server's token now, as when the server turned the token away before it was due. */
export function renewNow(hub: Hub, scope: McpScope, name: string): Promise<Renewed> {
  return one(hub, async () => {
    const row = getRow(hub, scope, name);
    if (!row?.access) return "signed_out";
    return renew(hub, row);
  });
}
