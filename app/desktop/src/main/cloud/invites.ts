// A fleetd cloud team's invites by email (contracts: Accounts.json, ACCOUNTS_INVITES_PATH): three plain HTTP calls to
// the team's own address with this device's key, as an owner or admin. The team answers who may and what it refuses
// (not an email, someone already on the team or invited, the team at its limit of people); its words are shown as
// written. Main makes them for a hub that came with the account only, so a self-hosted hub is never asked.
import { z } from "zod";
import type { InviteOutcome, InviteRequest, InvitesOutcome, RevokeInviteOutcome } from "../../shared/cloud";
import { ACCOUNTS_INVITES_PATH } from "../../shared/contracts";
import type { PairFailure } from "../../shared/pairing";
import type { Fetch } from "../pairing/hubHttp";

const CALL_TIMEOUT_MS = 20_000;

/** A cloud team as main reaches it: its origin, its key and its name for messages. */
export interface KeyedTeam {
  readonly origin: string;
  readonly key: string;
  readonly name: string;
}

const Invite = z.object({
  inviteId: z.string().min(1).max(64),
  email: z.string().min(1).max(320),
  role: z.string().min(1).max(32),
  createdAt: z.string(),
  expiresAt: z.string(),
});
const Listed = z.object({ invites: z.array(Invite).max(1000) });
const Made = z.object({ invite: Invite });
const Refusal = z.object({ code: z.string(), message: z.string().min(1).max(500), fix: z.string().max(500).optional() });

type Answer = { ok: true; body: unknown } | { ok: false; failure: PairFailure };

const failure = (code: string, message: string, fix?: string): { ok: false; failure: PairFailure } => ({
  ok: false,
  failure: { code, message, ...(fix === undefined ? {} : { fix }) },
});

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

const call = async (fetch: Fetch, team: KeyedTeam, method: "GET" | "POST", path: string, body?: unknown): Promise<Answer> => {
  let response: Response;
  try {
    response = await fetch(`${team.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${team.key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    return failure("offline", `Can't reach ${team.name}.`, "Check your connection, then try again.");
  }
  const answer = await readJson(response);
  if (response.ok) return { ok: true, body: answer };
  const refused = Refusal.safeParse(answer);
  if (refused.success) return failure(refused.data.code, refused.data.message, refused.data.fix);
  return failure("", `${team.name} answered ${String(response.status)}.`, "Try again in a minute.");
};

const odd = (team: KeyedTeam) => failure("", `${team.name} answered in a way this app doesn't read.`, "Update fleetd, then try again.");

export const listInvites = async (fetch: Fetch, team: KeyedTeam): Promise<InvitesOutcome> => {
  const answer = await call(fetch, team, "GET", ACCOUNTS_INVITES_PATH);
  if (!answer.ok) return answer;
  const listed = Listed.safeParse(answer.body);
  return listed.success ? { ok: true, invites: listed.data.invites } : odd(team);
};

export const sendInvite = async (fetch: Fetch, team: KeyedTeam, request: InviteRequest): Promise<InviteOutcome> => {
  const answer = await call(fetch, team, "POST", ACCOUNTS_INVITES_PATH, { email: request.email.trim(), role: request.role });
  if (!answer.ok) return answer;
  const made = Made.safeParse(answer.body);
  return made.success ? { ok: true, invite: made.data.invite } : odd(team);
};

export const revokeInvite = async (fetch: Fetch, team: KeyedTeam, inviteId: string): Promise<RevokeInviteOutcome> => {
  const answer = await call(fetch, team, "POST", `${ACCOUNTS_INVITES_PATH}/${encodeURIComponent(inviteId)}/revoke`);
  return answer.ok ? { ok: true } : answer;
};
