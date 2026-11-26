// The owner's Delete Team on the phone: POST ACCOUNTS_TEAM_DELETE_PATH to the team's own address with this phone's key,
// the team's name typed again, as the desktop's main makes it. The team checks the name, refuses anyone but an owner,
// a plan that still renews and agents running, in its own words, shown as written.
import { ACCOUNTS_TEAM_DELETE_PATH } from "../../desktop/src/shared/contracts";
import { call, type Got } from "./billing";
import type { KeptHub } from "./cloud/account";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Delete Team shows for the owner of a fleetd cloud team (cloud/account.ts shownHub), and nowhere else. */
export const deleteTeamShown = (hub: Pick<KeptHub, "cloud">, role: string | undefined): boolean => hub.cloud === true && role === "owner";

/**
 * Disconnect, beside the account's Sign Out: on a team that came with the signed-in account the two would do the same
 * (signing in again brings every team back), so Sign Out alone shows there. A self-hosted workspace, or a team paired
 * with a code while no account is signed in, keeps Disconnect: it leaves that one workspace.
 */
export const disconnectShown = (hub: Pick<KeptHub, "cloud">, signedIn: boolean): boolean => !(hub.cloud === true && signedIn);

export const deleteTeam = async (hub: Pick<KeptHub, "hub" | "key" | "hubName">, name: string, fetch: Fetch = globalThis.fetch): Promise<Got<null>> => {
  const got = await call(fetch, hub, "POST", ACCOUNTS_TEAM_DELETE_PATH, { name: name.trim() });
  return got.ok ? { ok: true, value: null } : got;
};
