// `repo_create` (W762): a lead makes a GitHub repo for its own bot, on the person's word, and the bot holds it from
// then on. What both hubs share: the call's checks, what GitHub is asked, and GitHub's refusals in the lead's words.
// The open hub asks with its own `gh` login (./calls.ts); fleetd-cloud with the team's GitHub connection. Either then
// adds the new repo to the bot as `repo_add` does. Pure: fleetd-cloud imports it.
import { ToolError } from "../../shared/errors.ts";

/** The call as the lead sends it. `owner`: a GitHub organisation; absent, the account the connection signs in as. */
export type RepoCreateCall = { name: string; private: boolean; owner?: string; description?: string };

/** GitHub's own rules for a repo's name and an account's. */
export const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
export const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const invalid = (why: string, fix?: string) => new ToolError("invalid", why, fix);

/** The call, checked: throws the refusal of a bad one. */
export function checkCreate(call: unknown): RepoCreateCall {
  const c = (call ?? {}) as Record<string, unknown>;
  const { name, owner, description } = c;
  if (typeof name !== "string" || !REPO_NAME.test(name) || name === "." || name === "..") {
    throw invalid("Give name: the new repo's name on GitHub, letters, digits, '-', '_' or '.', at most 100.", "A short name from the work, such as email-client");
  }
  if (typeof c.private !== "boolean") {
    throw invalid("Give private: true for a private repo, false for a public one, as the person said.", "Ask the person which, if they didn't say");
  }
  if (owner !== undefined && (typeof owner !== "string" || !OWNER_NAME.test(owner))) {
    throw invalid("owner is a GitHub organisation's name, such as acme.", "Leave it out to make the repo in the account GitHub is connected as");
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 350 || /[\r\n]/.test(description))) {
    throw invalid("description is one line of at most 350 characters.");
  }
  return {
    name,
    private: c.private,
    ...(owner !== undefined ? { owner: owner as string } : {}),
    ...(description !== undefined ? { description: description as string } : {}),
  };
}

/** The account the repo goes in: `owner`, else `login`. A name GitHub compares without case. */
export const ownerOf = (call: RepoCreateCall, login: string) => call.owner ?? login;

/**
 * What GitHub is asked to make it. `login`: the account the connection signs in as. Made with a README, so it has a
 * first commit on its default branch and is cloned, read and merged into like any other repo.
 */
export function createRequest(call: RepoCreateCall, login: string): { path: string; body: { name: string; private: boolean; auto_init: true; description?: string } } {
  const mine = call.owner === undefined || call.owner.toLowerCase() === login.toLowerCase();
  return {
    path: mine ? "user/repos" : `orgs/${call.owner}/repos`,
    body: { name: call.name, private: call.private, auto_init: true, ...(call.description !== undefined ? { description: call.description } : {}) },
  };
}

/** The refusal of a name GitHub already has: asked before the create, as GitHub's own 422 hides why in its errors. */
export const alreadyThere = (full: string) =>
  invalid(`${full} already exists on GitHub.`, "Pick another name with the person, or add that repo with repo_add if it is the one they mean");

/** GitHub's own words for a refusal: its message, then each error's (a 422 keeps its reason there), each without its
 * last period. "" when it said none. The cloud's words for the same (fleetd-cloud#466). */
export function githubSaid(body: unknown): string {
  const b = (body ?? {}) as { message?: unknown; errors?: unknown };
  const errors = Array.isArray(b.errors)
    ? b.errors.map((e) => (typeof e === "string" ? e : (e as { message?: unknown } | null)?.message)).filter((m): m is string => typeof m === "string")
    : [];
  return [typeof b.message === "string" ? b.message : "", ...errors]
    .map((m) => m.trim().replace(/\.$/u, ""))
    .filter((m) => m !== "")
    .join(": ");
}

/**
 * GitHub's refusal to make `owner/name`, as the lead's. `said`: GitHub's words (`githubSaid`). `who` names the
 * connection ("the hub's GitHub login alice"); `grant`, the one step that gives it the permission it lacks, which the
 * lead tells the person. A refusal of the account's own (an organisation's policy on private or public repos) says
 * GitHub's words and is never tried again.
 */
export function createRefused(status: number, said: string, full: string, who: string, grant: string): ToolError {
  const owner = full.split("/")[0];
  const why = said || "it gave no reason";
  if (status === 422 && /already exists/i.test(said)) return alreadyThere(full);
  if (status === 401) return new ToolError("forbidden", `${who} was turned away by GitHub: ${why}.`, grant);
  if (status === 403) return new ToolError("forbidden", `${who} may not create repos in ${owner}: ${why}.`, grant);
  // GitHub answers 404 both for a name it doesn't know and for an organisation the login may not see: both are said.
  if (status === 404) {
    return new ToolError("forbidden", `${who} found no organisation ${owner} it may create repos in: ${why}.`, `Check the organisation's name with the person; if it is right: ${grant}`);
  }
  if (status >= 400 && status < 500) {
    return new ToolError(
      "forbidden",
      `GitHub refused to create ${full} (${status}): ${why}.`,
      `Tell the person GitHub's words: ${owner}'s own settings on GitHub decide this, and its admin changes them there, or they pick another account`,
    );
  }
  return new ToolError("failed", `GitHub did not create ${full} (${status}): ${why}.`, "Try again; if it fails the same way, tell the person this line");
}

/** What the lead is told once the repo exists, before the add's own line (added, or its clone under way). */
export const createdLine = (full: string, priv: boolean) => `Created ${full} on GitHub, ${priv ? "private" : "public"}, with a README as its first commit.`;
