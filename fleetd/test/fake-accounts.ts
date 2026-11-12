// A stand-in for fleetd cloud's accounts service and the WorkOS sign-in in front of it, for the apps' Sign in tests:
// the browser's round trip (`authorize`, what WorkOS's page would redirect to), the one call an app makes
// (POST /v1/app/sign-in, Accounts.json), sign-out, and each team's POST /pair on an origin of its own. It checks what
// the real ones do: the PKCE verifier against the challenge, a code used once, a pairing code used once. Each team's
// origin also serves its invites by email (ACCOUNTS_INVITES_PATH) to the keys its /pair made, refusing as the service
// does: a member's key, an admin naming an owner, not an email, an email already on the team or invited, the team at
// its limit of people. The email WorkOS would send is a line in `sent`. An open invite joins nothing at sign-in: the
// answer lists it apart, with its inviter's email and a one-use accept value, and only POST ACCOUNTS_ACCEPT_PATH with
// that value makes the person one of the team (decision hosted.invites-need-accept). A person with no team and an
// invitation pending gets no team of their own made.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ACCOUNTS_ACCEPT_PATH,
  ACCOUNTS_INVITES_PATH,
  ACCOUNTS_SIGN_IN_PATH,
  ACCOUNTS_SIGN_OUT_PATH,
  type AccountsFailure,
  type AccountsInvitation,
  type AccountsInvite,
  type AccountsSignInInput,
  type AccountsSignInOutput,
  type HubRole,
} from "../../app/desktop/src/shared/contracts/contracts.ts";

export type FakeTeamOptions = {
  /** Its /pair refuses every code, as a hub whose code ran out does. */
  refusePairing?: boolean;
  /** Each person's role by email; absent: the first is the owner, the rest members. */
  roles?: Record<string, HubRole>;
  /** People and open invites together never go past this (ops' per-team limit). Absent: 50. */
  peopleLimit?: number;
};

type Team = {
  id: string;
  name: string;
  url: string;
  server: Server;
  /** Each open pairing code, and whose. */
  codes: Map<string, string>;
  refuse: boolean;
  roles: Map<string, HubRole>;
  invites: AccountsInvite[];
  /** Who sent each invite, by its id. */
  invitedBy: Map<string, string>;
  limit: number;
};

/** A key one of the teams' /pair handed out. */
export type FakeKey = { team: string; deviceName: string; key: string; email: string };

/** An invitation email WorkOS would have sent. */
export type FakeInviteEmail = { team: string; email: string; role: HubRole };

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

// Crockford base32 without I L O U, as a hub mints them (app/desktop/src/shared/pairing.ts normalizeCode).
const CODE_CHARS = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
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
  /** Every invitation email sent, in order. */
  readonly sent: FakeInviteEmail[] = [];
  /** Each invitation joined through the accept call, as `<team> <email>`, in order. */
  readonly accepted: string[] = [];
  /** The time invites are made and run out by, epoch ms. */
  now: () => number = () => Date.now();
  #server: Server | null = null;
  #origin = "";
  readonly #people = new Map<string, string[]>();
  readonly #teams = new Map<string, Team>();
  readonly #codes = new Map<string, { email: string; challenge: string; redirectUri: string; used: boolean }>();
  /** Each accept value a sign-in answered: its team, invite and person; gone once used. */
  readonly #accepts = new Map<string, { team: string; inviteId: string; email: string }>();

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
    const server = createServer((req, res) => void this.#team(name, req, res));
    const url = await listen(server);
    const roles = new Map(emails.map((email, i) => [email, options.roles?.[email] ?? (i === 0 ? "owner" : "member")] as const));
    this.#teams.set(name, {
      id: `team_${name}`,
      name,
      url,
      server,
      codes: new Map(),
      refuse: options.refusePairing === true,
      roles,
      invites: [],
      invitedBy: new Map(),
      limit: options.peopleLimit ?? 50,
    });
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

  /** An invite to team `name` for `email` from `by`, as an owner's POST would make it, with no email sent. */
  invite(name: string, email: string, by: string, role: HubRole = "member"): AccountsInvite {
    const team = this.#teams.get(name);
    if (team === undefined) throw new Error(`no team ${name}`);
    const now = this.now();
    const invite: AccountsInvite = {
      inviteId: `inv_${randomBytes(5).toString("hex")}`,
      email,
      role,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
    };
    team.invites.push(invite);
    team.invitedBy.set(invite.inviteId, by);
    return invite;
  }

  /** The open invites for `email` across the teams, each with a fresh accept value. */
  #invitationsOf(email: string): AccountsInvitation[] {
    const now = this.now();
    return [...this.#teams.values()].flatMap((team) =>
      team.invites
        .filter((i) => i.email === email && Date.parse(i.expiresAt) > now)
        .map((i) => {
          const accept = randomBytes(18).toString("base64url");
          this.#accepts.set(accept, { team: team.name, inviteId: i.inviteId, email });
          return { name: team.name, invitedBy: team.invitedBy.get(i.inviteId) ?? "", role: i.role, accept };
        }),
    );
  }

  /** A pairing code for `email` on `team`, as an answer's team entry. */
  #entry(team: Team, email: string): AccountsSignInOutput["teams"][number] {
    const code = pairingCode();
    team.codes.set(code, email);
    return { id: team.id, name: team.name, url: team.url, pairingCode: code };
  }

  /** A team's open invites by email, newest first. */
  invitesOf(name: string): AccountsInvite[] {
    const now = this.now();
    return (this.#teams.get(name)?.invites ?? []).filter((i) => Date.parse(i.expiresAt) > now);
  }

  /** A key for `email` on team `name`, as its /pair would make one at sign-in, for tests that start signed in. */
  keyFor(name: string, email: string, deviceName = "test"): string {
    const key = `fld_fake_${randomBytes(12).toString("hex")}`;
    this.keys.push({ team: name, deviceName, key, email });
    return key;
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
    if (path === ACCOUNTS_ACCEPT_PATH) return this.#accept(body, res);
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
    const invitations = this.#invitationsOf(grant.email);
    if (this.teamsOf(grant.email).length === 0 && invitations.length === 0) {
      await this.team(grant.email.split("@")[0]!.replace(/[^a-z0-9]/gu, "") || "team", [grant.email]);
    }
    const sessionId = `session_${randomBytes(8).toString("hex")}`;
    this.sessions.add(sessionId);
    const answer: AccountsSignInOutput = {
      email: grant.email,
      sessionId,
      teams: this.teamsOf(grant.email).map((name) => this.#entry(this.#teams.get(name)!, grant.email)),
      ...(invitations.length === 0 ? {} : { invitations }),
    };
    send(res, 200, answer);
  }

  /** POST ACCOUNTS_ACCEPT_PATH: the invitation joined, once, and the team answered with a pairing code. */
  #accept(body: unknown, res: ServerResponse): void {
    const value = str(body, "accept") ?? "";
    const held = this.#accepts.get(value);
    this.#accepts.delete(value);
    const team = held === undefined ? undefined : this.#teams.get(held.team);
    const invite = team?.invites.find((i) => i.inviteId === held?.inviteId && Date.parse(i.expiresAt) > this.now());
    if (held === undefined || team === undefined || invite === undefined) {
      return fail(res, 401, { code: "accept_refused", message: "That invitation can't be joined any more.", fix: "Sign in again to see your invitations." });
    }
    // Every accept value of the same invite goes with it.
    for (const [k, v] of this.#accepts) if (v.inviteId === invite.inviteId) this.#accepts.delete(k);
    team.invites = team.invites.filter((i) => i !== invite);
    team.roles.set(held.email, invite.role);
    this.#people.set(held.email, [...this.teamsOf(held.email), team.name]);
    this.accepted.push(`${team.name} ${held.email}`);
    send(res, 200, { team: this.#entry(team, held.email) });
  }

  async #team(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "POST" && path === "/pair") return this.#pair(name, req, res);
    if (path === ACCOUNTS_INVITES_PATH || path.startsWith(`${ACCOUNTS_INVITES_PATH}/`)) return this.#invites(name, path, req, res);
    fail(res, 404, { code: "not_found", message: "Nothing here." });
  }

  async #pair(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const team = this.#teams.get(name)!;
    const body = await readBody(req);
    const code = str(body, "code");
    const deviceName = str(body, "deviceName") ?? "";
    const email = code === undefined ? undefined : team.codes.get(code);
    if (team.refuse || code === undefined || email === undefined) {
      return fail(res, 401, { code: "pair_code_invalid", message: "That pairing code is unknown or was already used." });
    }
    team.codes.delete(code);
    const key = `fld_fake_${randomBytes(12).toString("hex")}`;
    this.keys.push({ team: name, deviceName, key, email });
    send(res, 200, { key, hubUrl: team.url, hubName: name });
  }

  /** GET and POST ACCOUNTS_INVITES_PATH, and POST <it>/<inviteId>/revoke, as #26's accounts area answers them. */
  async #invites(name: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const team = this.#teams.get(name)!;
    const bearer = /^Bearer (.+)$/u.exec(req.headers.authorization ?? "")?.[1];
    const caller = this.keys.find((k) => k.team === name && k.key === bearer);
    if (caller === undefined) return fail(res, 401, { code: "unauthorized", message: "This key isn't one of the hub's." });
    const role = team.roles.get(caller.email);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, { code: "forbidden", message: "Only an owner or admin invites people.", fix: "Ask an owner or admin of this team." });
    }
    const now = this.now();
    const open = () => team.invites.filter((i) => Date.parse(i.expiresAt) > now);
    const revoke = /^\/accounts\/v1\/invites\/(inv_[0-9a-f]{10})\/revoke$/u.exec(path)?.[1];
    if (req.method === "POST" && revoke !== undefined) {
      if (!open().some((i) => i.inviteId === revoke)) {
        return fail(res, 404, { code: "not_found", message: `No open invite ${revoke}.`, fix: "List the open invites to see which are left." });
      }
      team.invites = team.invites.filter((i) => i.inviteId !== revoke);
      return send(res, 200, { revoked: revoke });
    }
    if (path !== ACCOUNTS_INVITES_PATH) return fail(res, 404, { code: "not_found", message: "Nothing here." });
    if (req.method === "GET") return send(res, 200, { invites: open().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    if (req.method !== "POST") return fail(res, 404, { code: "not_found", message: "Nothing here." });
    const body = await readBody(req);
    const email = (str(body, "email") ?? "").trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      return fail(res, 400, { code: "invalid", message: "That isn't an email address.", fix: "Type the person's email." });
    }
    const asked = typeof body === "object" && body !== null ? (body as Record<string, unknown>).role : undefined;
    const as = asked === undefined ? "member" : asked;
    if (as !== "owner" && as !== "admin" && as !== "member") {
      return fail(res, 400, { code: "invalid", message: "The role is owner, admin or member.", fix: "Pick one of them." });
    }
    if (as === "owner" && role !== "owner") {
      return fail(res, 403, { code: "forbidden", message: "Only an owner makes someone an owner.", fix: "Pick admin or member, or ask an owner." });
    }
    if (team.roles.has(email)) return fail(res, 409, { code: "already_member", message: `${email} is on this team already.` });
    if (open().some((i) => i.email === email)) {
      return fail(res, 409, { code: "already_invited", message: `${email} is invited already.`, fix: "Revoke that invite first to send a new one." });
    }
    if (team.roles.size + open().length >= team.limit) {
      return fail(res, 403, {
        code: "failed",
        message: `This team has reached its limit of people (${String(team.limit)}).`,
        fix: "Remove one first, or ask fleetd's operator for a higher limit.",
      });
    }
    const invite: AccountsInvite = {
      inviteId: `inv_${randomBytes(5).toString("hex")}`,
      email,
      role: as,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
    };
    team.invites.push(invite);
    team.invitedBy.set(invite.inviteId, caller.email);
    this.sent.push({ team: name, email, role: as });
    send(res, 200, { invite });
  }
}
