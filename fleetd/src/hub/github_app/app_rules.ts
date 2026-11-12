// The hub's GitHub App as GitHub sees it, without the database (index.ts keeps it): what it asks for, its manifest and
// the page that takes it, its JWT, and what a Test of it says.
import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import type { GithubApp, GithubAppTest } from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";

/** What the App asks for on each repository (contracts `GITHUB_APP_PERMISSIONS`). */
export const GITHUB_APP_PERMISSIONS: [string, string][] = [
  ["contents", "write"],
  ["pull_requests", "write"],
  ["issues", "write"],
  ["workflows", "write"],
  ["statuses", "write"],
  ["actions", "write"],
  ["checks", "read"],
  ["metadata", "read"],
];
/** The variable an agent's `gh` takes its token from. */
export const GITHUB_TOKEN_ENV = "GH_TOKEN";
/** The refusal for a writer whose order's starter hasn't connected GitHub, on a repository the App reaches. */
export const GITHUB_CONNECT_REFUSAL = "Connect your GitHub to open this order's PRs.";

/** Where the App's people sign in: GitHub takes any port on a loopback callback. */
export const USER_CALLBACK = "http://127.0.0.1/github/callback";

/** Where GitHub answers. Tests point both at one fake server. */
export type Endpoints = { api: string; web: string };
export const DEFAULT_ENDPOINTS: Endpoints = { api: "https://api.github.com", web: "https://github.com" };

/** The manifest for an App named `name`, whose homepage is the hub and which sends the admin back to `redirect`. */
export function manifest(name: string, hubUrl: string, redirect: string): Record<string, unknown> {
  return {
    name,
    url: hubUrl,
    redirect_url: redirect,
    callback_urls: [USER_CALLBACK],
    request_oauth_on_install: false,
    public: false,
    default_permissions: Object.fromEntries(GITHUB_APP_PERMISSIONS),
    default_events: [],
  };
}

/** GitHub's page that takes the manifest: an organization's, or the admin's own account's. */
export function newAppPage(web: string, organization?: string): string {
  return organization === undefined ? `${web}/settings/apps/new` : `${web}/organizations/${organization}/settings/apps/new`;
}

/** The RSA key of the App's PEM private key: PKCS #1, as GitHub makes it, or PKCS #8. */
export function signer(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new Error("the App's private key isn't PEM");
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error("the App's private key isn't an RSA key GitHub made");
  return key;
}

export const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

/** The App's JWT (RS256), good for nine minutes from a minute ago, as GitHub asks. */
export function jwt(pem: string, appId: number, nowS: number): string {
  const key = signer(pem);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat: nowS - 60, exp: nowS + 540, iss: String(appId) }));
  const signed = `${head}.${claims}`;
  let signature: Buffer;
  try {
    signature = sign("sha256", Buffer.from(signed), key);
  } catch {
    throw new Error("the App's private key couldn't sign");
  }
  return `${signed}.${b64url(signature)}`;
}

/** What a read of the App's installations says as its last Test: where it is installed, and any GitHub refused. */
export function readTest(read: GithubApp, skipped: string[], nowMs: number): GithubAppTest {
  let line = installedLine(read);
  if (skipped.length > 0) line += ` GitHub refused its installation on ${skipped.join(", ")}.`;
  const ok = (read.installations ?? []).length > 0 && skipped.length === 0;
  return testSaid(ok, line, nowMs);
}

export function testSaid(ok: boolean, text: string, nowMs: number): GithubAppTest {
  return { at: isoMs(nowMs), ok, said: [...text].slice(0, 1000).join("") };
}

/** What a passing Test says: where the App is installed and that its tokens work. */
export function installedLine(app: GithubApp): string {
  const installs = app.installations ?? [];
  if (installs.length === 0) {
    return `GitHub knows "${app.name}", but it isn't installed anywhere yet: install it on the repositories fleetd works on.`;
  }
  const places = installs.map((i) => {
    const n = i.repositoryCount;
    const what = i.allRepositories ? `all ${n} repositories` : n === 1 ? "1 repository" : `${n} repositories`;
    return `${i.account} (${what})`;
  });
  return `"${app.name}" is installed on ${places.join(", ")}, and its tokens work.`;
}
