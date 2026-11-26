// Delete Account on the phone (App Store 5.1.1(v)): POST ACCOUNTS_ACCOUNT_DELETE_PATH to one of the account's
// workspaces with this phone's key there, the account's email typed again, as the desktop's main makes it; first, GET
// ACCOUNTS_ACCOUNT_PATH says what it would take, for the prompt to say. The cloud checks the email and refuses the only
// owner of a workspace with others in it, in its own words, shown as written. Deleted, every key of the account is revoked already: the phone only
// forgets its workspaces, asking none of them.
import { ACCOUNTS_ACCOUNT_DELETE_PATH, ACCOUNTS_ACCOUNT_PATH } from "../../desktop/src/shared/contracts";
import { readPreview, type AccountPreview } from "../../desktop/src/shared/legal";
import { call, type Got } from "./billing";
import type { KeptHub } from "./cloud/account";

export { blockedLine, deleteAccountLines, emailMatches, LEGAL_PAGES, type AccountPreview } from "../../desktop/src/shared/legal";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The workspace to ask: the one shown when it is the account's, else the first of the account's this phone keeps. */
export const askedOn = (shown: KeptHub, hubs: readonly KeptHub[]): KeptHub | null => (shown.cloud === true ? shown : hubs.find((h) => h.cloud === true) ?? null);

/** What deleting the account would take: the workspaces that go and their plans, those left, those that hold it back. */
export const accountPreview = async (hub: Pick<KeptHub, "hub" | "key" | "hubName">, fetch: Fetch = globalThis.fetch): Promise<Got<AccountPreview>> => {
  const got = await call(fetch, hub, "GET", ACCOUNTS_ACCOUNT_PATH);
  if (!got.ok) return got;
  const preview = readPreview(got.value);
  return preview === null ? { ok: false, failure: { message: `${hub.hubName} answered in a way this app doesn't read.`, fix: "Update fleetd, then try again." } } : { ok: true, value: preview };
};

/** The account deleted for good: the workspaces deleted with it (where the person was the only member). */
export const deleteAccount = async (hub: Pick<KeptHub, "hub" | "key" | "hubName">, email: string, fetch: Fetch = globalThis.fetch): Promise<Got<readonly string[]>> => {
  const got = await call(fetch, hub, "POST", ACCOUNTS_ACCOUNT_DELETE_PATH, { email: email.trim() });
  if (!got.ok) return got;
  const workspaces = (got.value as { workspaces?: unknown } | null)?.workspaces;
  return { ok: true, value: Array.isArray(workspaces) ? workspaces.filter((w): w is string => typeof w === "string") : [] };
};
