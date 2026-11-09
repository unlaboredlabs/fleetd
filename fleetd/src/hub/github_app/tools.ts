// `github_app_get` for everyone; `github_app_manifest`, `github_app_create`, `github_app_test` and `github_app_remove`
// for an owner's or admin's device (Settings › Hub accounts › GitHub); `github_connect` and `github_disconnect` for a
// person's own devices (Settings › Your accounts › GitHub). No key, secret or token crosses any of them.
import type { Person, PersonGithub, PersonId } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import * as seams from "../train/seams.ts";
import { GITHUB_APP_PERMISSIONS, githubApps, manifest, newAppPage } from "./index.ts";
import { account, connect, disconnect } from "./people.ts";
import { withdrawAll, withdrawPerson } from "./sessions.ts";

export function register(tools: Registry): void {
  tools.add("github_app_get", get);
  tools.add("github_app_manifest", async (hub, caller, input) => {
    requireAdministrator(hub, caller);
    const name = field(input, "name", /^[^\r\n]{1,34}$/);
    const redirect = field(input, "redirect", /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}(\/[A-Za-z0-9/._-]*)?$/);
    const organization = optional(input, "organization", /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
    return {
      postTo: newAppPage(githubApps(hub).endpoints().web, organization),
      manifest: JSON.stringify(manifest(name, hub.url(), redirect)),
    };
  });
  tools.add("github_app_create", async (hub, caller, input) => {
    requireAdministrator(hub, caller);
    const code = field(input, "code", CODE);
    return { app: await failing(() => githubApps(hub).create(code)) };
  });
  tools.add("github_app_test", async (hub, caller) => {
    requireAdministrator(hub, caller);
    const app = await failing(() => githubApps(hub).test());
    if (!app) throw noneYet();
    return { app };
  });
  tools.add("github_app_remove", async (hub, caller) => {
    requireAdministrator(hub, caller);
    const app = await failing(() => githubApps(hub).remove());
    // What it handed to orders' agents goes too: they use the machine's own login, as before the App.
    await withdrawAll(hub);
    if (!app) throw noneYet();
    return { settingsUrl: app.settingsUrl };
  });
  tools.add("github_connect", async (hub, caller, input) => {
    const person = me(hub, caller);
    const code = field(input, "code", CODE);
    const verifier = field(input, "codeVerifier", /^[A-Za-z0-9._~-]{43,128}$/);
    const redirect = field(input, "redirectUri", /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/github\/callback$/);
    const acct = await failing(() => connect(githubApps(hub), person, code, verifier, redirect));
    return { me: acct, next: "The PRs agents open for your orders open as you from their next turn." };
  });
  tools.add("github_disconnect", async (hub, caller) => {
    const person = me(hub, caller);
    const revoked = await failing(() => disconnect(githubApps(hub), person));
    // Their open orders' agents no longer hold it.
    await withdrawPerson(hub, person);
    const who = seams.people.get(hub.db.conn, person);
    if (who) accountRemoved(hub, { personId: who.personId, name: who.name }, "GitHub connection");
    return { revoked };
  });
}

const CODE = /^[A-Za-z0-9_-]{1,200}$/;

function field(input: unknown, name: string, pattern: RegExp): string {
  const value = (input as Record<string, unknown> | null)?.[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ToolError("invalid", `${name}: ${value === undefined ? "missing" : `must match ${pattern.source}`}`);
  }
  return value;
}

function optional(input: unknown, name: string, pattern: RegExp): string | undefined {
  return (input as Record<string, unknown> | null)?.[name] === undefined ? undefined : field(input, name, pattern);
}

/** A GitHub failure as the tool's `failed`, in GitHub's own words. */
async function failing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("failed", (error as Error).message);
  }
}

/** A person's device whose person is an owner or admin, with admin on every machine (people/tools.rs). */
export function administrator(hub: Hub, caller: Caller): Person | undefined {
  if (!isHuman(caller) || !caller.person) return undefined;
  const person = seams.people.get(hub.db.conn, caller.person.personId);
  const administers = person?.role === "owner" || person?.role === "admin";
  const everywhere = caller.grants.some((g) => g.machines === "*" && allows({ ...caller, grants: [g] }, "admin"));
  return person && administers && everywhere ? person : undefined;
}

function requireAdministrator(hub: Hub, caller: Caller): void {
  if (!administrator(hub, caller)) {
    throw new ToolError(
      "forbidden",
      "Only the hub's owners and admins set up the hub's GitHub App.",
      "Ask an owner or admin; they set it up on the Hub pages of the app's Settings, or with `fleetd github-app create` on the hub machine.",
    );
  }
}

/** The person behind a human key: only a person connects their own GitHub. */
function me(hub: Hub, caller: Caller): PersonId {
  const person = isHuman(caller) && caller.person ? seams.people.get(hub.db.conn, caller.person.personId) : undefined;
  if (!person || person.removedAt !== undefined) {
    throw new ToolError(
      "forbidden",
      "Only a person connects their own GitHub, from one of their own devices.",
      "Open Settings › Your accounts › GitHub in the desktop app.",
    );
  }
  return person.personId;
}

const noneYet = () =>
  new ToolError("not_found", "This hub has no GitHub App yet.", "Create one in Settings › Hub accounts › GitHub.");

async function get(hub: Hub, caller: Caller) {
  requireRole(caller, "read");
  const apps = githubApps(hub);
  const mine = isHuman(caller) && caller.person ? account(apps, caller.person.personId) : undefined;
  const people: PersonGithub[] = administrator(hub, caller)
    ? seams.people.active(hub.db.conn).map((p) => {
        const a = account(apps, p.personId);
        return { person: { personId: p.personId, name: p.name }, ...(a ? { account: a } : {}) };
      })
    : [];
  const app = apps.get();
  return {
    people,
    ...(app ? { app } : {}),
    ...(mine ? { me: mine } : {}),
    authorizeUrl: `${apps.endpoints().web}/login/oauth/authorize`,
    permissions: GITHUB_APP_PERMISSIONS.map(([k, v]) => [k, v] as [string, string]),
  };
}

/** `people.changed` for one of `person`'s accounts removed: every open app reads the Hub's people again. */
function accountRemoved(hub: Hub, person: { personId: PersonId; name: string }, what: string): void {
  try {
    seams.emit(hub, undefined, "people.changed", `${person.name} removed their ${what}`, {
      change: "account_removed",
      person,
      by: person,
    });
  } catch (error) {
    console.warn(`people.changed event not recorded: ${error}`);
  }
}
