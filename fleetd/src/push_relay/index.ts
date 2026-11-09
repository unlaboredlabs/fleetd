// `fleetd push-relay` (crates/fleetd/src/push_relay/mod.rs, apns.rs, fcm.rs): the push relay (D218). A hub posts
// each sealed notification here; the relay forwards it to APNs or FCM with the publisher's credentials, which only it
// holds. It reads no notification: it sees a token, ciphertext and an opaque collapse key, keeps none of them and logs
// none. Limits: a ciphertext of at most CIPHERTEXT_MAX, PER_TOKEN_PER_MIN pushes a minute to one token and
// PER_SOURCE_PER_MIN from one address. A token APNs or FCM no longer knows is answered `dead`; an answer that means the
// relay's own setup is wrong is `failed`, saying what to fix. With FLEETD_PUSH_RELAY_KEY_FILE set, it takes only
// requests that carry that key as a bearer token.
import { createHash, createPrivateKey, type KeyObject, sign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import { isIP } from "node:net";
import { ioMessage } from "../cli/common.ts";

export const CIPHERTEXT_MAX = 3500;
export const TOKEN_MAX = 4096;
export const PER_TOKEN_PER_MIN = 60;
export const PER_SOURCE_PER_MIN = 600;
export const DEFAULT_LISTEN = "127.0.0.1:4795";
const BODY_MAX = 8 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;

export type RelayPush = { platform: "ios" | "android"; token: string; ciphertext: string; collapseKey?: string };
export type Delivery = { kind: "sent" } | { kind: "dead" } | { kind: "failed"; why: string };

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");
const unixNow = () => Math.floor(Date.now() / 1000);

/** A file an environment variable names, or undefined when it's unset; throws why it can't be read. */
function readNamed(name: string): string | undefined {
  const path = process.env[name]?.trim();
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${name}: can't read ${path}: ${ioMessage(error)}`);
  }
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** The DER of a PEM's body, or undefined when it isn't base64. */
function pemDer(pem: string): Buffer | undefined {
  const body = pem
    .split("\n")
    .filter((l) => !l.startsWith("-----"))
    .map((l) => l.trim())
    .join("");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0) return undefined;
  return Buffer.from(body, "base64");
}

function pkcs8(der: Buffer): KeyObject | undefined {
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    return undefined;
  }
}

// ---- APNs ----

export const APNS_PRODUCTION = "https://api.push.apple.com";
export const APNS_SANDBOX = "https://api.sandbox.push.apple.com";
const JWT_FOR_MS = 40 * 60_000;
export const FALLBACK_TITLE = "fleetd";
export const FALLBACK_BODY = "New activity";

type Answer = { status: number; body: string };

/** One POST: over HTTP/2 for an https URL (APNs takes nothing else), else fetch (a test's server). */
async function post(url: string, headers: Record<string, string>, body: string): Promise<Answer> {
  const u = new URL(url);
  if (u.protocol !== "https:") {
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    return { status: res.status, body: await res.text() };
  }
  return new Promise((resolve, reject) => {
    let session: ClientHttp2Session;
    try {
      session = connect(u.origin);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      session.destroy();
      reject(new Error("timed out"));
    }, UPSTREAM_TIMEOUT_MS);
    session.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    const req = session.request({ ":method": "POST", ":path": u.pathname + u.search, ...headers });
    let status = 0;
    let text = "";
    req.on("response", (h) => void (status = Number(h[":status"] ?? 0)));
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => void (text += chunk));
    req.on("end", () => {
      clearTimeout(timer);
      session.close();
      resolve({ status, body: text });
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      session.destroy();
      reject(error);
    });
    req.end(body);
  });
}

const reasonOf = (body: string) => {
  try {
    const r = JSON.parse(body)?.reason;
    return typeof r === "string" ? r : "";
  } catch {
    return "";
  }
};

export class Apns {
  private jwtCache: [number, string] | undefined;
  /** A push has gone through since the relay started: its setup is right. */
  private proven = false;
  readonly url: string;

  private constructor(
    private readonly key: KeyObject,
    private readonly keyId: string,
    private readonly teamId: string,
    private readonly topic: string,
    url: string,
  ) {
    this.url = url.replace(/\/+$/, "");
  }

  static create(pem: string, keyId: string, teamId: string, topic: string, url: string): Apns {
    const der = pemDer(pem);
    if (der === undefined) throw new Error("the APNs key isn't a .p8 file");
    const key = pkcs8(der);
    if (key === undefined || key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("the APNs key isn't an EC key Apple made");
    }
    return new Apns(key, keyId, teamId, topic, url);
  }

  static fromEnv(): Apns | undefined {
    const pem = readNamed("FLEETD_APNS_KEY_FILE");
    if (pem === undefined) return undefined;
    const sandbox = process.env.FLEETD_APNS_SANDBOX?.trim() === "1";
    return Apns.create(
      pem,
      required("FLEETD_APNS_KEY_ID"),
      required("FLEETD_APNS_TEAM_ID"),
      required("FLEETD_APNS_TOPIC"),
      sandbox ? APNS_SANDBOX : APNS_PRODUCTION,
    );
  }

  private jwt(): string {
    if (this.jwtCache && Date.now() - this.jwtCache[0] < JWT_FOR_MS) return this.jwtCache[1];
    const signed = `${b64url(JSON.stringify({ alg: "ES256", kid: this.keyId }))}.${b64url(JSON.stringify({ iss: this.teamId, iat: unixNow() }))}`;
    const signature = sign("sha256", Buffer.from(signed), { key: this.key, dsaEncoding: "ieee-p1363" });
    const jwt = `${signed}.${b64url(signature)}`;
    this.jwtCache = [Date.now(), jwt];
    return jwt;
  }

  static body(push: RelayPush) {
    return {
      aps: { alert: { title: FALLBACK_TITLE, body: FALLBACK_BODY }, "mutable-content": 1, sound: "default" },
      c: push.ciphertext,
    };
  }

  async send(push: RelayPush): Promise<Delivery> {
    let jwt: string;
    try {
      jwt = this.jwt();
    } catch {
      return { kind: "failed", why: "the APNs key couldn't sign" };
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${jwt}`,
      "apns-topic": this.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    };
    if (push.collapseKey !== undefined) headers["apns-collapse-id"] = push.collapseKey;
    let answer: Answer;
    try {
      answer = await post(`${this.url}/3/device/${push.token}`, headers, JSON.stringify(Apns.body(push)));
    } catch (error) {
      // Without the URL: it holds the token.
      return { kind: "failed", why: `APNs can't be reached: ${(error as Error).message.replaceAll(push.token, "<token>")}` };
    }
    if (answer.status === 200) {
      this.proven = true;
      return { kind: "sent" };
    }
    const reason = reasonOf(answer.body);
    const environment = this.url === APNS_SANDBOX ? "sandbox" : "production";
    const s = answer.status;
    if (s === 410) return { kind: "dead" };
    if (s === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) {
      if (this.proven) return { kind: "dead" };
      return {
        kind: "failed",
        why: `APNs answered ${reason} and no push has gone through yet: the relay sends to ${environment} (FLEETD_APNS_SANDBOX=1 for development builds, unset for TestFlight and release builds) as ${this.topic} (FLEETD_APNS_TOPIC must be the app's bundle id)`,
      };
    }
    if ((s === 400 && ["BadTopic", "TopicDisallowed", "MissingTopic"].includes(reason)) || (s === 403 && reason === "TopicDisallowed")) {
      return {
        kind: "failed",
        why: `APNs refused the topic ${this.topic} (${reason}): FLEETD_APNS_TOPIC must be the app's bundle id, and the .p8 key must be from the same team`,
      };
    }
    if (s === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) {
      this.jwtCache = undefined;
      return {
        kind: "failed",
        why: `APNs refused the provider token (${reason}): FLEETD_APNS_KEY_ID and FLEETD_APNS_TEAM_ID must be the .p8 key's`,
      };
    }
    return { kind: "failed", why: `APNs answered ${s} ${reason}` };
  }
}

// ---- FCM ----

export const FCM_API = "https://fcm.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/** reqwest's StatusCode display: `401 Unauthorized`. */
const statusText = (n: number) => {
  const names: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 503: "Service Unavailable" };
  return names[n] === undefined ? String(n) : `${n} ${names[n]}`;
};

export class Fcm {
  private access: [number, string] | undefined;
  readonly url: string;

  private constructor(
    private readonly key: KeyObject,
    private readonly clientEmail: string,
    readonly projectId: string,
    private readonly tokenUri: string,
    url: string,
  ) {
    this.url = url.replace(/\/+$/, "");
  }

  static create(account: string, url: string): Fcm {
    let json: any;
    try {
      json = JSON.parse(account);
    } catch {
      throw new Error("the FCM service account isn't JSON");
    }
    const text = (k: string) => {
      const v = json?.[k];
      if (typeof v !== "string" || v === "") throw new Error(`the FCM service account has no ${k}`);
      return v;
    };
    const der = pemDer(text("private_key"));
    if (der === undefined) throw new Error("the FCM service account's private_key isn't PEM");
    const key = pkcs8(der);
    if (key === undefined || key.asymmetricKeyType !== "rsa") {
      throw new Error("the FCM service account's private_key isn't an RSA key Google made");
    }
    let tokenUri: string;
    try {
      tokenUri = text("token_uri");
    } catch {
      tokenUri = "https://oauth2.googleapis.com/token";
    }
    return new Fcm(key, text("client_email"), text("project_id"), tokenUri, url);
  }

  static fromEnv(): Fcm | undefined {
    const account = readNamed("FLEETD_FCM_SERVICE_ACCOUNT");
    return account === undefined ? undefined : Fcm.create(account, FCM_API);
  }

  private async accessToken(): Promise<string> {
    if (this.access && Date.now() < this.access[0]) return this.access[1];
    const now = unixNow();
    const signed = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({ iss: this.clientEmail, scope: SCOPE, aud: this.tokenUri, iat: now, exp: now + 3600 }),
    )}`;
    let signature: Buffer;
    try {
      signature = sign("sha256", Buffer.from(signed), this.key);
    } catch {
      throw new Error("the FCM service account couldn't sign");
    }
    let res: Response;
    try {
      res = await fetch(this.tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${signed}.${b64url(signature)}` }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Google's token endpoint can't be reached: ${(error as Error).message}`);
    }
    const body: any = await res.json().catch(() => ({}));
    if (typeof body?.access_token !== "string" || !res.ok) throw new Error(`Google refused the FCM service account (${statusText(res.status)})`);
    const lasts = Math.max(0, (typeof body.expires_in === "number" ? body.expires_in : 3600) - 60);
    this.access = [Date.now() + lasts * 1000, body.access_token];
    return body.access_token;
  }

  static body(push: RelayPush) {
    const android: Record<string, string> = { priority: "high" };
    if (push.collapseKey !== undefined) android.collapse_key = push.collapseKey;
    return { message: { token: push.token, data: { c: push.ciphertext }, android } };
  }

  async send(push: RelayPush): Promise<Delivery> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (error) {
      return { kind: "failed", why: (error as Error).message };
    }
    let res: Response;
    try {
      res = await fetch(`${this.url}/v1/projects/${this.projectId}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(Fcm.body(push)),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      return { kind: "failed", why: `FCM can't be reached: ${(error as Error).message}` };
    }
    if (res.status === 200) return { kind: "sent" };
    const body: any = await res.json().catch(() => ({}));
    const details: any[] = Array.isArray(body?.error?.details) ? body.error.details : [];
    const code = details.map((d) => d?.errorCode).find((c) => typeof c === "string");
    const state = typeof body?.error?.status === "string" ? body.error.status : "";
    if (res.status === 401) this.access = undefined;
    if (code === "UNREGISTERED") return { kind: "dead" };
    if (code === "SENDER_ID_MISMATCH") {
      return {
        kind: "failed",
        why: `FCM answered SENDER_ID_MISMATCH: the app's tokens are another Firebase project's than ${this.projectId}; FLEETD_FCM_SERVICE_ACCOUNT must be a key from the app's own project`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        kind: "failed",
        why: `FCM refused the service account (${res.status} ${state}): it must be from project ${this.projectId}, with the Firebase Cloud Messaging API on and a role that may send`,
      };
    }
    return { kind: "failed", why: `FCM answered ${res.status} ${state}` };
  }
}

// ---- the relay ----

/** Pushes a minute per key (a token, an address), counted by its sha256. */
class Window {
  private readonly counts = new Map<string, [number, number]>();
  constructor(private readonly perMin: number) {}
  allow(what: string, now = Date.now()): boolean {
    const key = createHash("sha256").update(what).digest("hex");
    if (this.counts.size > 10_000) {
      for (const [k, [start]] of this.counts) if (now - start >= 60_000) this.counts.delete(k);
    }
    let entry = this.counts.get(key);
    if (!entry || now - entry[0] >= 60_000) entry = [now, 0];
    entry[1]++;
    this.counts.set(key, entry);
    return entry[1] <= this.perMin;
  }
}

export class Relay {
  key: string | undefined;
  private readonly tokens = new Window(PER_TOKEN_PER_MIN);
  private sources: Window = new Window(PER_SOURCE_PER_MIN);

  constructor(
    readonly apns: Apns | undefined,
    readonly fcm: Fcm | undefined,
  ) {}

  static fromEnv(): Relay {
    const relay = new Relay(Apns.fromEnv(), Fcm.fromEnv());
    const key = readNamed("FLEETD_PUSH_RELAY_KEY_FILE");
    if (key !== undefined) {
      if (key.trim() === "") throw new Error("FLEETD_PUSH_RELAY_KEY_FILE names an empty file");
      relay.key = key.trim();
    }
    return relay;
  }

  /** For tests: the per-address limit. */
  withSourceLimit(perMin: number): this {
    this.sources = new Window(perMin);
    return this;
  }

  admits(headers: Headers): boolean {
    if (this.key === undefined) return true;
    const auth = headers.get("authorization") ?? "";
    const sent = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const a = createHash("sha256").update(sent.trim()).digest();
    const b = createHash("sha256").update(this.key).digest();
    return timingSafeEqual(a, b);
  }

  allowToken = (token: string) => this.tokens.allow(token);
  allowSource = (source: string) => this.sources.allow(source);
}

/** Who sent it: the peer, or behind a proxy on this machine the last X-Forwarded-For entry. */
export function source(peer: string | undefined, headers: Headers): string {
  if (peer === undefined) return "0.0.0.0";
  const loopback = /^127\./.test(peer) || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (!loopback) return peer;
  const last = (headers.get("x-forwarded-for") ?? "").split(",").pop()?.trim();
  return last && isIP(last) ? last : peer;
}

const answer = (status: number, body: object) => Response.json(body, { status });
const failed = (status: number, error: string) => answer(status, { status: "failed", error });

function plausible(push: RelayPush): boolean {
  return (
    push.token !== "" &&
    push.token.length <= TOKEN_MAX &&
    /^[A-Za-z0-9_:-]+$/.test(push.token) &&
    push.ciphertext !== "" &&
    /^[A-Za-z0-9+/=]+$/.test(push.ciphertext) &&
    (push.collapseKey === undefined || (push.collapseKey !== "" && push.collapseKey.length <= 64 && /^[A-Za-z0-9]+$/.test(push.collapseKey)))
  );
}

/** A body as `RelayPush`, or undefined when it isn't one. */
function asPush(body: unknown): RelayPush | undefined {
  const b = body as Record<string, unknown> | null;
  if (b === null || typeof b !== "object" || Array.isArray(b)) return undefined;
  if (b.platform !== "ios" && b.platform !== "android") return undefined;
  if (typeof b.token !== "string" || typeof b.ciphertext !== "string") return undefined;
  if (b.collapseKey !== undefined && b.collapseKey !== null && typeof b.collapseKey !== "string") return undefined;
  return {
    platform: b.platform,
    token: b.token,
    ciphertext: b.ciphertext,
    ...(typeof b.collapseKey === "string" ? { collapseKey: b.collapseKey } : {}),
  };
}

/** `POST /v1/push`. */
export async function handlePush(relay: Relay, req: Request, peer: string | undefined): Promise<Response> {
  if (!relay.allowSource(source(peer, req.headers))) return failed(429, "too many pushes from this address");
  if (!relay.admits(req.headers)) {
    return failed(401, "this relay takes a key: set it on the hub with `fleetd push-relay set <url> --relay-key-file <path>`");
  }
  const raw = await req.arrayBuffer();
  if (raw.byteLength > BODY_MAX) return new Response("length limit exceeded", { status: 413 });
  let push: RelayPush | undefined;
  try {
    push = asPush(JSON.parse(new TextDecoder().decode(raw)));
  } catch {}
  if (push === undefined) return failed(400, "not a push");
  if (push.ciphertext.length > CIPHERTEXT_MAX) return failed(413, "ciphertext too long");
  if (!plausible(push)) return failed(400, "not a push");
  if (!relay.allowToken(push.token)) return failed(429, "too many pushes to this device");
  let delivery: Delivery;
  if (push.platform === "ios") {
    if (!relay.apns) return failed(503, "this relay sends no APNs");
    delivery = await relay.apns.send(push);
  } else {
    if (!relay.fcm) return failed(503, "this relay sends no FCM");
    delivery = await relay.fcm.send(push);
  }
  if (delivery.kind === "sent") return answer(200, { status: "sent" });
  if (delivery.kind === "dead") return answer(200, { status: "dead" });
  console.warn(`push not delivered (${push.platform}): ${delivery.why}`);
  return failed(502, delivery.why);
}

/** The relay's routes: `GET /` (health) and `POST /v1/push`. */
export function router(relay: Relay) {
  return async (req: Request, server: { requestIP(r: Request): { address: string } | null }): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (path === "/") {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 });
      return Response.json({ ok: true, apns: relay.apns !== undefined, fcm: relay.fcm !== undefined });
    }
    if (path === "/v1/push") {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      return handlePush(relay, req, server.requestIP(req)?.address);
    }
    return new Response(null, { status: 404 });
  };
}

/** Serves the relay on `listen` until SIGINT or SIGTERM. Throws why it can't. */
export async function serve(host: string, port: number, relay: Relay): Promise<void> {
  if (!relay.apns && !relay.fcm) {
    throw new Error("no credentials: set FLEETD_APNS_KEY_FILE (with _KEY_ID, _TEAM_ID, _TOPIC) or FLEETD_FCM_SERVICE_ACCOUNT");
  }
  let server: ReturnType<typeof Bun.serve>;
  try {
    const route = router(relay);
    server = Bun.serve({ hostname: host, port, maxRequestBodySize: BODY_MAX * 4, fetch: (req, s) => route(req, s) });
  } catch (error) {
    throw new Error(`can't listen on ${host.includes(":") ? `[${host}]` : host}:${port}: ${(error as Error).message}`);
  }
  const shown = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  process.stdout.write(
    `push relay on http://${shown} (APNs ${relay.apns ? "on" : "off"}, FCM ${relay.fcm ? "on" : "off"}, ${relay.key ? "key required" : "no key"})\n`,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.stop();
}
