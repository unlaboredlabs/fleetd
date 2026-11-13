// Sign in to fleetd cloud (hosted-plan §4, cloud-plan §8): WorkOS's sign-in page in the system browser with PKCE,
// back to a loopback port here (as githubConnect.ts does for GitHub), then one call to the accounts service
// (contracts: Accounts.json), which redeems WorkOS's code itself and answers the person's teams, each with its
// address and a one-time pairing code, and apart from them each invitation they haven't answered. The answer is held
// here, nothing connected, until the page has shown "Signed in as <email>" and asked about each invitation
// (decision hosted.invites-need-accept): finish then sends each team's code to its own POST /pair, as a typed one
// does, joins each invitation the person chose (POST ACCOUNTS_ACCEPT_PATH) and pairs it the same way, and keeps each
// key in the keychain beside any other hub's; Not you drops the answer and ends its session. Only a team the service
// says the person made (`made`) may open on Connect a computer, which each sign-in says again. A key this replaces on a
// team, and a previous account's teams, are revoked there first, as Sign out does. The app keeps the email and
// WorkOS's session id, never a WorkOS token. Sign out drops this device's key on each of the account's hubs, then ends
// the session. One sign-in at a time: a new one, or Cancel, ends the one waiting.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { madeTeam, readAccepted, readSignIn, teamOrigin, type SignedIn } from "../../shared/accounts";
import type { FinishOutcome, SignInOutcome, SignOutOutcome, TeamOutcome } from "../../shared/cloud";
import { ACCOUNTS_ACCEPT_PATH, ACCOUNTS_LOOPBACK_PATH, ACCOUNTS_SIGN_IN_PATH, ACCOUNTS_SIGN_OUT_PATH, type AccountsTeam } from "../../shared/contracts";
import type { CallOutcome, ConnectOutcome } from "../../shared/hub";
import { cleanLabel } from "../../shared/hubs";
import type { PairFailure } from "../../shared/pairing";
import { landing, pkce } from "../loopback";
import { redeem, type Fetch } from "../pairing/hubHttp";
import type { CloudConfig } from "./config";

/** How long the browser has to come back. */
export const WAIT_MS = 10 * 60_000;

const CALL_TIMEOUT_MS = 20_000;

/** What the app keeps of a sign-in. */
export interface SavedAccount {
  readonly email: string;
  readonly sessionId: string;
}

export const SavedAccount = z.object({ email: z.string().min(1).max(320), sessionId: z.string().min(1).max(200) });

/** A hub that came with the account, or any held at a team's address: its label, and a call to it. */
export interface CloudHub {
  readonly id: string;
  readonly label: string;
  /** Its address, as kept; null when it has none. */
  readonly url: string | null;
  call(tool: string, input: unknown): Promise<CallOutcome>;
  /** The hub refuses this app's key now (its connection's state is `refused`). */
  refused(): boolean;
}

export interface CloudPorts {
  /** Null: this build has no Sign in. */
  readonly config: CloudConfig | null;
  /** A development or test build: a stand-in's http://127.0.0.1 addresses count. */
  readonly local: boolean;
  readonly fetch: Fetch;
  /** Shows a page in the system browser. */
  readonly open: (url: string) => Promise<void>;
  readonly deviceName: () => string;
  /**
   * Saves a team's key and connects to it, listed as one of the account's hubs under `label`; `invited`, a team the
   * person didn't make (the service's word at this sign-in), which never opens on Connect a computer.
   */
  readonly connect: (url: string, key: string, label: string, invited: boolean) => ConnectOutcome;
  readonly cloudHubs: () => ReadonlyArray<CloudHub>;
  /** The hub listed at `origin` that holds a key for it, the account's or not; null when none does. */
  readonly heldAt: (origin: string) => CloudHub | null;
  readonly forget: (id: string) => void;
  readonly load: () => SavedAccount | null;
  readonly save: (account: SavedAccount | null) => void;
  readonly waitMs?: number;
}

const failed = (code: string, message: string, fix?: string): { ok: false; failure: PairFailure } => ({
  ok: false,
  failure: { code, message, ...(fix === undefined ? {} : { fix }) },
});

const Refusal = z.object({ code: z.string(), message: z.string().min(1).max(500), fix: z.string().max(500).optional() });

const OFFLINE = failed("offline", "This computer can't reach fleetd.", "Check your connection, then sign in again.");

const UNREADABLE = failed("", "fleetd's sign-in answered in a way this app doesn't understand.", "Update the app, then sign in again.");

/** The service's refusal in its own words, else its status. */
const refusal = (json: unknown, status: number): { ok: false; failure: PairFailure } => {
  const r = Refusal.safeParse(json);
  return r.success ? failed(r.data.code, r.data.message, r.data.fix) : failed("", `fleetd's sign-in answered HTTP ${String(status)}.`, "Try again in a moment.");
};

/** A sign-in's answer, until the person says it's them. */
interface Held {
  readonly config: CloudConfig;
  readonly answer: SignedIn;
  readonly deviceName: string;
}

type Answer = { kind: "code"; code: string } | { kind: "refused"; error: string } | { kind: "cancelled" } | { kind: "timeout" };

const send = (res: ServerResponse, status: number, html: string): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

/** WorkOS's sign-in page for this app, with PKCE and the loopback redirect. `max_age=0` (WorkOS's documented way) and
 * `prompt=login` make AuthKit ask every time: without them, a browser already signed in to AuthKit came straight back
 * with a code, so any local program that opened this page got a session without the person doing anything. */
export const authorizeUrl = (config: CloudConfig, p: { redirect: string; challenge: string; state: string }): string => {
  const q = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: p.redirect,
    response_type: "code",
    provider: "authkit",
    prompt: "login",
    max_age: "0",
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  });
  return `${config.authorizeUrl}?${q.toString()}`;
};

export class CloudAccount {
  readonly #ports: CloudPorts;
  #pending: { readonly end: (answer: Answer) => void; url: string | null } | null = null;
  #account: SavedAccount | null;
  #held: Held | null = null;

  constructor(ports: CloudPorts) {
    this.#ports = ports;
    this.#account = ports.config === null ? null : ports.load();
  }

  state(): { available: boolean; email: string | null } {
    return { available: this.#ports.config !== null, email: this.#account?.email ?? null };
  }

  /** Not them: the answer held goes, and its session ends; nothing was connected. */
  async notMe(): Promise<void> {
    const held = this.#held;
    this.#held = null;
    if (held !== null) await this.#endSession(held.config, held.answer.sessionId);
  }

  /** The sign-in page under way, for "Copy the sign-in link"; null when none is. */
  link(): string | null {
    return this.#pending?.url ?? null;
  }

  /** Shows the page under way again. */
  async reopen(): Promise<void> {
    const url = this.link();
    if (url !== null) await this.#ports.open(url).catch(() => undefined);
  }

  cancel(): void {
    this.#pending?.end({ kind: "cancelled" });
  }

  async signIn(): Promise<SignInOutcome> {
    const config = this.#ports.config;
    if (config === null) return failed("", "This app isn't set up to sign in to fleetd.");
    this.cancel();
    void this.notMe();
    let end: (answer: Answer) => void = () => undefined;
    let ended: Answer | undefined;
    const answer = new Promise<Answer>((resolve) => {
      end = (a) => {
        ended ??= a;
        resolve(a);
      };
    });
    const pending = { end: (a: Answer) => end(a), url: null as string | null };
    this.#pending = pending;
    let server: Server | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let answered: ServerResponse | undefined;
    const finish = (title: string, line: string): void => {
      if (answered !== undefined) send(answered, 200, landing(title, line));
      answered = undefined;
    };
    // The listener's own host, once bound: a request naming any other (a page that rebound its name to 127.0.0.1) is refused.
    let host = "";
    try {
      // Here, not at the top: importing node:http costs Electron's main process ~10 ms of every launch.
      const { createServer } = await import("node:http");
      const { verifier, challenge } = pkce();
      const state = randomBytes(16).toString("base64url");
      const listener = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (host === "" || req.headers.host !== host) {
          send(res, 400, landing("Nothing here", "This address is fleetd's, for the sign-in's answer only."));
          return;
        }
        if (req.method !== "GET" || url.pathname !== ACCOUNTS_LOOPBACK_PATH || answered !== undefined || ended !== undefined) {
          send(res, 404, landing("Nothing here", "This address is fleetd's, for the sign-in's answer only."));
          return;
        }
        if (url.searchParams.get("state") !== state) {
          send(res, 400, landing("This isn't fleetd's sign-in", "Go back to fleetd and sign in again."));
          return;
        }
        answered = res;
        const code = url.searchParams.get("code");
        end(code === null || code === "" ? { kind: "refused", error: url.searchParams.get("error") ?? "no_code" } : { kind: "code", code });
      });
      server = listener;
      const port = await new Promise<number | null>((resolve) => {
        listener.once("error", () => resolve(null));
        listener.listen(0, "127.0.0.1", () => resolve((listener.address() as AddressInfo).port));
      });
      if (port === null) return failed("", "fleetd couldn't listen on this computer for the sign-in's answer.", "Try again; a firewall that blocks 127.0.0.1 stops it.");
      if (ended?.kind === "cancelled") return { ok: false, cancelled: true };
      host = `127.0.0.1:${String(port)}`;
      const redirect = `http://127.0.0.1:${String(port)}${ACCOUNTS_LOOPBACK_PATH}`;
      const page = authorizeUrl(config, { redirect, challenge, state });
      pending.url = page;
      // A browser that didn't open leaves the page's link to copy, so it waits either way.
      await this.#ports.open(page).catch(() => undefined);
      timer = setTimeout(() => end({ kind: "timeout" }), this.#ports.waitMs ?? WAIT_MS);
      const a = await answer;
      if (a.kind === "cancelled") return { ok: false, cancelled: true };
      if (a.kind === "timeout") return failed("timeout", "The sign-in page wasn't finished, so it ran out after 10 minutes.");
      if (a.kind === "refused") {
        finish("Not signed in", "You can close this tab and go back to fleetd.");
        return failed("refused", "The browser came back without signing you in.", "Nothing was changed. Sign in again.");
      }
      const out = await this.#exchange(config, { code: a.code, codeVerifier: verifier, redirectUri: redirect, deviceName: this.#ports.deviceName() });
      if (out.ok) finish("Signed in to fleetd", "You can close this tab and go back to fleetd to finish.");
      else if (!out.cancelled) finish("Not signed in", `${out.failure.message} Go back to fleetd to try again.`);
      return out;
    } finally {
      clearTimeout(timer);
      if (this.#pending === pending) this.#pending = null;
      finish("Not signed in", "You can close this tab and go back to fleetd.");
      server?.close();
      server?.closeIdleConnections();
    }
  }

  /** The accounts service's answer, held for finish: nothing is connected yet. */
  async #exchange(config: CloudConfig, body: { code: string; codeVerifier: string; redirectUri: string; deviceName: string }): Promise<SignInOutcome> {
    let response: Response;
    try {
      response = await this.#post(config, ACCOUNTS_SIGN_IN_PATH, body);
    } catch {
      return OFFLINE;
    }
    const json = await readJson(response);
    if (!response.ok) return refusal(json, response.status);
    const answer = readSignIn(json);
    if (answer === null) return UNREADABLE;
    if (answer.teams.length === 0 && answer.invitations.length === 0) {
      void this.#endSession(config, answer.sessionId);
      return failed("", "No team of this account could be connected.");
    }
    this.#held = { config, answer, deviceName: body.deviceName };
    return {
      ok: true,
      arrival: { email: answer.email, invitations: answer.invitations.map(({ name, invitedBy, role }) => ({ name: cleanLabel(name) ?? "fleetd", invitedBy, role })) },
    };
  }

  /**
   * It's them: a key from each team's /pair, and from each invitation in `join` (by its place) once the service has
   * joined it. Each key this replaces is revoked on its team first, and when the account changed, the previous one's
   * teams this sign-in didn't bring are revoked and dropped. With nothing connected, the session ends and nothing is kept.
   */
  async finish(join: readonly number[]): Promise<FinishOutcome> {
    const held = this.#held;
    this.#held = null;
    if (held === null) return failed("", "That sign-in isn't waiting any more.", "Sign in again.");
    const { config, answer, deviceName } = held;
    const outcomes: TeamOutcome[] = [];
    const paired = new Set<string>();
    const pairOne = async (team: AccountsTeam, accepted: boolean) => {
      const out = await this.#pairTeam(config, team, deviceName, !madeTeam(team, accepted));
      outcomes.push(out.outcome);
      if (out.origin !== null) paired.add(out.origin);
    };
    for (const team of answer.teams) await pairOne(team, false);
    for (const at of [...new Set(join)]) {
      const invitation = answer.invitations[at];
      if (invitation === undefined) continue;
      const joined = await this.#accept(config, invitation.accept);
      if (joined.ok) await pairOne(joined.team, true);
      else outcomes.push({ name: cleanLabel(invitation.name) ?? "fleetd", ok: false, failure: joined.failure });
    }
    if (!outcomes.some((t) => t.ok)) {
      void this.#endSession(config, answer.sessionId);
      const first = outcomes[0];
      if (first === undefined) return failed("none_joined", "You didn't join a team, so you aren't signed in.", "Sign in again when you want to join it.");
      return first.ok ? failed("", "No team of this account could be connected.") : { ok: false, failure: first.failure };
    }
    const before = this.#account;
    this.#account = { email: answer.email, sessionId: answer.sessionId };
    this.#ports.save(this.#account);
    // A new sign-in replaces the one kept: that session ends, as signing out would end it, and another account's
    // teams leave this app as they would at its sign-out.
    if (before !== null && before.sessionId !== answer.sessionId) void this.#endSession(config, before.sessionId);
    if (before !== null && before.email !== answer.email) {
      const gone = this.#ports.cloudHubs().filter((hub) => hub.url === null || !paired.has(hub.url));
      await Promise.all(
        gone.map(async (hub) => {
          await revokeOwnKey(hub).catch(() => false);
          this.#ports.forget(hub.id);
        }),
      );
    }
    return { ok: true, email: answer.email, teams: outcomes };
  }

  /** The service joins an invitation the person chose, and answers the team with its pairing code. */
  async #accept(config: CloudConfig, accept: string): Promise<{ ok: true; team: AccountsTeam } | { ok: false; failure: PairFailure }> {
    let response: Response;
    try {
      response = await this.#post(config, ACCOUNTS_ACCEPT_PATH, { accept });
    } catch {
      return OFFLINE;
    }
    const json = await readJson(response);
    if (!response.ok) return refusal(json, response.status);
    const team = readAccepted(json);
    return team === null ? UNREADABLE : { ok: true, team };
  }

  #post(config: CloudConfig, path: string, body: unknown): Promise<Response> {
    return this.#ports.fetch(`${config.accountsUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      redirect: "error",
    });
  }

  async #pairTeam(config: CloudConfig, team: AccountsTeam, deviceName: string, invited: boolean): Promise<{ outcome: TeamOutcome; origin: string | null }> {
    const name = cleanLabel(team.name) ?? "fleetd";
    const origin = teamOrigin(team.url, config.accountsUrl, this.#ports.local);
    if (origin === null) return { origin, outcome: { name, ok: false, failure: { code: "", message: `${name}'s address isn't one this app connects to.`, fix: "Update the app, then sign in again." } } };
    const paired = await redeem(this.#ports.fetch, origin, team.pairingCode, deviceName);
    if (!paired.ok) {
      // /pair's own words assume a hub of your own; a team's code comes from signing in.
      const failure =
        paired.failure.code === ""
          ? { code: "offline", message: `Can't reach ${name}.`, fix: "Check your connection, then sign in again." }
          : { code: paired.failure.code, message: `${name} refused this app's code: ${paired.failure.message}`, fix: "Sign in again for a new code." };
      return { origin: null, outcome: { name, ok: false, failure } };
    }
    // The key this one replaces leaves the team too, not only this app: a failed revoke doesn't stop the sign-in.
    const held = this.#ports.heldAt(origin);
    if (held !== null) await revokeOwnKey(held).catch(() => false);
    const connected = this.#ports.connect(origin, paired.paired.key, cleanLabel(paired.paired.hubName) ?? name, invited);
    return connected.ok
      ? { origin, outcome: { name, ok: true } }
      : { origin: null, outcome: { name, ok: false, failure: { code: "", message: `Got a key for ${name}, but it couldn't be kept: ${connected.message}`, fix: "Sign in again." } } };
  }

  /** Each of the account's hubs drops this device's key and leaves the app, then WorkOS's session ends. */
  async signOut(): Promise<SignOutOutcome> {
    this.cancel();
    await this.notMe();
    const kept: string[] = [];
    await Promise.all(
      this.#ports.cloudHubs().map(async (hub) => {
        if (!(await revokeOwnKey(hub))) kept.push(hub.label);
        this.#ports.forget(hub.id);
      }),
    );
    const account = this.#account;
    this.#account = null;
    this.#ports.save(null);
    if (account !== null && this.#ports.config !== null) await this.#endSession(this.#ports.config, account.sessionId);
    return { kept: kept.sort() };
  }

  async #endSession(config: CloudConfig, sessionId: string): Promise<void> {
    await this.#post(config, ACCOUNTS_SIGN_OUT_PATH, { sessionId }).catch(() => undefined);
  }
}

/**
 * This device's own key on `hub`, revoked there (Devices' Sign out on itself). A hub never answers that call: revoking
 * the key closes the very socket it came on (4401), so the call fails and the hub then refuses the key, which is the
 * revoke done. False when the hub couldn't be asked, or refused the revoke itself.
 */
const revokeOwnKey = async (hub: CloudHub): Promise<boolean> => {
  const people = await hub.call("people_list", {});
  const keyId = people.ok ? (people.output as { thisDevice?: unknown }).thisDevice : undefined;
  if (typeof keyId !== "string") return false;
  const revoked = await hub.call("device_revoke", { keyId });
  return revoked.ok || hub.refused();
};
