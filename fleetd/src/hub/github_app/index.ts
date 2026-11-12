// The hub's own GitHub App (D190, contracts `github_app`). The admin creates
// it through GitHub's manifest flow: a loopback page (the desktop app's, or `fleetd github-app create`'s) posts
// `manifest` to GitHub, and GitHub sends the admin back there with a code, which `GithubApps.create` trades for the
// App's id, private key and secrets. They go from GitHub to the hub only, sealed at once to the hub's own box key
// (`<hub home>/node-box-key.pem`) in the `github_app` row; nothing returns or logs them.
//
// `GithubApps.tokenFor` gives the hub's `gh` an installation token for a repository the App is installed on (gh.ts):
// it signs a JWT with the private key, reads the App's installations every few minutes, and mints each installation's
// token an hour at a time. Any other repository, or no token to be had, leaves `gh` on the hub machine's own login,
// as before the App; so does a run GitHub refuses to the App itself (gh.ts).
import type { GithubApp, GithubInstallation } from "../../shared/contracts.ts";
import { loadOrCreateBoxKey, openSealed, publicKeyOf, seal } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { isoMs, parseMs } from "../train/seams.ts";
import { Mutex } from "../train/mutex.ts";
import { DEFAULT_ENDPOINTS, type Endpoints, jwt, readTest, signer, testSaid } from "./app_rules.ts";

export { DEFAULT_ENDPOINTS, type Endpoints, GITHUB_APP_PERMISSIONS, GITHUB_CONNECT_REFUSAL, GITHUB_TOKEN_ENV, jwt, manifest, newAppPage, USER_CALLBACK } from "./app_rules.ts";

/** Each call to GitHub. */
const TIMEOUT_MS = 30_000;
/** How often the App's installations and their repositories are read again. */
const REFRESH_MS = 10 * 60_000;
/** After a failed read, how long `gh` stays on the machine's login before the App is tried again. */
const RETRY_MS = 60_000;
/** A token this close to its end is minted again. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** The repositories read per installation with chosen ones: 10 pages of 100. */
const REPO_PAGES = 10;

// --- the `github_app` row ---

type AppRow = { data: string; sealed_key: Uint8Array };

export const appStore = {
  get(hub: Hub): GithubApp | undefined {
    const row = hub.db.conn.query<{ data: string }, []>("SELECT data FROM github_app WHERE id = 1").get();
    return row ? parse<GithubApp>(row.data) : undefined;
  },
  withKey(hub: Hub): { app: GithubApp; sealed: Uint8Array } | undefined {
    const row = hub.db.conn.query<AppRow, []>("SELECT data, sealed_key FROM github_app WHERE id = 1").get();
    const app = row ? parse<GithubApp>(row.data) : undefined;
    return row && app ? { app, sealed: new Uint8Array(row.sealed_key) } : undefined;
  },
  put(hub: Hub, app: GithubApp, sealed: Sealed): void {
    hub.db.conn
      .query(
        `INSERT INTO github_app (id, data, sealed_key, sealed_client_secret, sealed_webhook_secret)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET data = excluded.data, sealed_key = excluded.sealed_key,
             sealed_client_secret = excluded.sealed_client_secret,
             sealed_webhook_secret = excluded.sealed_webhook_secret`,
      )
      .run(JSON.stringify(app), sealed.key, sealed.clientSecret ?? null, sealed.webhookSecret ?? null);
  },
  /** Updates what the hub read about the same App; false when it is gone or another took its place meanwhile. */
  update(hub: Hub, app: GithubApp): boolean {
    return hub.db.transaction((c) => {
      const now = c.query<{ data: string }, []>("SELECT data FROM github_app WHERE id = 1").get();
      const same = now !== null && parse<GithubApp>(now.data)?.appId === app.appId;
      if (same) c.query("UPDATE github_app SET data = ? WHERE id = 1").run(JSON.stringify(app));
      return same;
    });
  },
  remove(hub: Hub): GithubApp | undefined {
    const app = appStore.get(hub);
    hub.db.conn.run("DELETE FROM github_app WHERE id = 1");
    return app;
  },
};

function parse<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}

/** What GitHub handed over, each sealed to the hub's box key. */
type Sealed = { key: Uint8Array; clientSecret?: Uint8Array; webhookSecret?: Uint8Array };

type Token = { value: string; expiresMs: number };

type Install = {
  id: number;
  /** Lowercase, as repositories are matched. */
  account: string;
  all: boolean;
  /** `owner/name`, lowercase. */
  repos: Set<string>;
  token?: Token;
};

type Cache = { appId?: number; readMs: number; failedMs?: number; installs: Install[] };
const emptyCache = (): Cache => ({ readMs: 0, installs: [] });

/** One installation's reach: its account (lowercase), whether it takes all its repositories, and which. */
type Reach = { account: string; all: boolean; repos: Set<string> };

/** GitHub's own words for a refusal: its `message`, else the status. */
function said(status: number, body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === "string" && message !== "" ? message : `HTTP ${status}`;
}

/** Whether a call failed for GitHub not answering (unreachable, or a 5xx), not for refusing. */
const unanswered = (error: string) => error.startsWith("GitHub can't be reached") || error.startsWith("GitHub refused (5");

/** Thrown with GitHub's reason; its message is what the tools say. */
export class GithubError extends Error {}

const fail = (message: string): never => {
  throw new GithubError(message);
};

/** The hub's App: creating it, and its tokens. `githubApps(hub)`. */
export class GithubApps {
  private ep: Endpoints = DEFAULT_ENDPOINTS;
  private cache: Cache = emptyCache();
  /** One read of the installations at a time. */
  private readonly refreshing = new Mutex();
  /** Where the App reaches, as its installations were last read, whole: read by `reaches` with no call to GitHub. */
  private reach: { appId: number; installs: Reach[] } | undefined;
  /** One change to people's tokens at a time: a refresh renews the refresh token too. */
  readonly accounts = new Mutex();
  /** The orders' token problems last logged (sessions.ts): each is logged again only once it changes. */
  readonly warned = new Map<string, string>();

  constructor(readonly hub: Hub) {}

  /** Points every call at other endpoints: a fake GitHub in tests. */
  setEndpoints(ep: Endpoints): void {
    this.ep = ep;
  }

  endpoints(): Endpoints {
    return this.ep;
  }

  get(): GithubApp | undefined {
    return appStore.get(this.hub);
  }

  nowMs(): number {
    return this.hub.clock.now();
  }

  boxKey(): Uint8Array {
    try {
      return loadOrCreateBoxKey(this.hub.config.home);
    } catch (error) {
      console.error("hub box key:", error);
      return fail("the hub can't read its box key: check the hub's home directory");
    }
  }

  seal(plain: string): Uint8Array {
    return seal(publicKeyOf(this.boxKey()), new TextEncoder().encode(plain));
  }

  /** The text sealed in `sealed`, or undefined when it wasn't sealed to the hub's box key. */
  open(sealed: Uint8Array): string | undefined {
    const plain = openSealed(this.boxKey(), sealed);
    return plain ? new TextDecoder().decode(plain) : undefined;
  }

  /** One call to GitHub's API: the answer's JSON, or GitHub's reason (thrown). */
  async call(method: string, path: string, bearer?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "fleetd",
    };
    if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
    let answer: Response;
    try {
      answer = await fetch(`${this.ep.api}${path}`, { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      return fail(`GitHub can't be reached: ${(error as Error).message}`);
    }
    const body: unknown = await answer.json().catch(() => null);
    if (answer.ok) return body;
    return fail(`GitHub refused (${answer.status}): ${said(answer.status, body)}`);
  }

  /** Trades the manifest flow's code for the App, keeps it with its secrets sealed, and says what it keeps. */
  async create(code: string): Promise<GithubApp> {
    let body: Record<string, unknown>;
    try {
      body = ((await this.call("POST", `/app-manifests/${code}/conversions`)) ?? {}) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GithubError && error.message.includes("(404)")) {
        return fail("GitHub doesn't know that code: each one is used once, within an hour. Create the App again");
      }
      throw error;
    }
    const take = (k: string) => {
      const v = body[k];
      delete body[k];
      return typeof v === "string" && v !== "" ? v : undefined;
    };
    const pem = take("pem") ?? fail("GitHub sent the App without its private key");
    const clientSecret = take("client_secret");
    const webhookSecret = take("webhook_secret");
    // Proves the key before keeping it: one that can't sign would only fail later, unseen.
    try {
      signer(pem);
    } catch (error) {
      return fail((error as Error).message);
    }
    const text = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    const appId = typeof body.id === "number" ? body.id : fail("GitHub sent the App without its id");
    const ownerOf = (body.owner ?? {}) as { login?: unknown; type?: unknown };
    const owner = typeof ownerOf.login === "string" ? ownerOf.login : "";
    const web = this.ep.web;
    const settingsUrl =
      ownerOf.type === "Organization"
        ? `${web}/organizations/${owner}/settings/apps/${text("slug")}`
        : `${web}/settings/apps/${text("slug")}`;
    const line = (v: string, what: string) => (v.trim() !== "" ? v : fail(`GitHub sent the App without its ${what}`));
    const app: GithubApp = {
      appId,
      slug: line(text("slug"), "slug"),
      name: line(text("name"), "name"),
      clientId: line(text("client_id"), "client ID"),
      owner: line(owner, "owner"),
      htmlUrl: line(text("html_url"), "page"),
      settingsUrl,
      createdAt: isoMs(this.nowMs()),
      installations: [],
    };
    const sealed: Sealed = { key: this.seal(pem) };
    if (clientSecret !== undefined) sealed.clientSecret = this.seal(clientSecret);
    if (webhookSecret !== undefined) sealed.webhookSecret = this.seal(webhookSecret);
    appStore.put(this.hub, app, sealed);
    this.cache = emptyCache();
    return app;
  }

  /** The App and its private key, opened; undefined without an App. */
  opened(): { app: GithubApp; pem: string } | undefined {
    const kept = appStore.withKey(this.hub);
    if (!kept) return undefined;
    const pem =
      this.open(kept.sealed) ??
      fail("the App's key was sealed to another box key: the hub's home changed. Create the App again");
    return { app: kept.app, pem };
  }

  private jwtFor(app: GithubApp, pem: string): string {
    try {
      return jwt(pem, app.appId, Math.floor(this.nowMs() / 1000));
    } catch (error) {
      return fail((error as Error).message);
    }
  }

  private async mint(token: string, id: number): Promise<Token> {
    const body = ((await this.call("POST", `/app/installations/${id}/access_tokens`, token)) ?? {}) as Record<string, unknown>;
    const expires = typeof body.expires_at === "string" ? parseMs(body.expires_at) : undefined;
    const value = body.token;
    if (typeof value !== "string" || value === "") return fail("GitHub sent no installation token");
    return { value, expiresMs: expires ?? this.nowMs() + 60 * 60_000 };
  }

  /**
   * Reads the App's installations, mints each one's token and reads the repositories each reaches. An installation
   * GitHub refuses (suspended, or uninstalled mid-read) is left out and said; one GitHub fails to answer for (down, or a
   * 5xx) fails the read, so what was read before stays.
   */
  private async readInstalls(app: GithubApp, pem: string): Promise<{ installs: Install[]; read: GithubApp; skipped: string[] }> {
    const token = this.jwtFor(app, pem);
    const listed = await this.call("GET", "/app/installations?per_page=100", token);
    const installs: Install[] = [];
    const seen: GithubInstallation[] = [];
    const skipped: string[] = [];
    for (const i of Array.isArray(listed) ? (listed as Record<string, unknown>[]) : []) {
      if (typeof i.id !== "number" || !Number.isInteger(i.id)) continue;
      const id = i.id;
      const accountLogin = (i.account as { login?: unknown } | undefined)?.login;
      const account = typeof accountLogin === "string" ? accountLogin : "";
      const all = i.repository_selection === "all";
      let minted: Token;
      const repos: string[] = [];
      let count = 0;
      try {
        minted = await this.mint(token, id);
        for (let page = 1; page <= REPO_PAGES; page++) {
          const body = ((await this.call("GET", `/installation/repositories?per_page=100&page=${page}`, minted.value)) ??
            {}) as { total_count?: unknown; repositories?: unknown };
          count = typeof body.total_count === "number" ? body.total_count : 0;
          const names = (Array.isArray(body.repositories) ? (body.repositories as { full_name?: unknown }[]) : [])
            .map((r) => r.full_name)
            .filter((n): n is string => typeof n === "string");
          repos.push(...names);
          if (names.length < 100 || all) break;
        }
      } catch (error) {
        const e = (error as Error).message;
        if (unanswered(e)) throw error;
        console.warn(`github app: installation on ${account} not read: ${e}`);
        skipped.push(`${account} (${e})`);
        continue;
      }
      seen.push({
        installationId: id,
        account,
        allRepositories: all,
        repositoryCount: count,
        repositories: all ? [] : repos.slice(0, 100),
      });
      installs.push({ id, account: account.toLowerCase(), all, repos: new Set(repos.map((r) => r.toLowerCase())), token: minted });
    }
    return { installs, read: { ...app, installations: seen }, skipped };
  }

  /** Keeps what `readInstalls` read: in the cache, and on the App. */
  private keep(appId: number, installs: Install[], read: GithubApp): void {
    this.reach = { appId, installs: installs.map((i) => ({ account: i.account, all: i.all, repos: i.repos })) };
    this.cache = { appId, readMs: this.nowMs(), installs };
    try {
      appStore.update(this.hub, read);
    } catch (error) {
      console.warn("github app: installations not kept:", error);
    }
  }

  /** An installation token for `repo` (`owner/name`) when the App is installed on it; undefined otherwise. */
  async tokenFor(repo: string): Promise<string | undefined> {
    return (await this.installationToken(repo, TOKEN_MARGIN_MS))?.token;
  }

  /** `tokenFor` with at least `marginMs` left, and when it ends. */
  async installationToken(rawRepo: string, marginMs: number): Promise<{ token: string; expiresMs: number } | undefined> {
    const repo = rawRepo.toLowerCase();
    const slash = repo.indexOf("/");
    if (slash < 0) return undefined;
    const owner = repo.slice(0, slash);
    let opened: { app: GithubApp; pem: string } | undefined;
    try {
      opened = this.opened();
    } catch (error) {
      console.warn(`github app: ${(error as Error).message}`);
      return undefined;
    }
    if (!opened) {
      this.cache = emptyCache();
      return undefined;
    }
    const { app, pem } = opened;
    const now = this.nowMs();
    const stale = this.cache.appId !== app.appId || now - this.cache.readMs > REFRESH_MS;
    const due = stale && !(this.cache.failedMs !== undefined && now - this.cache.failedMs < RETRY_MS);
    // One read at a time; the others go on with what the cache holds, or the machine's login.
    const one = due ? this.refreshing.tryLock() : undefined;
    if (one) {
      try {
        const { installs, read, skipped } = await this.readInstalls(app, pem);
        // A read that works is as good as a Test: a failed one before it no longer stands.
        read.lastTest = readTest(read, skipped, this.nowMs());
        this.keep(app.appId, installs, read);
      } catch (error) {
        console.warn(`github app: installations not read: ${(error as Error).message}`);
        this.cache.failedMs = now;
      } finally {
        one();
      }
    }
    if (this.cache.appId !== app.appId) return undefined;
    const install = this.cache.installs.find((i) => i.account === owner && (i.all || i.repos.has(repo)));
    if (!install) return undefined;
    if (install.token && install.token.expiresMs - now > marginMs) {
      return { token: install.token.value, expiresMs: install.token.expiresMs };
    }
    const id = install.id;
    let minted: Token | undefined;
    let why = "";
    try {
      minted = await this.mint(this.jwtFor(app, pem), id);
    } catch (error) {
      why = (error as Error).message;
    }
    const kept = this.cache.installs.find((i) => i.id === id);
    if (!kept) return undefined;
    if (minted) {
      kept.token = minted;
      return { token: minted.value, expiresMs: minted.expiresMs };
    }
    console.warn(`github app: no token for ${repo}: ${why}`);
    delete kept.token;
    return undefined;
  }

  /** Whether the App reaches `repo` (`owner/name`), as its installations were last read, with no call to GitHub. */
  reaches(rawRepo: string): boolean {
    let app: GithubApp | undefined;
    try {
      app = this.get();
    } catch {
      return false;
    }
    if (!app) return false;
    const repo = rawRepo.toLowerCase();
    const slash = repo.indexOf("/");
    if (slash < 0) return false;
    const owner = repo.slice(0, slash);
    if (this.reach && this.reach.appId === app.appId) {
      return this.reach.installs.some((i) => i.account === owner && (i.all || i.repos.has(repo)));
    }
    return (app.installations ?? []).some(
      (i) => i.account.toLowerCase() === owner && (i.allRepositories || (i.repositories ?? []).some((r) => r.toLowerCase() === repo)),
    );
  }

  /** Tests the App: GitHub knows it and takes its key, and where it is installed. Keeps and returns what it found. */
  async test(): Promise<GithubApp | undefined> {
    const done = await this.refreshing.lock();
    try {
      const opened = this.opened();
      if (!opened) return undefined;
      const { app, pem } = opened;
      let found: GithubApp;
      try {
        await this.call("GET", "/app", this.jwtFor(app, pem));
        const { installs, read, skipped } = await this.readInstalls(app, pem);
        read.lastTest = readTest(read, skipped, this.nowMs());
        this.keep(app.appId, installs, read);
        found = read;
      } catch (error) {
        this.cache.failedMs = this.nowMs();
        found = { ...app, lastTest: testSaid(false, `${(error as Error).message}.`, this.nowMs()) };
      }
      appStore.update(this.hub, found);
      return found;
    } finally {
      done();
    }
  }

  /** Forgets the App: its row and its tokens, and people's connections, which were the App's too. */
  async remove(): Promise<GithubApp | undefined> {
    this.cache = emptyCache();
    const done = await this.accounts.lock();
    try {
      // The orders' tokens stay recorded, for the sweep to take back from their agents (sessions.ts).
      this.hub.db.conn.run("DELETE FROM github_accounts");
      return appStore.remove(this.hub);
    } finally {
      done();
    }
  }
}

export const githubApps = (hub: Hub): GithubApps => hub.area("github_app", (h) => new GithubApps(h));

