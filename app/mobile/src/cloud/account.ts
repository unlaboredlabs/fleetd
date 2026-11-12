// Sign in to fleetd cloud (hosted-plan §4, cloud-plan §8), as the desktop's (app/desktop/src/main/cloud/account.ts)
// but for a phone: WorkOS's sign-in page with PKCE in the system's auth session (ASWebAuthenticationSession on iOS,
// never a web view of the app's), back on fleetd://signin/callback, then one call to the accounts service
// (contracts: Accounts.json), which redeems WorkOS's code itself and answers the person's teams, each with its address
// and a one-time pairing code. Each code goes to that team's own POST /pair, as a typed one does (hub/pair.ts), and
// each key is kept as any hub's (vault.ts). The app keeps the email and WorkOS's session id, never a WorkOS token, and
// never the verifier. Sign out drops this phone's key on each of the account's hubs, then ends the session.
//
// The phone's own code, not the desktop's: that one listens on a loopback port with node:http and checks with zod,
// neither of which the phone has. The contract's paths and shapes are shared (desktop.ts).
import { sha256 } from "@noble/hashes/sha2.js";
import { ACCOUNTS_APP_REDIRECT, ACCOUNTS_SIGN_IN_PATH, ACCOUNTS_SIGN_OUT_PATH, type AccountsSignInInput, type PairFailure } from "../desktop";
import { pair, type Fetch, type Paired } from "../hub/pair";
import { signOut, withHub, type HubLink } from "../push";
import { toBase64, utf8Encode } from "../seal";
import { teamOrigin, type CloudConfig } from "./config";

const CALL_TIMEOUT_MS = 20_000;

/** A hub this phone keeps a key for; `cloud`, one of the account's teams, which sign-out drops. */
export type KeptHub = Paired & { readonly cloud?: true };

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

/** How a sign-in ended. Cancelled ends quietly: the person closed the page. */
export type SignInOutcome =
  | { readonly ok: true; readonly account: SavedAccount; readonly teams: readonly TeamOutcome[] }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly cancelled?: undefined; readonly failure: PairFailure };

const failed = (code: string, message: string, fix?: string): SignInOutcome => ({ ok: false, failure: fix === undefined ? { code, message } : { code, message, fix } });

const OFFLINE = failed("offline", "This phone can't reach fleetd.", "Check your connection, then sign in again.");

const base64url = (bytes: Uint8Array): string => toBase64(bytes).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

/** A PKCE pair (RFC 7636): 32 random bytes as the verifier, its SHA-256 as the S256 challenge. */
export const pkce = (random: (bytes: number) => Uint8Array): { verifier: string; challenge: string } => {
  const verifier = base64url(random(32));
  return { verifier, challenge: base64url(sha256(utf8Encode(verifier))) };
};

/** WorkOS's sign-in page for this app, with PKCE and the app's redirect. */
export const authorizeUrl = (config: CloudConfig, p: { challenge: string; state: string }): string => {
  const q: Array<[string, string]> = [
    ["client_id", config.clientId],
    ["redirect_uri", ACCOUNTS_APP_REDIRECT],
    ["response_type", "code"],
    ["provider", "authkit"],
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

type Team = { readonly name: string; readonly url: string; readonly pairingCode: string };

/** The service's 200, checked as the desktop's zod schema does; null when it isn't one. */
const signedIn = (json: unknown): { email: string; sessionId: string; teams: Team[] } | null => {
  if (typeof json !== "object" || json === null) return null;
  const { email, sessionId, teams } = json as Record<string, unknown>;
  if (!text(email, 320) || !text(sessionId, 200) || !Array.isArray(teams) || teams.length === 0 || teams.length > 50) return null;
  const out: Team[] = [];
  for (const t of teams as unknown[]) {
    const { id, name, url, pairingCode } = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
    if (!text(id, 200) || !text(name, 63) || !text(url, 2000) || !text(pairingCode, 100)) return null;
    out.push({ name, url, pairingCode });
  }
  return { email, sessionId, teams: out };
};

/** One sign-in, from opening the page to a key per team. */
export const signIn = async (ports: SignInPorts): Promise<SignInOutcome> => {
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

/** The accounts service's answer, then a key from each team's /pair. */
const exchange = async (ports: SignInPorts, body: AccountsSignInInput): Promise<SignInOutcome> => {
  let response: Response;
  try {
    response = await post(ports.fetch, `${ports.config.accountsUrl}${ACCOUNTS_SIGN_IN_PATH}`, body);
  } catch {
    return OFFLINE;
  }
  const json = await readJson(response);
  if (!response.ok) {
    const { code, message, fix } = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
    return typeof code === "string" && text(message, 500)
      ? failed(code, message, text(fix, 500) ? fix : undefined)
      : failed("", `fleetd's sign-in answered HTTP ${String(response.status)}.`, "Try again in a moment.");
  }
  const answer = signedIn(json);
  if (answer === null) return failed("", "fleetd's sign-in answered in a way this app doesn't understand.", "Update the app, then sign in again.");
  const teams: TeamOutcome[] = [];
  for (const team of answer.teams) teams.push(await pairTeam(ports, team));
  if (!teams.some((t) => t.ok)) {
    void endSession(ports.fetch, ports.config, answer.sessionId);
    const first = teams[0];
    return first === undefined || first.ok ? failed("", "No team of this account could be connected.") : { ok: false, failure: first.failure };
  }
  return { ok: true, account: { email: answer.email, sessionId: answer.sessionId }, teams };
};

const pairTeam = async (ports: SignInPorts, team: Team): Promise<TeamOutcome> => {
  const name = team.name;
  const origin = teamOrigin(team.url, ports.local);
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
  return { name, ok: true, hub: { ...paired.paired, hubName: paired.paired.hubName === "" ? name : paired.paired.hubName, cloud: true } };
};

/** Ends WorkOS's session; the service answers 204 whatever it was, and a phone offline leaves it to run out. */
export const endSession = async (fetch: Fetch, config: CloudConfig, sessionId: string): Promise<void> => {
  await post(fetch, `${config.accountsUrl}${ACCOUNTS_SIGN_OUT_PATH}`, { sessionId }).catch(() => undefined);
};

/** The hubs kept once signed in: the person's own hubs stay, the account's teams replace any it had before. */
export const afterSignIn = (kept: readonly KeptHub[], teams: readonly TeamOutcome[]): KeptHub[] => {
  const fresh = teams.flatMap((t) => (t.ok ? [t.hub] : []));
  const origins = new Set(fresh.map((h) => h.hub));
  return [...kept.filter((h) => h.cloud !== true && !origins.has(h.hub)), ...fresh];
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
  hub.cloud === true && s.projects !== undefined && Object.keys(s.projects).length === 0 && s.machines.length === 0;
