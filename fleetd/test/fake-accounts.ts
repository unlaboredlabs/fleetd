// A stand-in for fleetd cloud's accounts service and the WorkOS sign-in in front of it, for the apps' Sign in tests:
// the browser's round trip (`authorize`, what WorkOS's page would redirect to), the one call an app makes
// (POST /v1/app/sign-in, Accounts.json), sign-out, and each team's POST /pair on an origin of its own. It checks what
// the real ones do: the PKCE verifier against the challenge, a code used once, a pairing code used once.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ACCOUNTS_SIGN_IN_PATH,
  ACCOUNTS_SIGN_OUT_PATH,
  type AccountsFailure,
  type AccountsSignInInput,
  type AccountsSignInOutput,
} from "../../app/desktop/src/shared/contracts/contracts.ts";

export type FakeTeamOptions = {
  /** Its /pair refuses every code, as a hub whose code ran out does. */
  refusePairing?: boolean;
};

type Team = { id: string; name: string; url: string; server: Server; codes: Set<string>; refuse: boolean };

/** A key one of the teams' /pair handed out. */
export type FakeKey = { team: string; deviceName: string; key: string };

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const pairingCode = (): string => {
  const bytes = randomBytes(8);
  const c = [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    req.on("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
  });

const send = (res: ServerResponse, status: number, body?: unknown): void => {
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

const fail = (res: ServerResponse, status: number, failure: AccountsFailure): void => send(res, status, failure);

const str = (o: unknown, key: string): string | undefined => {
  const v = typeof o === "object" && o !== null ? (o as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : undefined;
};

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`)));

export class FakeAccounts {
  /** The WorkOS client id the authorize page takes. */
  readonly clientId = "client_fake";
  /** Every key a team's /pair made, in order. */
  readonly keys: FakeKey[] = [];
  /** Sessions signed in and not signed out. */
  readonly sessions = new Set<string>();
  /** Sessions sign-out ended. */
  readonly ended: string[] = [];
  /** Every sign-in body the service got. */
  readonly signIns: AccountsSignInInput[] = [];
  /** The next sign-in's answer instead of the real one: a refusal such as a 429. */
  refuseNext: { status: number; failure: AccountsFailure } | null = null;
  #server: Server | null = null;
  #origin = "";
  readonly #people = new Map<string, string[]>();
  readonly #teams = new Map<string, Team>();
  readonly #codes = new Map<string, { email: string; challenge: string; redirectUri: string; used: boolean }>();

  /** The accounts service's origin, once started. */
  get url(): string {
    return this.#origin;
  }

  /** WorkOS's authorize page, as the app is configured with it. */
  get authorizeUrl(): string {
    return `${this.#origin}/user_management/authorize`;
  }

  /** A team with its own /pair, and the people in it. A person signing in with no team gets one made. */
  async team(name: string, emails: string[], options: FakeTeamOptions = {}): Promise<string> {
    const server = createServer((req, res) => void this.#pair(name, req, res));
    const url = await listen(server);
    this.#teams.set(name, { id: `team_${name}`, name, url, server, codes: new Set(), refuse: options.refusePairing === true });
    for (const email of emails) this.#people.set(email, [...(this.#people.get(email) ?? []), name]);
    return url;
  }

  async start(): Promise<this> {
    const server = createServer((req, res) => void this.#accounts(req, res));
    this.#server = server;
    this.#origin = await listen(server);
    return this;
  }

  async stop(): Promise<void> {
    const close = (s: Server) =>
      new Promise<void>((resolve) => {
        s.close(() => resolve());
        s.closeAllConnections();
      });
    await Promise.all([...(this.#server === null ? [] : [this.#server]), ...[...this.#teams.values()].map((t) => t.server)].map(close));
  }

  /**
   * The browser's round trip: what WorkOS's page redirects to once `email` signed in on the authorize URL the app
   * opened. `deny` is the person pressing cancel there.
   */
  authorize(authorizeUrl: string, email: string, deny = false): string {
    const page = new URL(authorizeUrl);
    const q = page.searchParams;
    const redirect = q.get("redirect_uri");
    if (`${page.origin}${page.pathname}` !== this.authorizeUrl) throw new Error(`not the authorize page: ${page.origin}${page.pathname}`);
    if (q.get("client_id") !== this.clientId) throw new Error("wrong client id");
    if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || q.get("provider") !== "authkit") throw new Error("not a PKCE authorize");
    const challenge = q.get("code_challenge");
    if (redirect === null || challenge === null) throw new Error("no redirect_uri or code_challenge");
    const back = new URL(redirect);
    const state = q.get("state");
    if (state !== null) back.searchParams.set("state", state);
    if (deny) {
      back.searchParams.set("error", "access_denied");
      return back.toString();
    }
    const code = randomBytes(12).toString("hex");
    this.#codes.set(code, { email, challenge, redirectUri: redirect, used: false });
    back.searchParams.set("code", code);
    return back.toString();
  }

  /** The teams `email` is in, by name. */
  teamsOf(email: string): string[] {
    return this.#people.get(email) ?? [];
  }

  async #accounts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method !== "POST") return fail(res, 404, { code: "not_found", message: "Nothing here." });
    const body = await readBody(req);
    if (path === ACCOUNTS_SIGN_OUT_PATH) {
      const id = str(body, "sessionId");
      if (id !== undefined && this.sessions.delete(id)) this.ended.push(id);
      return send(res, 204);
    }
    if (path !== ACCOUNTS_SIGN_IN_PATH) return fail(res, 404, { code: "not_found", message: "Nothing here." });
    const input = {
      code: str(body, "code"),
      codeVerifier: str(body, "codeVerifier"),
      redirectUri: str(body, "redirectUri"),
      deviceName: str(body, "deviceName"),
    };
    if (input.code === undefined || input.codeVerifier === undefined || input.redirectUri === undefined || input.deviceName === undefined) {
      return fail(res, 400, { code: "invalid", message: "A sign-in needs code, codeVerifier, redirectUri and deviceName." });
    }
    this.signIns.push(input as AccountsSignInInput);
    if (this.refuseNext !== null) {
      const { status, failure } = this.refuseNext;
      this.refuseNext = null;
      return fail(res, status, failure);
    }
    const grant = this.#codes.get(input.code);
    const verified = createHash("sha256").update(input.codeVerifier).digest("base64url");
    if (grant === undefined || grant.used || grant.challenge !== verified || grant.redirectUri !== input.redirectUri) {
      return fail(res, 401, { code: "signin_refused", message: "That sign-in wasn't accepted.", fix: "Sign in again." });
    }
    grant.used = true;
    if (this.teamsOf(grant.email).length === 0) await this.team(grant.email.split("@")[0]!.replace(/[^a-z0-9]/gu, "") || "team", [grant.email]);
    const sessionId = `session_${randomBytes(8).toString("hex")}`;
    this.sessions.add(sessionId);
    const answer: AccountsSignInOutput = {
      email: grant.email,
      sessionId,
      teams: this.teamsOf(grant.email).map((name) => {
        const team = this.#teams.get(name)!;
        const code = pairingCode();
        team.codes.add(code);
        return { id: team.id, name: team.name, url: team.url, pairingCode: code };
      }),
    };
    send(res, 200, answer);
  }

  async #pair(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const team = this.#teams.get(name)!;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method !== "POST" || path !== "/pair") return fail(res, 404, { code: "not_found", message: "Nothing here." });
    const body = await readBody(req);
    const code = str(body, "code");
    const deviceName = str(body, "deviceName") ?? "";
    if (team.refuse || code === undefined || !team.codes.delete(code)) {
      return fail(res, 401, { code: "pair_code_invalid", message: "That pairing code is unknown or was already used." });
    }
    const key = `fld_fake_${randomBytes(12).toString("hex")}`;
    this.keys.push({ team: name, deviceName, key });
    send(res, 200, { key, hubUrl: team.url, hubName: name });
  }
}
