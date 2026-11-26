// A fleetd cloud workspace's sign-in (the reading is shared/signin.ts): plain HTTP calls to the workspace's own
// address with an owner's or admin's device key; the workspace refuses anyone else. Its email domains are added and
// verified on WorkOS's domain verification page, whose short-lived address the workspace answers on each ask and the
// browser opens.
import { readPage } from "../../shared/billing";
import type { SigninDomainOutcome, SigninOutcome } from "../../shared/cloud";
import { ACCOUNTS_SIGNIN_DOMAIN_PATH, ACCOUNTS_SIGNIN_PATH, readSignin, type SigninChange } from "../../shared/signin";
import type { Fetch } from "../pairing/hubHttp";
import { call, odd, type KeyedTeam } from "./invites";

export const readTeamSignin = async (fetch: Fetch, team: KeyedTeam): Promise<SigninOutcome> => {
  const answer = await call(fetch, team, "GET", ACCOUNTS_SIGNIN_PATH);
  if (!answer.ok) return { ok: false, failure: answer.failure };
  const signin = readSignin(answer.body);
  return signin === null ? odd(team) : { ok: true, signin };
};

/** The required sign-in method or the domain switch changed; answered with the whole state as kept. */
export const setTeamSignin = async (fetch: Fetch, team: KeyedTeam, change: SigninChange): Promise<SigninOutcome> => {
  const answer = await call(fetch, team, "POST", ACCOUNTS_SIGNIN_PATH, change);
  if (!answer.ok) return { ok: false, failure: answer.failure };
  const signin = readSignin(answer.body);
  return signin === null ? odd(team) : { ok: true, signin };
};

/** The page that adds and verifies an email domain, opened by `open`. */
export const openSigninDomain = async (fetch: Fetch, team: KeyedTeam, open: (url: string) => Promise<void>): Promise<SigninDomainOutcome> => {
  const answer = await call(fetch, team, "POST", ACCOUNTS_SIGNIN_DOMAIN_PATH, {});
  if (!answer.ok) return { ok: false, failure: answer.failure };
  const url = readPage(answer.body);
  if (url === null) return odd(team);
  try {
    await open(url);
  } catch (error) {
    return { ok: false, failure: { code: "", message: `The browser didn't open: ${String(error)}` } };
  }
  return { ok: true };
};
