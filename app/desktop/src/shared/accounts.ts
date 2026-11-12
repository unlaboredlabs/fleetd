// The apps' reading of fleetd cloud's accounts service (contracts: Accounts.json), shared by the desktop's main and the
// phone, and importable from the package (`fleetd/apps/accounts`) so the cloud tests its answers through the apps' own
// code: the sign-in's answer, the accept's answer, which team addresses an app connects to, and whether a hub's address
// is a team of the cloud's. Checked by hand, with no URL parser: React Native's has no searchParams and the package
// takes no dependency.
import type { AccountsInvitation, AccountsTeam } from "./contracts/contracts";

/** The sign-in's 200, as the apps take it: `invitations` is empty when the service sent none. */
export interface SignedIn {
  readonly email: string;
  readonly sessionId: string;
  readonly teams: AccountsTeam[];
  readonly invitations: AccountsInvitation[];
}

const PAIRING_CODE = /^[A-Z0-9]{4}(?:-?[A-Z0-9]{4}){1,7}$/u;
const ACCEPT = /^[A-Za-z0-9_-]{16,200}$/u;

const text = (v: unknown, min: number, max: number): v is string => typeof v === "string" && v.length >= min && v.length <= max;
const record = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const team = (v: unknown): AccountsTeam | null => {
  const t = record(v);
  if (t === null) return null;
  const { id, name, url, pairingCode, made } = t;
  if (!text(id, 1, 64) || !text(name, 1, 63) || !text(url, 1, 253) || typeof pairingCode !== "string" || !PAIRING_CODE.test(pairingCode)) return null;
  // `made` that isn't a boolean reads as absent, as an older service answers.
  return { id, name, url, pairingCode, ...(typeof made === "boolean" ? { made } : {}) };
};

/**
 * The person made this team (its `made`), so an app may open it on Connect a computer. Absent, as an older service
 * answers: a team joined through the accept call at this sign-in wasn't, and any other was.
 */
export const madeTeam = (team: Pick<AccountsTeam, "made">, accepted: boolean): boolean => team.made ?? !accepted;

const invitation = (v: unknown): AccountsInvitation | null => {
  const i = record(v);
  if (i === null) return null;
  const { name, invitedBy, role, accept } = i;
  // The role is open (HubRole's x-open): one this app doesn't know yet is still shown as the service wrote it.
  if (!text(name, 1, 63) || !text(invitedBy, 3, 320) || !text(role, 1, 32) || typeof accept !== "string" || !ACCEPT.test(accept)) return null;
  return { name, invitedBy, role, accept };
};

/**
 * The accounts service's sign-in answer, checked; null when it isn't one. An invitation that fails its check is left
 * out, the rest kept: one bad invitation never stops the person signing in.
 */
export const readSignIn = (json: unknown): SignedIn | null => {
  const o = record(json);
  if (o === null) return null;
  const { email, sessionId, teams, invitations } = o;
  if (!text(email, 3, 320) || !text(sessionId, 1, 200) || !Array.isArray(teams) || teams.length > 50) return null;
  if (invitations !== undefined && (!Array.isArray(invitations) || invitations.length > 50)) return null;
  const outTeams: AccountsTeam[] = [];
  for (const t of teams as unknown[]) {
    const read = team(t);
    if (read === null) return null;
    outTeams.push(read);
  }
  const outInvitations = ((invitations ?? []) as unknown[]).flatMap((i) => invitation(i) ?? []);
  return { email, sessionId, teams: outTeams, invitations: outInvitations };
};

/** The accept's answer: the team joined, with its pairing code; null when it isn't one. */
export const readAccepted = (json: unknown): AccountsTeam | null => team(record(json)?.team);

/** An address's scheme and host (lowercased, no port, no trailing dot), or null. */
const parts = (raw: string): { scheme: string; host: string; hostname: string } | null => {
  const m = /^(https?):\/\/([^/?#@\s]+?)\/?$/iu.exec(raw.trim());
  if (m === null) return null;
  const host = (m[2] ?? "").toLowerCase();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/u.test(host)) return null;
  return { scheme: (m[1] ?? "").toLowerCase(), host, hostname: host.replace(/:\d+$/u, "").replace(/\.$/u, "") };
};

const ip = (hostname: string): boolean => /^\d+\.\d+\.\d+\.\d+$/u.test(hostname);

/**
 * The domain fleetd cloud's teams live under, from the build's accounts address: its host's parent
 * (`fleetd.dev` for `https://accounts.fleetd.dev`), or the host itself when it has no parent of two labels. Null for an
 * address that isn't one, or a stand-in on an IP address.
 */
export const cloudDomain = (accountsUrl: string): string | null => {
  const p = parts(accountsUrl);
  if (p === null || ip(p.hostname)) return null;
  const labels = p.hostname.split(".");
  return labels.length >= 3 ? labels.slice(1).join(".") : p.hostname;
};

/** `hubUrl`'s host is under `domain` (cloudDomain's): a team of fleetd cloud's, which anyone can make. */
export const inDomain = (hubUrl: string, domain: string | null): boolean => {
  const p = parts(hubUrl);
  return domain !== null && p !== null && p.hostname.endsWith(`.${domain}`);
};

/** `hubUrl`'s host is under the cloud's domain, from the build's accounts address. */
export const inCloud = (hubUrl: string, accountsUrl: string): boolean => inDomain(hubUrl, cloudDomain(accountsUrl));

/** An invitation as both apps ask about it, before anything pairs with its team. */
export const invitationTitle = (i: Pick<AccountsInvitation, "name" | "invitedBy">): string => `${i.invitedBy} invited you to ${i.name}`;
export const invitationLine = (i: Pick<AccountsInvitation, "role">): string =>
  `You'd join as ${i.role === "admin" || i.role === "owner" ? "an" : "a"} ${i.role}. Join only if you know who sent it.`;

/** What a pairing link to a team of fleetd cloud's says before it pairs: the address alone looks like fleetd's own. */
export const CLOUD_TEAM_LINK = "This is a fleetd cloud team. Anyone can make one, so join only if you know who sent you this link.";

/**
 * A team's hub address from the accounts service, as an origin: https and under the accounts host's parent domain
 * (`*.fleetd.dev` for `accounts.fleetd.dev`), or, in a local build, http on 127.0.0.1 for a stand-in. Null otherwise:
 * no pairing code or key goes anywhere else.
 */
export const teamOrigin = (raw: string, accountsUrl: string, local: boolean): string | null => {
  const p = parts(raw);
  if (p === null) return null;
  if (local && p.hostname === "127.0.0.1") return `${p.scheme}://${p.host}`;
  return p.scheme === "https" && inCloud(raw, accountsUrl) ? `https://${p.host}` : null;
};
