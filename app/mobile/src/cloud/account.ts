// Sign in to fleetd cloud (hosted-plan §4, cloud-plan §8), as the desktop's (app/desktop/src/main/cloud/account.ts)
// but for a phone: WorkOS's sign-in page with PKCE in the system's auth session (ASWebAuthenticationSession on iOS,
// never a web view of the app's), back on fleetd://signin/callback, then one call to the accounts service
// (contracts: Accounts.json), which redeems WorkOS's code itself and answers the person's teams, each with its address
// and a one-time pairing code, and apart from them each invitation they haven't answered. Before anything pairs, the
// person is shown who signed in ("Signed in as <email>", Not you? Sign out) and asked about each invitation, Join or
// Not now (decision hosted.invites-need-accept): finish then sends each team's code to that team's own POST /pair, as
// a typed one does (hub/pair.ts), joins each invitation chosen (POST ACCOUNTS_ACCEPT_PATH) and pairs it the same way,
// and each key is kept as any hub's (vault.ts); a key it replaces, and a previous account's teams, are revoked there
// as Sign out does. The app keeps the email and WorkOS's session id, never a WorkOS token, and never the verifier.
// Sign out drops this phone's key on each of the account's hubs, then ends the session.
//
// The phone's own code, not the desktop's: that one listens on a loopback port with node:http and checks with zod,
// neither of which the phone has. The contract's paths and shapes are shared (desktop.ts).
import { sha256 } from "@noble/hashes/sha2.js";
import {
  ACCOUNTS_ACCEPT_PATH,
  ACCOUNTS_APP_REDIRECT,
  ACCOUNTS_SIGN_IN_PATH,
  ACCOUNTS_SIGN_OUT_PATH,
  madeTeam,
  readAccepted,
  readSignIn,
  teamOrigin,
  type AccountsInvitation,
  type AccountsSignInInput,
  type AccountsTeam,
  type PairFailure,
  type SignedIn,
} from "../desktop";
import { pair, type Fetch, type Paired } from "../hub/pair";
import { signOut, withHub, type HubLink } from "../push";
import { toBase64, utf8Encode } from "../seal";
import type { CloudConfig } from "./config";

const CALL_TIMEOUT_MS = 20_000;

/**
 * A hub this phone keeps a key for; `cloud`, one of the account's teams, which sign-out drops; `invited`, a team the
 * person didn't make (the service's word at the last sign-in), whose chats list never says to connect a computer to it.
 */
export type KeptHub = Paired & { readonly cloud?: true; readonly invited?: true };

/** What the app keeps of a sign-in. */
export interface SavedAccount {
  readonly email: string;
  readonly sessionId: string;
}

/** How the system's auth session ended: back at the redirect with its URL, or closed (`cancel`, `dismiss`). */
export type AuthResult = { readonly type: "success"; readonly url: string } | { readonly type: string; readonly url?: undefined };

export interface SignInPorts {
  readonly config: CloudConfig;
  /** A development build: a stand-in's http://127.0.0.1 addresses count. */
  readonly local: boolean;
  readonly fetch: Fetch;
  /** Opens `url` in the system's auth session, which ends when the page goes to `redirect`. */
  readonly authSession: (url: string, redirect: string) => Promise<AuthResult>;
  readonly random: (bytes: number) => Uint8Array;
  readonly deviceName: string;
}

/** One team of the account's, and its key, or why this phone got none. */
export type TeamOutcome = { readonly name: string; readonly ok: true; readonly hub: KeptHub } | { readonly name: string; readonly ok: false; readonly failure: PairFailure };

/** Back from the page: the service's answer, held until the person says it's them; nothing is paired yet. */
export type Arrived = { readonly ok: true; readonly answer: SignedIn } | { readonly ok: false; readonly cancelled: true } | { readonly ok: false; readonly cancelled?: undefined; readonly failure: PairFailure };

/** How a sign-in ended. Cancelled ends quietly: the person closed the page, or said it wasn't them. */
export type SignInOutcome =
  | { readonly ok: true; readonly account: SavedAccount; readonly teams: readonly TeamOutcome[] }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly cancelled?: undefined; readonly failure: PairFailure };

const failed = (code: string, message: string, fix?: string): { ok: false; failure: PairFailure } => ({ ok: false, failure: fix === undefined ? { code, message } : { code, message, fix } });

const OFFLINE_FAILURE: PairFailure = { code: "offline", message: "This phone can't reach fleetd.", fix: "Check your connection, then sign in again." };

const base64url = (bytes: Uint8Array): string => toBase64(bytes).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

/** A PKCE pair (RFC 7636): 32 random bytes as the verifier, its SHA-256 as the S256 challenge. */
export const pkce = (random: (bytes: number) => Uint8Array): { verifier: string; challenge: string } => {
  const verifier = base64url(random(32));
  return { verifier, challenge: base64url(sha256(utf8Encode(verifier))) };
};

/** WorkOS's sign-in page for this app, with PKCE and the app's redirect. `max_age=0` (WorkOS's documented way) and
 * `prompt=login` make AuthKit ask every time: without them, a browser already signed in to AuthKit came straight back
 * to fleetd:// with a code, no page shown. */
export const authorizeUrl = (config: CloudConfig, p: { challenge: string; state: string }): string => {
  const q: Array<[string, string]> = [
    ["client_id", config.clientId],
    ["redirect_uri", ACCOUNTS_APP_REDIRECT],
    ["response_type", "code"],
    ["provider", "authkit"],
    ["prompt", "login"],
    ["max_age", "0"],
    ["state", p.state],
    ["code_challenge", p.challenge],
    ["code_challenge_method", "S256"],
  ];
  return `${config.authorizeUrl}?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
};

/** A URL's query, by hand: React Native's URL has no searchParams. A malformed part is skipped. */
export const queryOf = (url: string): ReadonlyMap<string, string> => {
  const params = new Map<string, string>();
  const query = url.split("#")[0]?.split("?").slice(1).join("?") ?? "";
  for (const part of query.split("&")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    try {
      params.set(decodeURIComponent(part.slice(0, at)), decodeURIComponent(part.slice(at + 1).replace(/\+/gu, " ")));
    } catch {
      // Not ours to read.
    }
  }
  return params;
};

/** A POST of JSON with a timeout: React Native has no AbortSignal.timeout. Throws when it gets no answer. */
const post = async (fetch: Fetch, url: string, body: unknown): Promise<Response> => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CALL_TIMEOUT_MS);
  try {
    return await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: abort.signal, redirect: "error" });
  } finally {
    clearTimeout(timer);
  }
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
};

const text = (v: unknown, max: number): v is string => typeof v === "string" && v !== "" && v.length <= max;

/** A refusal in the service's words, else its status. */
const refusal = (json: unknown, status: number): { ok: false; failure: PairFailure } => {
  const { code, message, fix } = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  return typeof code === "string" && text(message, 500)
    ? { ok: false, failure: text(fix, 500) ? { code, message, fix } : { code, message } }
    : { ok: false, failure: { code: "", message: `fleetd's sign-in answered HTTP ${String(status)}.`, fix: "Try again in a moment." } };
};

const UNREADABLE: PairFailure = { code: "", message: "fleetd's sign-in answered in a way this app doesn't understand.", fix: "Update the app, then sign in again." };

/** The questions after the page, each the person's answer: it's them, and each invitation joined or not. */
export interface AfterSignInAsk {
  /** "Signed in as <email>", with Not you? Sign out: false is Sign out. */
  readonly signedInAs: (email: string) => Promise<boolean>;
  /** "<invitedBy> invited you to <name>", Join or Not now: true is Join. */
  readonly invitation: (invitation: AccountsInvitation) => Promise<boolean>;
}

/** Asks who signed in, then about each invitation in turn; null when it isn't them. */
export const askAfterSignIn = async (ask: AfterSignInAsk, answer: SignedIn): Promise<number[] | null> => {
  if (!(await ask.signedInAs(answer.email))) return null;
  const join: number[] = [];
  for (const [at, invitation] of answer.invitations.entries()) if (await ask.invitation(invitation)) join.push(at);
  return join;
};

/** A whole sign-in: the page, who signed in and each invitation asked, then a key per team and per invitation joined. */
export const signInAsking = async (ports: SignInPorts, ask: AfterSignInAsk): Promise<SignInOutcome> => {
  const arrived = await signIn(ports);
  if (!arrived.ok) return arrived;
  const join = await askAfterSignIn(ask, arrived.answer).catch(() => null);
  if (join === null) {
    void endSession(ports.fetch, ports.config, arrived.answer.sessionId);
    return { ok: false, cancelled: true };
  }
  return finish(ports, arrived.answer, join);
};

/** The browser's part and the service's answer, held for the questions: nothing is paired yet. */
export const signIn = async (ports: SignInPorts): Promise<Arrived> => {
  const { verifier, challenge } = pkce(ports.random);
  const state = base64url(ports.random(16));
  let result: AuthResult;
  try {
    result = await ports.authSession(authorizeUrl(ports.config, { challenge, state }), ACCOUNTS_APP_REDIRECT);
  } catch {
    return failed("", "The sign-in page didn't open.", "Try again in a moment.");
  }
  if (result.type !== "success" || result.url === undefined) return { ok: false, cancelled: true };
  const back = queryOf(result.url);
  // Only the answer to the page this app opened: another app or page can open fleetd://signin/callback too.
  if (back.get("state") !== state) return failed("state", "This sign-in didn't come back from the page this app opened, so it was refused.", "Sign in again.");
  const code = back.get("code") ?? "";
  if (code === "") {
    // WorkOS's own cancel on its page comes back as an error, not as the session closing.
    if (back.get("error") === "access_denied") return { ok: false, cancelled: true };
    return failed("refused", "The sign-in page came back without signing you in.", "Nothing was changed. Sign in again.");
  }
  return exchange(ports, { code, codeVerifier: verifier, redirectUri: ACCOUNTS_APP_REDIRECT, deviceName: ports.deviceName });
};

/** The accounts service's answer, held: nothing pairs before the person has said it's them. */
const exchange = async (ports: SignInPorts, body: AccountsSignInInput): Promise<Arrived> => {
  let response: Response;
  try {
    response = await post(ports.fetch, `${ports.config.accountsUrl}${ACCOUNTS_SIGN_IN_PATH}`, body);
  } catch {
    return { ok: false, failure: OFFLINE_FAILURE };
  }
  const json = await readJson(response);
  if (!response.ok) return refusal(json, response.status);
  const answer = readSignIn(json);
  if (answer === null) return { ok: false, failure: UNREADABLE };
  if (answer.teams.length === 0 && answer.invitations.length === 0) {
    void endSession(ports.fetch, ports.config, answer.sessionId);
    return { ok: false, failure: { code: "", message: "No team of this account could be connected." } };
  }
  return { ok: true, answer };
};

/**
 * It's them: a key from each team's /pair, and from each invitation at `join` once the service has joined it. With
 * nothing paired, the session ends.
 */
export const finish = async (ports: SignInPorts, answer: SignedIn, join: readonly number[]): Promise<SignInOutcome> => {
  const teams: TeamOutcome[] = [];
  for (const team of answer.teams) teams.push(await pairTeam(ports, team, !madeTeam(team, false)));
  for (const at of join) {
    const invitation = answer.invitations[at];
    if (invitation === undefined) continue;
    const joined = await accept(ports, invitation.accept);
    teams.push(joined.ok ? await pairTeam(ports, joined.team, !madeTeam(joined.team, true)) : { name: invitation.name, ok: false, failure: joined.failure });
  }
  if (!teams.some((t) => t.ok)) {
    void endSession(ports.fetch, ports.config, answer.sessionId);
    const first = teams[0];
    if (first === undefined) return failed("none_joined", "You didn't join a team, so you aren't signed in.", "Sign in again when you want to join it.");
    return first.ok ? failed("", "No team of this account could be connected.") : { ok: false, failure: first.failure };
  }
  return { ok: true, account: { email: answer.email, sessionId: answer.sessionId }, teams };
};

/** The service joins an invitation the person chose, and answers the team with its pairing code. */
const accept = async (ports: SignInPorts, value: string): Promise<{ ok: true; team: AccountsTeam } | { ok: false; failure: PairFailure }> => {
  let response: Response;
  try {
    response = await post(ports.fetch, `${ports.config.accountsUrl}${ACCOUNTS_ACCEPT_PATH}`, { accept: value });
  } catch {
    return { ok: false, failure: OFFLINE_FAILURE };
  }
  const json = await readJson(response);
  if (!response.ok) return refusal(json, response.status);
  const team = readAccepted(json);
  return team === null ? { ok: false, failure: UNREADABLE } : { ok: true, team };
};

const pairTeam = async (ports: SignInPorts, team: AccountsTeam, invited: boolean): Promise<TeamOutcome> => {
  const name = team.name;
  const origin = teamOrigin(team.url, ports.config.accountsUrl, ports.local);
  if (origin === null) return { name, ok: false, failure: { code: "", message: `${name}'s address isn't one this app connects to.`, fix: "Update the app, then sign in again." } };
  const paired = await pair(ports.fetch, origin, team.pairingCode, ports.deviceName);
  if (!paired.ok) {
    // /pair's own words assume a hub of your own; a team's code comes from signing in.
    const failure: PairFailure =
      paired.failure.code === ""
        ? { code: "offline", message: `Can't reach ${name}.`, fix: "Check your connection, then sign in again." }
        : { code: paired.failure.code, message: `${name} refused this phone's code.`, fix: "Sign in again for a new code." };
    return { name, ok: false, failure };
  }
  const hubName = paired.paired.hubName === "" ? name : paired.paired.hubName;
  return { name, ok: true, hub: { ...paired.paired, hubName, cloud: true, ...(invited ? { invited: true as const } : {}) } };
};

/** Ends WorkOS's session; the service answers 204 whatever it was, and a phone offline leaves it to run out. */
export const endSession = async (fetch: Fetch, config: CloudConfig, sessionId: string): Promise<void> => {
  await post(fetch, `${config.accountsUrl}${ACCOUNTS_SIGN_OUT_PATH}`, { sessionId }).catch(() => undefined);
};

/**
 * The hubs kept once signed in: the person's own hubs stay, the account's teams replace any it had before. `dropped`,
 * each hub whose key goes: a team's key a new one replaces, and the earlier teams this sign-in didn't bring.
 */
export const afterSignIn = (kept: readonly KeptHub[], teams: readonly TeamOutcome[]): { hubs: KeptHub[]; dropped: KeptHub[] } => {
  const fresh = teams.flatMap((t) => (t.ok ? [t.hub] : []));
  const origins = new Set(fresh.map((h) => h.hub));
  const stays = (h: KeptHub) => h.cloud !== true && !origins.has(h.hub);
  return { hubs: [...kept.filter(stays), ...fresh], dropped: kept.filter((h) => !stays(h)) };
};

/**
 * Each dropped key revoked on its hub, as Sign out does, from memory: the app forgets it at once, and a hub that
 * can't be reached doesn't hold up the sign-in. Resolves with the names of the hubs that couldn't be told.
 */
export const revokeDropped = async (revoke: (hub: KeptHub) => Promise<boolean>, dropped: readonly KeptHub[]): Promise<string[]> => {
  const done = await Promise.all(dropped.map((h) => revoke(h).catch(() => false)));
  return dropped.filter((_, i) => done[i] !== true).map((h) => h.hubName);
};

export interface SignOutPorts {
  readonly config: CloudConfig | null;
  readonly fetch: Fetch;
  /** Drops this phone's key on `hub`: true once the hub no longer takes it. */
  readonly revoke: (hub: KeptHub) => Promise<boolean>;
}

/**
 * Drops this phone's key on each of the account's hubs, every one kept, not only the one shown, then ends the session.
 * `kept` names each team whose hub couldn't be told (it was offline), which keeps this phone in its Devices.
 */
export const signOutAll = async (ports: SignOutPorts, account: SavedAccount | null, hubs: readonly KeptHub[]): Promise<{ readonly hubs: KeptHub[]; readonly kept: string[] }> => {
  const teams = hubs.filter((h) => h.cloud === true);
  const revoked = await Promise.all(teams.map((h) => ports.revoke(h).catch(() => false)));
  if (account !== null && ports.config !== null) await endSession(ports.fetch, ports.config, account.sessionId);
  return { hubs: hubs.filter((h) => h.cloud !== true), kept: teams.filter((_, i) => revoked[i] !== true).map((h) => h.hubName).sort() };
};

/**
 * This phone's key on a hub, revoked over a link of its own (Disconnect's call, with no push registration: only the hub
 * shown has one). True once the hub refuses the key: it closed the link on the revoke, or it no longer took the key.
 */
export const revokeOver = async (link: HubLink): Promise<boolean> => {
  const r = await withHub(link, (client) => signOut(client, { loadDevice: () => Promise.resolve(null) }, link.key));
  return r.ok ? r.value.ok : r.error.code === "unauthorized";
};

/**
 * A team of fleetd cloud with no computer yet, which the chats list says how to connect: a phone runs no join line, so
 * a computer joins from the desktop app or with the join line on it. Machines stay a desktop job.
 */
export const needsComputer = (hub: KeptHub, s: { readonly projects: Readonly<Record<string, unknown>> | undefined; readonly machines: readonly unknown[] }): boolean =>
  hub.cloud === true && hub.invited !== true && s.projects !== undefined && Object.keys(s.projects).length === 0 && s.machines.length === 0;
