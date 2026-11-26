// Delete account for one signed in on the web with no workspace (Gate's no-workspace page): what it would take, read
// with the session alone, and the delete. Loaded only when that page asks, off the web app's first load.
import type { AccountPreviewOutcome, DeleteAccountOutcome } from "../shared/cloud";
import { isFields } from "../shared/check";
import { readPreview } from "../shared/legal";
import type { PairFailure } from "../shared/pairing";
import { type Fetch, webCall, type WebFailure } from "./session";

const signedOutFailure: WebFailure = { code: "signed_out", message: "You're signed out.", fix: "Sign in again, then delete your account." };

/** A refusal as the delete dialog takes it: a fix only when there is one. */
const asPair = (f: WebFailure): PairFailure => ({ code: f.code, message: f.message, ...(f.fix === undefined ? {} : { fix: f.fix }) });

/** What deleting the account would take, read with the session alone (one in no workspace has no workspace to ask). */
export const readAccount = async (fetch: Fetch): Promise<AccountPreviewOutcome> => {
  const answer = await webCall(fetch, "GET", "/web/account");
  if (!answer.ok) return { ok: false, failure: asPair(answer.signedOut === true ? signedOutFailure : answer.failure) };
  const preview = readPreview(answer.body);
  return preview === null ? { ok: false, failure: { code: "", message: "fleetd cloud answered in a way this page doesn't read.", fix: "Reload the page." } } : { ok: true, preview };
};

/** Deletes the account, `email` typed back; the cloud ends the session and clears its cookie. */
export const deleteWebAccount = async (fetch: Fetch, email: string): Promise<DeleteAccountOutcome> => {
  const answer = await webCall(fetch, "POST", "/web/account/delete", { json: { email } });
  if (!answer.ok) return { ok: false, failure: asPair(answer.signedOut === true ? signedOutFailure : answer.failure) };
  const workspaces = isFields(answer.body) && Array.isArray(answer.body["workspaces"]) ? answer.body["workspaces"].filter((w): w is string => typeof w === "string") : [];
  return { ok: true, workspaces };
};
