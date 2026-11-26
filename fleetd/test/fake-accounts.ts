// A stand-in for fleetd cloud's accounts service and the WorkOS sign-in in front of it, for the apps' Sign in tests:
// the browser's round trip (`authorize`, what WorkOS's page would redirect to), the one call an app makes
// (POST /v1/app/sign-in, Accounts.json), sign-out, and each team's POST /pair on an origin of its own. It checks what
// the real ones do: the PKCE verifier against the challenge, a code used once, a pairing code used once. Each team's
// origin also serves its invites by email (ACCOUNTS_INVITES_PATH) to the keys its /pair made, refusing as the service
// does: a member's key, an admin naming an owner, not an email, an email already on the team or invited, the team at
// its limit of people. The email WorkOS would send is a line in `sent`. An open invite joins nothing at sign-in: the
// answer lists it apart, with its inviter's email and a one-use accept value, and only POST ACCOUNTS_ACCEPT_PATH with
// that value makes the person one of the team (decision hosted.invites-need-accept). A person with no team and an
// invitation pending gets no team of their own made: the answer offers a one-use `make` value instead, which POST
// ACCOUNTS_TEAM_PATH turns into a team of their own (once; one who has a team already is refused). Each team entry says whether the person made it (`made`): the
// first person a test names, or the one whose sign-in made it; anyone who joined by an invitation didn't. Each team's
// origin also answers POST GITHUB_INSTALL_PATH as fleetd-cloud's src/github/install.ts does: an owner's or admin's key
// whose person connected their own GitHub (`githubConnected`) gets GitHub's install page for fleetd's App with a state
// made for them; one who didn't, 409; with `githubSetUp` false, 503. And POST ACCOUNTS_TEAM_DELETE_PATH as fleetd-cloud's
// accounts area does: an owner's key with the team's name typed again deletes it (its keys open nothing then); anyone
// else is refused, as are a wrong name and agents running (`running`). With `demo` set, POST ACCOUNTS_DEMO_SIGN_IN_PATH
// signs in App Review's address and code (D737) to its one team, answered as a sign-in is; a wrong address or code is
// one refusal, and with no `demo` the demo sign-in is off. And POST ACCOUNTS_WORKSPACES_PATH as fleetd-cloud's does: any
// key of a person's makes them a new empty workspace of their own (named, or after them), answered as POST
// ACCOUNTS_TEAM_PATH answers, up to `workspaceCap` they made; past it, refused `workspace_cap`. POST ACCOUNTS_ACCOUNT_DELETE_PATH, any key of the person's
// with their email typed back, deletes their account as fleetd-cloud does: every key of theirs opens nothing then, the
// teams where they were the only member go (`plans` names those whose plan stops with them), and they leave the others;
// the only owner of a team with others in it is refused (`sole_owner`), as is a wrong email. GET ACCOUNTS_ACCOUNT_PATH
// answers what that delete would take, deleting nothing. A person in `removedFrom` (removed from their team, as
// fleetd-cloud keeps it) gets no team made at their next sign-in: its answer has no team and a `make` value, which POST
// ACCOUNTS_APP_ACCOUNT_PATH and ACCOUNTS_APP_ACCOUNT_DELETE_PATH also take, for the preview and the delete.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ACCOUNTS_ACCEPT_PATH,
  ACCOUNTS_ACCOUNT_DELETE_PATH,
  ACCOUNTS_APP_ACCOUNT_DELETE_PATH,
  ACCOUNTS_APP_ACCOUNT_PATH,
  ACCOUNTS_ACCOUNT_PATH,
  ACCOUNTS_DEMO_SIGN_IN_PATH,
  ACCOUNTS_INVITES_PATH,
  ACCOUNTS_SIGN_IN_PATH,
  ACCOUNTS_TEAM_DELETE_PATH,
  ACCOUNTS_TEAM_PATH,
  ACCOUNTS_SIGN_OUT_PATH,
  ACCOUNTS_WORKSPACES_PATH,
  GITHUB_INSTALL_PATH,
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
  /** It holds bots or other data: a sign-in for a move answers it not empty. */
  hasData?: boolean;
  /** Agents running in it: an owner's delete is refused while any is. */
  running?: number;
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
  /** Who made the team: the first person named. */
  maker: string | undefined;
  limit: number;
  hasData: boolean;
  running: number;
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
  /** The team (by name) the next sign-in says was picked on WorkOS's page, as a person in several picks one. */
  pickNext: string | null = null;
  /** App Review's demo sign-in: its address, code and team (by name); null, off. */
  demo: { email: string; code: string; team: string } | null = null;
  /** Every invitation email sent, in order. */
  readonly sent: FakeInviteEmail[] = [];
  /** Each invitation joined through the accept call, as `<team> <email>`, in order. */
  readonly accepted: string[] = [];
  /** The time invites are made and run out by, epoch ms. */
  now: () => number = () => Date.now();
  /** Whether the service was given fleetd's GitHub App; false: GitHub's routes answer that it isn't set up. */
  githubSetUp = true;
  /** The emails whose own GitHub is connected, as `<team> <email>`: only they get an install page. */
  readonly githubConnected = new Set<string>();
  /** Each install page handed out, as `<team> <email>`. */
  readonly installs: string[] = [];
  #server: Server | null = null;
  #origin = "";
  readonly #people = new Map<string, string[]>();
  readonly #teams = new Map<string, Team>();
  readonly #codes = new Map<string, { email: string; challenge: string; redirectUri: string; used: boolean }>();
  /** Each accept value a sign-in answered: its team, invite and person; gone once used. */
  readonly #accepts = new Map<string, { team: string; inviteId: string; email: string }>();
  /** Each make value a sign-in answered: whose; gone once used. */
  readonly #makes = new Map<string, string>();
  /** Each team deleted by its owner (POST ACCOUNTS_TEAM_DELETE_PATH), by name. */
  readonly deleted: string[] = [];
  /** Each team's title, as its people named it (GET and POST /accounts/v1/team); none: its name, the address's. */
  readonly titles = new Map<string, string>();
  /** The teams on a plan, by name: deleting an account that takes one stops it. */
  readonly plans = new Set<string>();
  /** People removed from their team since: their next sign-in makes them none. */
  readonly removedFrom = new Set<string>();
  /** Each account deleted (POST ACCOUNTS_ACCOUNT_DELETE_PATH), by email. */
  readonly deletedAccounts: string[] = [];
  /** Each team made on asking (POST ACCOUNTS_TEAM_PATH), as `<team> <email>`. */
  readonly madeOnAsking: string[] = [];
  /** The most workspaces one person may have made (POST ACCOUNTS_WORKSPACES_PATH), counting those still there. */
  workspaceCap = 10;

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
      maker: emails[0],
      limit: options.peopleLimit ?? 50,
      hasData: options.hasData === true,
      running: options.running ?? 0,
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

  /** `email` removed from team `name`, as an owner's People › Remove does: their next sign-in makes them no team. */
  remove(name: string, email: string): void {
    this.#teams.get(name)!.roles.delete(email);
    this.#people.set(email, this.teamsOf(email).filter((t) => t !== name));
    for (let i = this.keys.length - 1; i >= 0; i--) if (this.keys[i]!.email === email && this.keys[i]!.team === name) this.keys.splice(i, 1);
    this.removedFrom.add(email);
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

  /** A pairing code for `email` on `team`, as an answer's team entry, saying whether `email` made the team. */
  #entry(team: Team, email: string): AccountsSignInOutput["teams"][number] {
    const code = pairingCode();
    team.codes.set(code, email);
    return { id: team.id, name: this.titles.get(team.name) ?? team.name, url: team.url, pairingCode: code, made: team.maker === email };
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
    if (path === ACCOUNTS_TEAM_PATH) return this.#make(body, res);
    if (path === ACCOUNTS_APP_ACCOUNT_PATH || path === ACCOUNTS_APP_ACCOUNT_DELETE_PATH) {
      const email = this.#makes.get(str(body, "make") ?? "");
      if (email === undefined) return fail(res, 401, { code: "signed_out", message: "That sign-in has run out.", fix: "Sign in again." });
      if (path === ACCOUNTS_APP_ACCOUNT_PATH) return this.#previewOf(email, res);
      return this.#deleteOf(email, str(body, "email"), res);
    }
    if (path === ACCOUNTS_DEMO_SIGN_IN_PATH) return this.#demo(body, res);
    if (path !== ACCOUNTS_SIGN_IN_PATH) return fail(res, 404, { code: "not_found", message: "Nothing here." });
    const input = {
      code: str(body, "code"),
      codeVerifier: str(body, "codeVerifier"),
      redirectUri: str(body, "redirectUri"),
      deviceName: str(body, "deviceName"),
      ...((body as { move?: unknown } | null)?.move === true ? { move: true as const } : {}),
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
    if (this.teamsOf(grant.email).length === 0 && invitations.length === 0 && !this.removedFrom.has(grant.email)) {
      await this.team(grant.email.split("@")[0]!.replace(/[^a-z0-9]/gu, "") || "team", [grant.email]);
    }
    // A sign-in for a move: each team the person owns says whether it is empty, and a new one is made when none is.
    const owns = (name: string) => this.#teams.get(name)!.roles.get(grant.email) === "owner";
    if (input.move === true && !this.teamsOf(grant.email).some((name) => owns(name) && !this.#teams.get(name)!.hasData)) {
      await this.team(`${grant.email.split("@")[0]!.replace(/[^a-z0-9]/gu, "") || "team"}-2`, [grant.email]);
    }
    const sessionId = `session_${randomBytes(8).toString("hex")}`;
    this.sessions.add(sessionId);
    // In no team: a team of their own is theirs to ask for.
    let make: string | undefined;
    if (this.teamsOf(grant.email).length === 0) {
      make = randomBytes(24).toString("base64url");
      this.#makes.set(make, grant.email);
    }
    const answer: AccountsSignInOutput = {
      email: grant.email,
      sessionId,
      teams: this.teamsOf(grant.email).map((name) => {
        const entry = this.#entry(this.#teams.get(name)!, grant.email);
        return input.move === true && owns(name) ? { ...entry, empty: !this.#teams.get(name)!.hasData } : entry;
      }),
      ...(invitations.length === 0 ? {} : { invitations }),
      ...(make === undefined ? {} : { make }),
    };
    const picked = this.pickNext === null ? undefined : this.#teams.get(this.pickNext);
    this.pickNext = null;
    if (picked !== undefined && answer.teams.some((t) => t.id === picked.id)) answer.picked = picked.id;
    send(res, 200, answer);
  }

  /** POST ACCOUNTS_DEMO_SIGN_IN_PATH: the demo address and code to the demo team alone, as a sign-in answers it. */
  #demo(body: unknown, res: ServerResponse): void {
    const email = str(body, "email")?.trim().toLowerCase();
    const code = str(body, "code");
    if (email === undefined || code === undefined || str(body, "deviceName") === undefined) {
      return fail(res, 400, { code: "invalid", message: "A demo sign-in needs email, code and deviceName." });
    }
    if (this.refuseNext !== null) {
      const { status, failure } = this.refuseNext;
      this.refuseNext = null;
      return fail(res, status, failure);
    }
    if (this.demo === null) return fail(res, 403, { code: "signin_closed", message: "The review sign-in is off." });
    const team = this.#teams.get(this.demo.team);
    if (email !== this.demo.email.toLowerCase() || code !== this.demo.code || team === undefined) {
      return fail(res, 401, { code: "signin_refused", message: "That address and code don't sign in.", fix: "Check both, then try again." });
    }
    const sessionId = `session_${randomBytes(8).toString("hex")}`;
    this.sessions.add(sessionId);
    send(res, 200, { email: this.demo.email, sessionId, teams: [{ ...this.#entry(team, this.demo.email), made: true }] } satisfies AccountsSignInOutput);
  }

  /** POST ACCOUNTS_TEAM_PATH: a team of the person's own, made once, answered with a pairing code. */
  async #make(body: unknown, res: ServerResponse): Promise<void> {
    const value = str(body, "make") ?? "";
    const email = this.#makes.get(value);
    this.#makes.delete(value);
    if (email === undefined) return fail(res, 401, { code: "make_refused", message: "That team can't be made any more.", fix: "Sign in again." });
    if (this.teamsOf(email).length > 0) return fail(res, 409, { code: "already_own", message: "You have a team already.", fix: "Sign in again to open it." });
    const name = email.split("@")[0]!.replace(/[^a-z0-9]/gu, "") || "team";
    await this.team(name, [email]);
    this.madeOnAsking.push(`${name} ${email}`);
    send(res, 200, { team: this.#entry(this.#teams.get(name)!, email) });
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
    if (req.method === "POST" && path === GITHUB_INSTALL_PATH) return this.#githubInstall(name, req, res);
    if (req.method === "POST" && path === ACCOUNTS_TEAM_DELETE_PATH) return this.#deleteTeam(name, req, res);
    if (req.method === "POST" && path === ACCOUNTS_WORKSPACES_PATH) return this.#newWorkspace(name, req, res);
    if (req.method === "POST" && path === ACCOUNTS_ACCOUNT_DELETE_PATH) return this.#deleteAccount(name, req, res);
    if (req.method === "GET" && path === ACCOUNTS_ACCOUNT_PATH) return this.#accountPreview(name, req, res);
    if (path === "/accounts/v1/team") return this.#title(name, req, res);
    fail(res, 404, { code: "not_found", message: "Nothing here." });
  }

  /** GET and POST /accounts/v1/team: the team as its people see it, and its title changed by an owner or admin. */
  async #title(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const team = this.#teams.get(name)!;
    const bearer = /^Bearer (.+)$/u.exec(req.headers.authorization ?? "")?.[1];
    const caller = this.keys.find((k) => k.team === name && k.key === bearer);
    if (caller === undefined) return fail(res, 401, { code: "unauthorized", message: "This key isn't one of the hub's." });
    const role = team.roles.get(caller.email);
    const canRename = role === "owner" || role === "admin";
    if (req.method === "POST") {
      if (!canRename) return fail(res, 403, { code: "forbidden", message: "Only an owner or admin renames the workspace.", fix: "Ask an owner or admin of this workspace." });
      const title = str(await readBody(req), "name")?.trim() ?? "";
      if (title === "" || title.length > 64) return fail(res, 400, { code: "invalid", message: "Name the workspace in 1 to 64 characters." });
      this.titles.set(name, title);
    }
    send(res, 200, { name: this.titles.get(name) ?? name, address: team.url, canRename });
  }

  /** POST ACCOUNTS_TEAM_DELETE_PATH, in fleetd-cloud's words (src/accounts/accounts.ts `deleteTeam`). */
  async #deleteTeam(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const team = this.#teams.get(name)!;
    const bearer = /^Bearer (.+)$/u.exec(req.headers.authorization ?? "")?.[1];
    const caller = this.keys.find((k) => k.team === name && k.key === bearer);
    if (caller === undefined || this.deleted.includes(name)) return fail(res, 401, { code: "unauthorized", message: "This key isn't one of the hub's." });
    if (team.roles.get(caller.email) !== "owner") return fail(res, 403, { code: "forbidden", message: "Only the team's owner deletes the team.", fix: "Ask an owner of this team." });
    const typed = str(await readBody(req), "name")?.replace(/\s+/gu, " ").trim();
    if (typed === undefined || typed === "") return fail(res, 400, { code: "invalid", message: "The team's name is missing.", fix: "Type the team's name to delete it." });
    if (typed !== name) return fail(res, 400, { code: "wrong_name", message: "That isn't this team's name.", fix: `Type ${name} to delete it.` });
    if (team.running > 0) {
      const agents = team.running === 1 ? "An agent is" : `${String(team.running)} agents are`;
      return fail(res, 409, { code: "running", message: `${agents} running in this team.`, fix: "Stop them, then delete the team." });
    }
    this.deleted.push(name);
    send(res, 200, { deleted: name });
  }

  /** POST ACCOUNTS_WORKSPACES_PATH, in fleetd-cloud's words: a new empty workspace of the caller's own, its address from its name. */
  async #newWorkspace(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bearer = /^Bearer (.+)$/u.exec(req.headers.authorization ?? "")?.[1];
    const caller = this.keys.find((k) => k.team === name && k.key === bearer);
    if (caller === undefined || this.deleted.includes(name)) return fail(res, 401, { code: "unauthorized", message: "This key isn't one of the hub's." });
    const given = str(await readBody(req), "name")?.trim() ?? "";
    if (given.length > 60) return fail(res, 400, { code: "invalid", message: "A workspace's name is 60 characters at most.", fix: "Give it a shorter name." });
    const made = [...this.#teams.values()].filter((t) => t.maker === caller.email && !this.deleted.includes(t.name)).length;
    if (made >= this.workspaceCap) {
      return fail(res, 403, { code: "workspace_cap", message: `You've made ${String(this.workspaceCap)} workspaces, the most one person can have.`, fix: "Delete one you don't use in Settings › Workspace, then make a new one." });
    }
    const base = (given === "" ? `${caller.email.split("@")[0]!}s workspace` : given).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "workspace";
    let slug = base;
    for (let n = 2; this.#teams.has(slug); n++) slug = `${base}-${String(n)}`;
    await this.team(slug, [caller.email]);
    send(res, 200, { team: this.#entry(this.#teams.get(slug)!, caller.email) });
  }

  /** Who asks about their own account, by any key of theirs; null when the key opens nothing. */
  #accountOf(name: string, req: IncomingMessage): string | null {
    const bearer = /^Bearer (.+)$/u.exec(req.headers.authorization ?? "")?.[1];
    const caller = this.keys.find((k) => k.team === name && k.key === bearer);
    return caller === undefined || this.deleted.includes(name) ? null : caller.email;
  }

  /** What deleting `email`'s account would take: the teams that go, those left, and those that hold it back. */
  #accountTeams(email: string): { alone: Team[]; left: Team[]; held: Team[] } {
    const teams = this.teamsOf(email).map((n) => this.#teams.get(n)!).filter((t) => !this.deleted.includes(t.name));
    const alone = teams.filter((t) => t.roles.size === 1);
    const held = teams.filter((t) => t.roles.size > 1 && t.roles.get(email) === "owner" && ![...t.roles].some(([e, r]) => e !== email && r === "owner"));
    return { alone, left: teams.filter((t) => t.roles.size > 1), held };
  }

  /** GET ACCOUNTS_ACCOUNT_PATH, as fleetd-cloud answers it: nothing is deleted. */
  #accountPreview(name: string, req: IncomingMessage, res: ServerResponse): void {
    const email = this.#accountOf(name, req);
    if (email === null) return fail(res, 401, { code: "unauthorized", message: "This key isn't one of the hub's." });
    this.#previewOf(email, res);
  }

  #previewOf(email: string, res: ServerResponse): void {
    const { alone, left, held } = this.#accountTeams(email);
    send(res, 200, { email, deletes: alone.map((t) => ({ name: t.name, plan: this.plans.has(t.name) ? "Team" : null })), leaves: left.map((t) => t.name), blocked: held.map((t) => t.name) });
  }

  /** POST ACCOUNTS_ACCOUNT_DELETE_PATH, in fleetd-cloud's words (src/accounts `deleteAccount`). */
  async #deleteAccount(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const email = this.#accountOf(name, req);
    if (email === null) return fail(res, 401, { code: "unauthorized", message: "This key isn't one of the hub's." });
    this.#deleteOf(email, str(await readBody(req), "email"), res);
  }

  #deleteOf(email: string, given: string | undefined, res: ServerResponse): void {
    const typed = given?.trim().toLowerCase();
    if (typed === undefined || typed === "") return fail(res, 400, { code: "invalid", message: "Your email is missing.", fix: "Type your account's email to delete it." });
    if (typed !== email.toLowerCase()) return fail(res, 400, { code: "wrong_email", message: "That isn't this account's email.", fix: `Type ${email} to delete it.` });
    const { alone, left, held } = this.#accountTeams(email);
    if (held.length > 0) {
      return fail(res, 409, { code: "sole_owner", message: `You're the only owner of ${held.map((t) => t.name).join(", ")}, which has other members.`, fix: "Make someone else an owner there, or delete the workspace, then delete your account." });
    }
    for (const t of [...alone, ...left]) t.roles.delete(email);
    for (const t of alone) {
      this.deleted.push(t.name);
      this.plans.delete(t.name);
    }
    for (let i = this.keys.length - 1; i >= 0; i--) if (this.keys[i]!.email === email) this.keys.splice(i, 1);
    this.#people.delete(email);
    for (const [make, whose] of this.#makes) if (whose === email) this.#makes.delete(make);
    this.deletedAccounts.push(email);
    send(res, 200, { deleted: email, workspaces: alone.map((t) => t.name) });
  }

  /** Agents running in a team now: its owner's delete is refused while any is. */
  setRunning(name: string, running: number): void {
    this.#teams.get(name)!.running = running;
  }

  /** POST GITHUB_INSTALL_PATH, in fleetd-cloud's words (src/github/install.ts `begin`). */
  #githubInstall(name: string, req: IncomingMessage, res: ServerResponse): void {
    const team = this.#teams.get(name)!;
    const bearer = /^Bearer (.+)$/u.exec(req.headers.authorization ?? "")?.[1];
    const caller = this.keys.find((k) => k.team === name && k.key === bearer);
    if (caller === undefined) return fail(res, 401, { code: "unauthorized", message: "This key isn't one of the hub's." });
    if (!this.githubSetUp) return fail(res, 503, { code: "failed", message: "GitHub isn't set up on this service.", fix: "Write to fleetd's support." });
    const role = team.roles.get(caller.email);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, {
        code: "forbidden",
        message: "Only the team's owners and admins connect its GitHub.",
        fix: "Ask an owner or admin; they install fleetd's GitHub App from Settings › Hub › GitHub.",
      });
    }
    if (!this.githubConnected.has(`${name} ${caller.email}`)) {
      return fail(res, 409, {
        code: "failed",
        message: "Connect your own GitHub first: fleetd asks GitHub, as you, that you administer the account you install it on.",
        fix: "Connect GitHub in Settings › Accounts › GitHub, then install again.",
      });
    }
    this.installs.push(`${name} ${caller.email}`);
    const state = `${team.id}.${randomBytes(32).toString("base64url")}`;
    send(res, 200, { url: `https://github.com/apps/fleetd-cloud/installations/new?state=${encodeURIComponent(state)}` });
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
