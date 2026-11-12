// MCP's OAuth sign-in as a client runs it, over the `Net` it is given (oauth.ts gives the hub's): discovery of a
// server's authorization server, client registration, PKCE, the authorize URL, and the token and revoke calls.
import { createHash, randomBytes } from "node:crypto";

export const TIMEOUT_MS = 20_000;
export const PROTOCOL_VERSION = "2025-06-18";

export type Discovered = {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scope?: string;
  authMethods: string[];
};

export type Registered = { clientId: string; clientSecret?: string; tokenAuth?: string };
export type Tokens = { access: string; refresh?: string; expiresIn?: number };

/** Why the token endpoint gave none: `refused` (only signing in again helps) or `failed` (a later try may work). */
export class TokenError extends Error {
  constructor(
    readonly kind: "refused" | "failed",
    message: string,
  ) {
    super(message);
  }
}

/** The client as the token endpoint sees it. */
export type Client = { id: string; secret?: string; auth?: string };

/** How the flow reaches a server: a fetch that follows redirects only within its first origin (oauth.ts `http`). */
export type Http = (url: string, init?: RequestInit) => Promise<Response>;

/** The flow's way out: its `http`, and the version it names itself with to a server it knocks on. */
export type Net = { http: Http; version: string };

const base64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** Why a call never got an answer, as the Rust client words it. */
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The host part of a URL as a message names it, as code: `` `auth.example.com` ``. */
export function hostOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname || url;
  } catch {
    host = url;
  }
  return `\`${host.replace(/^\[|\]$/g, "")}\``;
}

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m ? m.slice(1).map(Number) : undefined;
}

/** https, or http to this machine or a tailnet (`.ts.net`, 100.64.0.0/10, fd7a:115c:a1e0::/48). */
export function secure(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} is no URL`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new Error(`${url} names no host`);
  const v4 = ipv4(host);
  const priv = v4
    ? v4[0] === 127 || (v4[0] === 100 && ((v4[1] ?? 0) & 0xc0) === 64)
    : host.includes(":")
      ? host === "::1" || /^fd7a:115c:a1e0(:|$)/.test(host)
      : host === "localhost" || host.endsWith(".ts.net");
  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme === "https") return parsed;
  if (scheme === "http" && priv) return parsed;
  if (scheme === "http") throw new Error(`${hostOf(url)} signs in over plain HTTP, which would send your sign-in in the clear`);
  throw new Error(`${url} is ${scheme}:, not https`);
}

const isSecure = (url: string) => {
  try {
    secure(url);
    return true;
  } catch {
    return false;
  }
};

/** A PKCE verifier and its S256 challenge. */
export function pkce(): [verifier: string, challenge: string] {
  const verifier = base64url(randomBytes(32));
  return [verifier, base64url(createHash("sha256").update(verifier).digest())];
}

/** A fresh OAuth `state`: what ties the callback to its sign-in. */
export const state = () => base64url(randomBytes(32));

/** `key="value"` (or a bare token) from a `WWW-Authenticate: Bearer …` challenge. */
export function challengeParam(header: string, key: string): string | undefined {
  const trimmed = header.trim();
  const rest = trimmed.startsWith("Bearer") ? trimmed.slice(6) : trimmed.startsWith("bearer") ? trimmed.slice(6) : undefined;
  if (rest === undefined) return undefined;
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"') quoted = !quoted;
    else if (c === "\\" && quoted) i++;
    else if (c === "," && !quoted) {
      parts.push(rest.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(rest.slice(start));
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0 || p.slice(0, eq).trim().toLowerCase() !== key.toLowerCase()) continue;
    let v = p.slice(eq + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v.replaceAll('\\"', '"');
  }
  return undefined;
}

/** What a request with no credentials gets: whether it was a 401, and its `WWW-Authenticate`. */
async function knock(url: string, sse: boolean, net: Net): Promise<[boolean, string | undefined]> {
  let answer: Response;
  try {
    answer = sse
      ? await net.http(url, { headers: { accept: "text/event-stream" } })
      : await net.http(url, {
          method: "POST",
          headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "fleetd", version: net.version } },
          }),
        });
  } catch (e) {
    throw new Error(`${hostOf(url)} can't be reached: ${describe(e)}`);
  }
  await answer.body?.cancel().catch(() => {});
  const all = answer.headers.get("www-authenticate");
  // Several challenges arrive joined by commas: the Bearer one runs from its scheme on; other schemes' params after
  // it never match a key challengeParam looks for.
  const at = all?.search(/(^|,\s*)bearer(\s|$)/i) ?? -1;
  const header = all !== null && all !== undefined && at >= 0 ? all.slice(at).replace(/^,\s*/, "").trim() : undefined;
  return [answer.status === 401, header];
}

/** A JSON document at `url`, or undefined for anything but a 200 with a JSON object. */
async function jsonAt(url: string, net: Net): Promise<Record<string, unknown> | undefined> {
  if (!isSecure(url)) return undefined;
  try {
    const answer = await net.http(url, { headers: { accept: "application/json" } });
    if (!answer.ok) return undefined;
    const v = (await answer.json()) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `origin + "/.well-known/<name>" + path`, and without the path when it has one (RFC 8414 and 9728's order). */
function wellKnown(base: URL, name: string): string[] {
  const path = base.pathname.replace(/\/+$/, "");
  const out: string[] = [];
  if (path) out.push(`${base.origin}/.well-known/${name}${path}`);
  out.push(`${base.origin}/.well-known/${name}`);
  return out;
}

/** Whether the server at `url` asks for OAuth sign-in: a 401 with a Bearer challenge, or protected resource metadata. */
export async function offersSignIn(url: string, sse: boolean, net: Net): Promise<boolean> {
  try {
    const [unauthorized, challenge] = await knock(url, sse, net);
    if (!unauthorized) return false;
    return challenge !== undefined || (await resourceMetadata(url, undefined, net)) !== undefined;
  } catch {
    return false;
  }
}

async function resourceMetadata(url: string, advertised: string | undefined, net: Net) {
  if (advertised !== undefined) {
    const found = await jsonAt(advertised, net);
    if (found) return found;
  }
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    return undefined;
  }
  for (const candidate of wellKnown(base, "oauth-protected-resource")) {
    const found = await jsonAt(candidate, net);
    if (found) return found;
  }
  return undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
};

/** Where the MCP server at `url` signs in. An `sse` server is knocked on with a GET, as its stream opens. */
export async function discover(url: string, sse: boolean, net: Net): Promise<Discovered> {
  const host = hostOf(url);
  secure(url);
  const [unauthorized, challenge] = await knock(url, sse, net);
  const advertised = challenge !== undefined ? challengeParam(challenge, "resource_metadata") : undefined;
  const prm = await resourceMetadata(url, advertised, net);
  if (!unauthorized && !prm) {
    throw new Error(`${host} answers without asking anyone to sign in: if it takes a key, add it with one instead`);
  }
  const listedResource = str(prm?.resource);
  const resource = listedResource !== undefined && originOf(listedResource) !== undefined && originOf(listedResource) === originOf(url) ? listedResource : url;
  const listed = strings(prm?.scopes_supported) ?? [];
  const scopeRaw = (challenge !== undefined ? challengeParam(challenge, "scope") : undefined) ?? (listed.length > 0 ? listed.join(" ") : undefined);
  const scope = scopeRaw !== undefined && scopeRaw.trim() !== "" ? scopeRaw : undefined;
  // The resource names its authorization server; one without metadata is its own (MCP 2025-03-26).
  const named = str((prm?.authorization_servers as unknown[] | undefined)?.[0]);
  const issuer = named ?? new URL(url).origin;
  const legacy = named === undefined;
  const issuerUrl = secure(issuer);
  const candidates = [...wellKnown(issuerUrl, "oauth-authorization-server"), ...wellKnown(issuerUrl, "openid-configuration")];
  candidates.push(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  const deduped = candidates.filter((c, i) => i === 0 || c !== candidates[i - 1]);
  let meta: Record<string, unknown> | undefined;
  for (const c of deduped) {
    meta = await jsonAt(c, net);
    if (meta) break;
  }
  const base = issuer.replace(/\/+$/, "");
  let authorization: string | undefined;
  let token: string | undefined;
  let registration: string | undefined;
  let revocation: string | undefined;
  let authMethods: string[] = [];
  let pkceMethods: string[] | undefined;
  if (meta) {
    authorization = str(meta.authorization_endpoint);
    token = str(meta.token_endpoint);
    registration = str(meta.registration_endpoint);
    revocation = str(meta.revocation_endpoint);
    authMethods = strings(meta.token_endpoint_auth_methods_supported) ?? [];
    pkceMethods = strings(meta.code_challenge_methods_supported);
  } else if (legacy) {
    [authorization, token, registration] = [`${base}/authorize`, `${base}/token`, `${base}/register`];
  } else {
    throw new Error(`${hostOf(issuer)} publishes no sign-in details (no OAuth authorization server metadata)`);
  }
  if (pkceMethods && !pkceMethods.includes("S256")) {
    throw new Error(`${hostOf(issuer)} doesn't support PKCE (S256), which fleetd needs to sign in safely`);
  }
  const need = (v: string | undefined, what: string) => {
    if (v === undefined) throw new Error(`${hostOf(issuer)} names no ${what}`);
    secure(v);
    return v;
  };
  const optional = (v: string | undefined) => (v !== undefined && isSecure(v) ? v : undefined);
  return {
    resource,
    issuer,
    authorizationEndpoint: need(authorization, "sign-in page"),
    tokenEndpoint: need(token, "token endpoint"),
    ...(optional(registration) !== undefined ? { registrationEndpoint: optional(registration) } : {}),
    ...(optional(revocation) !== undefined ? { revocationEndpoint: optional(revocation) } : {}),
    ...(scope !== undefined ? { scope } : {}),
    authMethods,
  };
}

/** The service's own words for an OAuth refusal: its `error_description`, else its `error` as code, else the status. */
function said(status: number, body: Record<string, unknown>): [string | undefined, string] {
  const error = str(body.error) || undefined;
  const described = str(body.error_description)?.trim() || undefined;
  return [error, described ?? (error !== undefined ? `\`${error}\`` : `HTTP ${status}`)];
}

async function jsonBody(answer: Response): Promise<Record<string, unknown>> {
  try {
    const v = (await answer.json()) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Registers fleetd as a client of the service for `redirect` (RFC 7591), a public one unless the service insists. */
export async function register(d: Discovered, redirect: string, net: Net): Promise<Registered> {
  const at = d.registrationEndpoint;
  if (at === undefined) throw new Error("the service doesn't let apps register themselves");
  const body: Record<string, unknown> = {
    client_name: "fleetd",
    redirect_uris: [redirect],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  if (d.scope !== undefined) body.scope = d.scope;
  const host = hostOf(at);
  let answer: Response;
  try {
    answer = await net.http(at, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`${host} can't be reached to register fleetd: ${describe(e)}`);
  }
  const out = await jsonBody(answer);
  if (!answer.ok) throw new Error(`${host} wouldn't register fleetd as an app (${said(answer.status, out)[1]})`);
  const clientId = str(out.client_id);
  if (!clientId) throw new Error(`${host} registered fleetd but sent no client id`);
  const clientSecret = str(out.client_secret) || undefined;
  return {
    clientId,
    ...(clientSecret !== undefined
      ? { clientSecret, tokenAuth: out.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "client_secret_basic" }
      : {}),
  };
}

/** How to send a person's own client secret: the service's listed way, basic by default. */
export const tokenAuthFor = (methods: string[]) =>
  methods.length > 0 && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")
    ? "client_secret_post"
    : "client_secret_basic";

/** The sign-in page's address, with PKCE, the state and the resource. */
export function authorizeUrl(endpoint: string, clientId: string, redirect: string, challenge: string, st: string, scope: string | undefined, resource: string): string {
  const url = secure(endpoint);
  const q = url.searchParams;
  q.append("response_type", "code");
  q.append("client_id", clientId);
  q.append("redirect_uri", redirect);
  q.append("code_challenge", challenge);
  q.append("code_challenge_method", "S256");
  q.append("state", st);
  q.append("resource", resource);
  if (scope !== undefined) q.append("scope", scope);
  return url.toString();
}

/** RFC 6749 2.3.1: each part form-encoded before the basic pair. */
const formEncode = (s: string) => new URLSearchParams({ x: s }).toString().slice(2);

function withClient(client: Client, fields: [string, string][], headers: Headers): void {
  if (client.secret !== undefined && client.auth === "client_secret_post") {
    fields.push(["client_id", client.id], ["client_secret", client.secret]);
  } else if (client.secret !== undefined) {
    headers.set("authorization", `Basic ${Buffer.from(`${formEncode(client.id)}:${formEncode(client.secret)}`).toString("base64")}`);
  } else {
    fields.push(["client_id", client.id]);
  }
}

/** One call to the token endpoint: `form` is the grant's fields; the client and the resource are added. */
export async function token(endpoint: string, client: Client, resource: string, form: [string, string][], net: Net): Promise<Tokens> {
  try {
    secure(endpoint);
  } catch (e) {
    throw new TokenError("failed", (e as Error).message);
  }
  const host = hostOf(endpoint);
  const fields: [string, string][] = [...form, ["resource", resource]];
  const headers = new Headers({ accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
  withClient(client, fields, headers);
  let answer: Response;
  try {
    answer = await net.http(endpoint, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
  } catch (e) {
    throw new TokenError("failed", `${host} can't be reached: ${describe(e)}`);
  }
  const body = await jsonBody(answer);
  if (!answer.ok || "error" in body) {
    const [error, words] = said(answer.status, body);
    const refused = error === "invalid_grant" || error === "invalid_client" || error === "unauthorized_client";
    throw refused ? new TokenError("refused", words) : new TokenError("failed", `${host} answered ${words}`);
  }
  const kind = str(body.token_type);
  if (kind !== undefined && kind.toLowerCase() !== "bearer") throw new TokenError("failed", `${host} sent a ${kind} token; MCP takes a Bearer one`);
  const access = str(body.access_token) || undefined;
  if (access === undefined) throw new TokenError("failed", `${host} sent no access token`);
  // A header value can't hold a line break.
  if (/[\r\n]/.test(access)) throw new TokenError("failed", `${host} sent a token that isn't a header value`);
  const refresh = str(body.refresh_token) || undefined;
  const raw = body.expires_in;
  const n = typeof raw === "number" && Number.isInteger(raw) ? raw : typeof raw === "string" && /^[+-]?\d+$/.test(raw) ? Number(raw) : undefined;
  return { access, ...(refresh !== undefined ? { refresh } : {}), ...(n !== undefined && n > 0 ? { expiresIn: n } : {}) };
}

/** Revokes `token` where the service offers it (RFC 7009); whether it said yes. */
export async function revoke(endpoint: string, client: Client, tok: string, hint: string, net: Net): Promise<boolean> {
  if (!isSecure(endpoint)) return false;
  const fields: [string, string][] = [
    ["token", tok],
    ["token_type_hint", hint],
  ];
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  withClient(client, fields, headers);
  try {
    const answer = await net.http(endpoint, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
    await answer.body?.cancel().catch(() => {});
    return answer.ok;
  } catch {
    return false;
  }
}
