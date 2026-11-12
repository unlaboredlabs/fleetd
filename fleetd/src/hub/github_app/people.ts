// Each person's own GitHub account through the hub's App (D187): the app
// opens GitHub's sign-in with PKCE and a loopback redirect, and `connect` trades the code, with the App's client
// secret, for a user-to-server token (eight hours) and its refresh token (six months, renewed with each refresh). Both
// are sealed to the hub's box key in `github_accounts`; `userToken` refreshes the pair before the access token ends.
// Disconnecting revokes the token at GitHub and forgets it.
import type { GithubAccount, GithubApp, PersonId } from "../../shared/contracts.ts";
import { isoMs } from "../train/seams.ts";
import { GithubError, type GithubApps } from "./index.ts";
import { SESSION_MARGIN_MS } from "./session_rules.ts";

export { SESSION_MARGIN_MS } from "./session_rules.ts";

/** A person's tokens as kept, still sealed. */
type Kept = { account: GithubAccount; access: Uint8Array; accessExpiresMs: number; refresh?: Uint8Array };

/** What GitHub's token endpoint answered: the pair, each with when it ends. */
type Pair = { access: string; accessExpiresMs: number; refresh?: string; refreshExpiresMs?: number };

const fail = (message: string): never => {
  throw new GithubError(message);
};

type KeptRow = { data: string; sealed_access: Uint8Array; access_expires_ms: number; sealed_refresh: Uint8Array | null };

function kept(apps: GithubApps, person: PersonId): Kept | undefined {
  const row = apps.hub.db.conn
    .query<KeptRow, [string]>(
      "SELECT data, sealed_access, access_expires_ms, sealed_refresh FROM github_accounts WHERE person_id = ?",
    )
    .get(person);
  if (!row) return undefined;
  let account: GithubAccount;
  try {
    account = JSON.parse(row.data) as GithubAccount;
  } catch {
    return undefined;
  }
  const out: Kept = { account, access: new Uint8Array(row.sealed_access), accessExpiresMs: row.access_expires_ms };
  if (row.sealed_refresh !== null) out.refresh = new Uint8Array(row.sealed_refresh);
  return out;
}

/** The person's account, as kept: no token. */
export const account = (apps: GithubApps, person: PersonId): GithubAccount | undefined => kept(apps, person)?.account;

function putAccount(apps: GithubApps, person: PersonId, acct: GithubAccount, pair: Pair): void {
  const access = apps.seal(pair.access);
  const refresh = pair.refresh === undefined ? null : apps.seal(pair.refresh);
  apps.hub.db.conn
    .query(
      `INSERT INTO github_accounts
         (person_id, data, sealed_access, access_expires_ms, sealed_refresh, refresh_expires_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (person_id) DO UPDATE SET data = excluded.data,
         sealed_access = excluded.sealed_access, access_expires_ms = excluded.access_expires_ms,
         sealed_refresh = excluded.sealed_refresh, refresh_expires_ms = excluded.refresh_expires_ms`,
    )
    .run(person, JSON.stringify(acct), access, pair.accessExpiresMs, refresh, pair.refreshExpiresMs ?? null);
}

const forgetAccount = (apps: GithubApps, person: PersonId) =>
  apps.hub.db.conn.query("DELETE FROM github_accounts WHERE person_id = ?").run(person);

/** The App with its client secret, opened; undefined without an App. */
function client(apps: GithubApps): { app: GithubApp; secret: string } | undefined {
  const row = apps.hub.db.conn
    .query<{ data: string; sealed_client_secret: Uint8Array | null }, []>(
      "SELECT data, sealed_client_secret FROM github_app WHERE id = 1",
    )
    .get();
  if (!row) return undefined;
  const app = JSON.parse(row.data) as GithubApp;
  const sealed = row.sealed_client_secret ?? fail("GitHub sent the App without its client secret: create the App again");
  const secret =
    apps.open(new Uint8Array(sealed)) ??
    fail("the App's client secret was sealed to another box key: the hub's home changed. Create the App again");
  return { app, secret };
}

/** One call to GitHub's token endpoint with the App's client. */
async function tokenCall(apps: GithubApps, form: Record<string, string>): Promise<Pair> {
  let answer: Response;
  try {
    answer = await fetch(`${apps.endpoints().web}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "fleetd" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return fail(`GitHub can't be reached: ${(error as Error).message}`);
  }
  const body = ((await answer.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  // GitHub says a refusal with 200 and an `error`.
  if (typeof body.error === "string") {
    const words = typeof body.error_description === "string" ? body.error_description : body.error;
    return fail(`GitHub refused (${body.error}): ${words}`);
  }
  if (!answer.ok) return fail(`GitHub refused (${answer.status})`);
  const now = apps.nowMs();
  const secs = (k: string) => (typeof body[k] === "number" ? now + (body[k] as number) * 1000 : undefined);
  const take = (k: string) => (typeof body[k] === "string" && body[k] !== "" ? (body[k] as string) : undefined);
  const pair: Pair = {
    access: take("access_token") ?? fail("GitHub sent no token"),
    accessExpiresMs: secs("expires_in") ?? now + 8 * 60 * 60_000,
  };
  const refresh = take("refresh_token");
  if (refresh !== undefined) pair.refresh = refresh;
  const refreshEnds = secs("refresh_token_expires_in");
  if (refreshEnds !== undefined) pair.refreshExpiresMs = refreshEnds;
  return pair;
}

/** Trades the sign-in's code for the person's tokens, reads who they are, and keeps it all. */
export async function connect(
  apps: GithubApps,
  person: PersonId,
  code: string,
  verifier: string,
  redirect: string,
): Promise<GithubAccount> {
  const { app, secret } =
    client(apps) ?? fail("This hub has no GitHub App yet: an admin creates it in Settings › Hub › Setup › GitHub");
  const pair = await tokenCall(apps, {
    client_id: app.clientId,
    client_secret: secret,
    code,
    code_verifier: verifier,
    redirect_uri: redirect,
  });
  const user = ((await apps.call("GET", "/user", pair.access)) ?? {}) as { login?: unknown; id?: unknown };
  const login = typeof user.login === "string" && user.login.trim() !== "" ? user.login : fail("GitHub didn't say who signed in");
  const acct: GithubAccount = {
    login,
    userId: typeof user.id === "number" ? user.id : 0,
    connectedAt: isoMs(apps.nowMs()),
  };
  await apps.accounts.run(() => putAccount(apps, person, acct, pair));
  return acct;
}

/**
 * The person's access token with at least `SESSION_MARGIN_MS` left, refreshed first when it has less, and when it
 * ends. Undefined when they haven't connected. A refresh GitHub refuses marks the account lapsed.
 */
export async function userToken(apps: GithubApps, person: PersonId): Promise<{ token: string; expiresMs: number } | undefined> {
  return apps.accounts.run(async () => {
    const k = kept(apps, person);
    if (!k) return undefined;
    if (k.account.lapsed === true) {
      return fail(
        `GitHub no longer takes ${k.account.login}'s connection: connect GitHub again in Settings › Your accounts › GitHub`,
      );
    }
    const open = (sealed: Uint8Array) =>
      apps.open(sealed) ?? fail("a GitHub token was sealed to another box key: connect GitHub again");
    if (k.accessExpiresMs - apps.nowMs() > SESSION_MARGIN_MS || k.refresh === undefined) {
      return { token: open(k.access), expiresMs: k.accessExpiresMs };
    }
    const refresh = open(k.refresh);
    const { app, secret } = client(apps) ?? fail("This hub's GitHub App was removed");
    let pair: Pair;
    try {
      pair = await tokenCall(apps, {
        client_id: app.clientId,
        client_secret: secret,
        grant_type: "refresh_token",
        refresh_token: refresh,
      });
    } catch (error) {
      const e = (error as Error).message;
      // Only GitHub's word for a dead refresh token lapses it: a rate limit or an outage passes.
      if (!e.includes("bad_refresh_token")) throw error;
      const lapsed: GithubAccount = { ...k.account, lapsed: true };
      apps.hub.db.conn.query("UPDATE github_accounts SET data = ? WHERE person_id = ?").run(JSON.stringify(lapsed), person);
      return fail(
        `GitHub no longer takes ${k.account.login}'s connection (${e}): connect GitHub again in Settings › Your accounts › GitHub`,
      );
    }
    putAccount(apps, person, k.account, pair);
    return { token: pair.access, expiresMs: pair.accessExpiresMs };
  });
}

/** Revokes the person's token at GitHub (best effort) and forgets it. True when GitHub confirmed the revoke. */
export async function disconnect(apps: GithubApps, person: PersonId): Promise<boolean> {
  return apps.accounts.run(async () => {
    const k = kept(apps, person);
    if (!k) return false;
    let revoked = false;
    try {
      const c = client(apps);
      const token = c ? apps.open(k.access) : undefined;
      if (c && token !== undefined) {
        const answer = await fetch(`${apps.endpoints().api}/applications/${c.app.clientId}/grant`, {
          method: "DELETE",
          headers: {
            authorization: `Basic ${Buffer.from(`${c.app.clientId}:${c.secret}`).toString("base64")}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "user-agent": "fleetd",
          },
          body: JSON.stringify({ access_token: token }),
          signal: AbortSignal.timeout(30_000),
        });
        revoked = answer.ok;
      }
    } catch {
      revoked = false;
    }
    forgetAccount(apps, person);
    return revoked;
  });
}
