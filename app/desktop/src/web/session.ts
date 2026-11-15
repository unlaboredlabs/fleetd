// What the web app asks fleetd cloud over HTTP, on its own origin (app.fleetd.dev), the session being the cookie the
// cloud sets at sign-in (HttpOnly, so this page never holds it, and nothing of it is kept in storage). The contract,
// agreed with fleetd-cloud's side (the docs' Web app page has it too, docs/site/src/content/docs/web-app.md):
//   GET  /web/session              200 { email, teams: [{ id, name, url }], invitations? } or 401 when signed out
//   GET  /web/sign-in?return=<path> a top-level navigation: WorkOS's sign-in, then back to <path> signed in
//   POST /web/sign-out             204
//   POST /web/accept { accept }    200 { team }: an invitation joined
//   POST /t/<team>/web/frames      200 { url }: an HTML report's page, served on the team's own address
//   /t/<team>/app                  the team's hub socket; /t/<team>/accounts/v1/invites…, /t/<team>/github/v1/install
// Every call but a GET carries `x-fleetd-web: 1`, which a page on another origin can't send without a preflight the
// cloud never answers.
import { z } from "zod";

/** The header every call carries; the cloud refuses a write without it. */
export const WEB_HEADER = { "x-fleetd-web": "1" } as const;

const CALL_TIMEOUT_MS = 20_000;

const Team = z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(100), url: z.string().min(1).max(300) });
export type WebTeam = z.infer<typeof Team>;
const Invitation = z.object({ name: z.string().min(1).max(100), invitedBy: z.string().max(320), role: z.string().max(32), accept: z.string().min(1).max(200) });
export type WebInvitation = z.infer<typeof Invitation>;
const Session = z.object({ email: z.string().min(1).max(320), teams: z.array(Team).max(100), invitations: z.array(Invitation).max(100).optional() });
export interface WebSession {
  readonly email: string;
  readonly teams: readonly WebTeam[];
  readonly invitations: readonly WebInvitation[];
}

/** A refusal or failure as the screens show one: what happened and what to do. */
export interface WebFailure {
  readonly code: string;
  readonly message: string;
  readonly fix?: string | undefined;
}

export type SessionRead = { readonly ok: true; readonly session: WebSession } | { readonly ok: false; readonly signedOut: true } | { readonly ok: false; readonly signedOut?: undefined; readonly failure: WebFailure };

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const unreachable: WebFailure = { code: "offline", message: "Can't reach fleetd cloud.", fix: "Check your connection, then try again." };

const Refusal = z.object({ code: z.string().max(64), message: z.string().min(1).max(500), fix: z.string().max(500).optional() });

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

/** The cloud's refusal in its own words, else one that says the status. */
const refusalOf = async (response: Response): Promise<WebFailure> => {
  const said = Refusal.safeParse(await readJson(response));
  return said.success ? said.data : { code: "", message: `fleetd cloud answered ${String(response.status)}.`, fix: "Try again in a minute." };
};

/** One same-origin call with the session's cookie; never throws. A 401 is `signedOut`. */
export const webCall = async (
  fetch: Fetch,
  method: "GET" | "POST",
  path: string,
  body?: { readonly json: unknown } | { readonly html: string },
): Promise<{ ok: true; body: unknown } | { ok: false; signedOut: true } | { ok: false; signedOut?: undefined; failure: WebFailure }> => {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      redirect: "error",
      headers: { ...WEB_HEADER, ...(body === undefined ? {} : { "content-type": "json" in body ? "application/json" : "text/html; charset=utf-8" }) },
      ...(body === undefined ? {} : { body: "json" in body ? JSON.stringify(body.json) : body.html }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, failure: unreachable };
  }
  if (response.status === 401) return { ok: false, signedOut: true };
  if (!response.ok) return { ok: false, failure: await refusalOf(response) };
  return { ok: true, body: response.status === 204 ? undefined : await readJson(response) };
};

/** Who is signed in and their teams; `signedOut` when no one is. */
export const readSession = async (fetch: Fetch): Promise<SessionRead> => {
  const answer = await webCall(fetch, "GET", "/web/session");
  if (!answer.ok) return answer;
  const got = Session.safeParse(answer.body);
  if (!got.success) return { ok: false, failure: { code: "", message: "fleetd cloud answered in a way this page doesn't read.", fix: "Reload the page." } };
  return { ok: true, session: { email: got.data.email, teams: got.data.teams, invitations: got.data.invitations ?? [] } };
};

/** Where Sign in goes: WorkOS's page, then back to `back` (this page's path and route), only ever a path of this origin. */
export const signInPath = (back: string): string => {
  const path = back.startsWith("/") && !back.startsWith("//") ? back : "/";
  return path === "/" ? "/web/sign-in" : `/web/sign-in?return=${encodeURIComponent(path)}`;
};

/** A team's own paths on this origin: `/t/<team>…`. */
export const teamPath = (teamId: string, path = ""): string => `/t/${encodeURIComponent(teamId)}${path}`;

/**
 * The id a team's hub has in this page (a HubId: lowercase letters and digits, 16 at most): its id's own, so a route
 * that names it (`?at=`) still finds it after a reload.
 */
export const teamHubId = (teamId: string): string => teamId.toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 16) || "team";

/** FNV-1a of the whole id, in base 36: what tells apart two teams whose ids begin alike. */
const hashOf = (text: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36).padStart(7, "0");
};

/**
 * Each team's hub id, every one its own: teams whose ids come to the same teamHubId (`acme-corporation-eu` and
 * `acme-corporation-us`) each get its start and a hash of its whole id instead, whatever order the session lists them in.
 */
export const teamHubIds = (teamIds: readonly string[]): ReadonlyMap<string, string> => {
  const base = new Map(teamIds.map((id) => [id, teamHubId(id)]));
  const counts = new Map<string, number>();
  for (const id of base.values()) counts.set(id, (counts.get(id) ?? 0) + 1);
  return new Map([...base].map(([team, id]) => [team, (counts.get(id) ?? 0) > 1 ? `${id.slice(0, 9)}${hashOf(team)}` : id]));
};
