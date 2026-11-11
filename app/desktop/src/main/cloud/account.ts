// Sign in to fleetd cloud (hosted-plan §4, cloud-plan §8): WorkOS's sign-in page in the system browser with PKCE,
// back to a loopback port here (as githubConnect.ts does for GitHub), then one call to the accounts service
// (contracts: Accounts.json), which redeems WorkOS's code itself and answers the person's teams, each with its
// address and a one-time pairing code. Each code goes to that team's own POST /pair, as a typed one does, and each
// key into the keychain beside any other hub's. The app keeps the email and WorkOS's session id, never a WorkOS token.
// Sign out drops this device's key on each of the account's hubs, then ends the session. One sign-in at a time: a
// new one, or Cancel, ends the one waiting.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { SignInOutcome, SignOutOutcome, TeamOutcome } from "../../shared/cloud";
import { ACCOUNTS_LOOPBACK_PATH, ACCOUNTS_SIGN_IN_PATH, ACCOUNTS_SIGN_OUT_PATH } from "../../shared/contracts";
import type { CallOutcome, ConnectOutcome } from "../../shared/hub";
import { cleanLabel } from "../../shared/hubs";
import type { PairFailure } from "../../shared/pairing";
import { landing, pkce } from "../loopback";
import { redeem, type Fetch } from "../pairing/hubHttp";
import { teamOrigin, type CloudConfig } from "./config";

/** How long the browser has to come back. */
export const WAIT_MS = 10 * 60_000;

const CALL_TIMEOUT_MS = 20_000;

/** What the app keeps of a sign-in. */
export interface SavedAccount {
  readonly email: string;
  readonly sessionId: string;
}

export const SavedAccount = z.object({ email: z.string().min(1).max(320), sessionId: z.string().min(1).max(200) });

/** A hub that came with the account: its label, and a call to it. */
export interface CloudHub {
  readonly id: string;
  readonly label: string;
  call(tool: string, input: unknown): Promise<CallOutcome>;
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
  /** Saves a team's key and connects to it, listed as one of the account's hubs under `label`. */
  readonly connect: (url: string, key: string, label: string) => ConnectOutcome;
  readonly cloudHubs: () => ReadonlyArray<CloudHub>;
  readonly forget: (id: string) => void;
  readonly load: () => SavedAccount | null;
  readonly save: (account: SavedAccount | null) => void;
  readonly waitMs?: number;
}

const failed = (code: string, message: string, fix?: string): { ok: false; failure: PairFailure } => ({
  ok: false,
  failure: { code, message, ...(fix === undefined ? {} : { fix }) },
});

const Team = z.object({ id: z.string().min(1), name: z.string().min(1).max(63), url: z.string().min(1), pairingCode: z.string().min(1) });
const SignedIn = z.object({ email: z.string().min(1).max(320), sessionId: z.string().min(1).max(200), teams: z.array(Team).min(1).max(50) });
const Refusal = z.object({ code: z.string(), message: z.string().min(1).max(500), fix: z.string().max(500).optional() });

const OFFLINE = failed("offline", "This computer can't reach fleetd.", "Check your connection, then sign in again.");

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

/** WorkOS's sign-in page for this app, with PKCE and the loopback redirect. */
export const authorizeUrl = (config: CloudConfig, p: { redirect: string; challenge: string; state: string }): string => {
  const q = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: p.redirect,
    response_type: "code",
    provider: "authkit",
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

  constructor(ports: CloudPorts) {
    this.#ports = ports;
    this.#account = ports.config === null ? null : ports.load();
  }

  state(): { available: boolean; email: string | null } {
    return { available: this.#ports.config !== null, email: this.#account?.email ?? null };
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
    try {
      // Here, not at the top: importing node:http costs Electron's main process ~10 ms of every launch.
      const { createServer } = await import("node:http");
      const { verifier, challenge } = pkce();
      const state = randomBytes(16).toString("base64url");
      const listener = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
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
      if (out.ok) finish("Signed in to fleetd", "You can close this tab and go back to fleetd.");
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

  /** The accounts service's answer, then a key from each team's /pair. */
  async #exchange(config: CloudConfig, body: { code: string; codeVerifier: string; redirectUri: string; deviceName: string }): Promise<SignInOutcome> {
    let response: Response;
    try {
      response = await this.#ports.fetch(`${config.accountsUrl}${ACCOUNTS_SIGN_IN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      return OFFLINE;
    }
    const json = await readJson(response);
    if (!response.ok) {
      const refusal = Refusal.safeParse(json);
      return refusal.success
        ? failed(refusal.data.code, refusal.data.message, refusal.data.fix)
        : failed("", `fleetd's sign-in answered HTTP ${String(response.status)}.`, "Try again in a moment.");
    }
    const signedIn = SignedIn.safeParse(json);
    if (!signedIn.success) return failed("", "fleetd's sign-in answered in a way this app doesn't understand.", "Update the app, then sign in again.");
    const { email, sessionId, teams } = signedIn.data;
    // A new sign-in replaces the one kept: that session ends, as signing out would end it.
    const before = this.#account;
    const outcomes: TeamOutcome[] = [];
    for (const team of teams) outcomes.push(await this.#pairTeam(team, body.deviceName));
    if (!outcomes.some((t) => t.ok)) {
      void this.#endSession(config, sessionId);
      const first = outcomes[0];
      return first === undefined || first.ok ? failed("", "No team of this account could be connected.") : { ok: false, failure: first.failure };
    }
    this.#account = { email, sessionId };
    this.#ports.save(this.#account);
    if (before !== null && before.sessionId !== sessionId) void this.#endSession(config, before.sessionId);
    return { ok: true, email, teams: outcomes };
  }

  async #pairTeam(team: z.infer<typeof Team>, deviceName: string): Promise<TeamOutcome> {
    const name = cleanLabel(team.name) ?? "fleetd";
    const origin = teamOrigin(team.url, this.#ports.local);
    if (origin === null) return { name, ok: false, failure: { code: "", message: `${name}'s address isn't one this app connects to.`, fix: "Update the app, then sign in again." } };
    const paired = await redeem(this.#ports.fetch, origin, team.pairingCode, deviceName);
    if (!paired.ok) {
      // /pair's own words assume a hub of your own; a team's code comes from signing in.
      const failure =
        paired.failure.code === ""
          ? { code: "offline", message: `Can't reach ${name}.`, fix: "Check your connection, then sign in again." }
          : { code: paired.failure.code, message: `${name} refused this app's code: ${paired.failure.message}`, fix: "Sign in again for a new code." };
      return { name, ok: false, failure };
    }
    const connected = this.#ports.connect(origin, paired.paired.key, cleanLabel(paired.paired.hubName) ?? name);
    return connected.ok ? { name, ok: true } : { name, ok: false, failure: { code: "", message: `Got a key for ${name}, but it couldn't be kept: ${connected.message}`, fix: "Sign in again." } };
  }

  /** Each of the account's hubs drops this device's key and leaves the app, then WorkOS's session ends. */
  async signOut(): Promise<SignOutOutcome> {
    this.cancel();
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
    await this.#ports
      .fetch(`${config.accountsUrl}${ACCOUNTS_SIGN_OUT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        redirect: "error",
      })
      .catch(() => undefined);
  }
}

/** This device's own key on `hub`, revoked there (Devices' Sign out on itself). False when the hub couldn't be asked. */
const revokeOwnKey = async (hub: CloudHub): Promise<boolean> => {
  const people = await hub.call("people_list", {});
  const keyId = people.ok ? (people.output as { thisDevice?: unknown }).thisDevice : undefined;
  if (typeof keyId !== "string") return false;
  const revoked = await hub.call("device_revoke", { keyId });
  return revoked.ok;
};
