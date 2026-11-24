// What the web app asks fleetd cloud over HTTP, on its own origin (app.fleetd.dev), the session being the cookie the
// cloud sets at sign-in (HttpOnly, so this page never holds it, and nothing of it is kept in storage). The contract,
// agreed with fleetd-cloud's side (the docs' Web app page has it too, docs/site/src/content/docs/web-app.md):
//   GET  /web/session              200 { email, teams: [{ id, name, url }], invitations? } or 401 when signed out
//   GET  /web/sign-in?return=<path> a top-level navigation: WorkOS's sign-in, then back to <path> signed in
//                                  (&screen_hint=sign-up, Make an account's: WorkOS's sign-up form, once the cloud passes it on)
//   POST /web/sign-out             204
//   POST /web/accept { accept }    200 { team }: an invitation joined
//   POST /t/<team>/web/frames      200 { url }: an HTML report's page, served on the team's own address
//   /t/<team>/app                  the team's hub socket; /t/<team>/accounts/v1/invites…, /t/<team>/github/v1/install
// Every call but a GET carries `x-fleetd-web: 1`, which a page on another origin can't send without a preflight the
// cloud never answers.
// Plain checks, not zod: this runs before the web app's first chat (shared/check.ts).
import { isFields, isList, isOptional, isText, type Fields } from "../shared/check";
import { parseHash, toHash } from "../renderer/screens/shell/routes";

/** The header every call carries; the cloud refuses a write without it. */
export const WEB_HEADER = { "x-fleetd-web": "1" } as const;

const CALL_TIMEOUT_MS = 20_000;

export interface WebTeam {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly later?: true | undefined;
}
export interface WebInvitation {
  readonly name: string;
  readonly invitedBy: string;
  readonly role: string;
  readonly accept: string;
}
const text = (min: number, max: number) => (v: unknown): v is string => isText(v, min, max);
const isTeam = (v: unknown): v is Fields => isFields(v) && isText(v["id"], 1, 64) && isText(v["name"], 1, 100) && isText(v["url"], 1, 300) && (v["later"] === undefined || v["later"] === true);
const isInvitation = (v: unknown): v is Fields => isFields(v) && isText(v["name"], 1, 100) && isText(v["invitedBy"], 0, 320) && isText(v["role"], 0, 32) && isText(v["accept"], 1, 200);
/** The session's answer, its known fields only (as a schema's parse gives them), or null. */
const sessionOf = (v: unknown): Omit<WebSession, "invitations" | "removed"> & { invitations?: WebInvitation[]; removed?: string[] } | null => {
  if (!isFields(v) || !isText(v["email"], 1, 320) || !isList(v["teams"], 100, isTeam)) return null;
  if (!isOptional(v["invitations"], (x) => isList(x, 100, isInvitation)) || !isOptional(v["removed"], (x) => isList(x, 50, text(1, 100)))) return null;
  const team = (t: Fields): WebTeam => ({ id: t["id"] as string, name: t["name"] as string, url: t["url"] as string, ...(t["later"] === true ? { later: true as const } : {}) });
  const invitation = (i: Fields): WebInvitation => ({ name: i["name"] as string, invitedBy: i["invitedBy"] as string, role: i["role"] as string, accept: i["accept"] as string });
  return {
    email: v["email"],
    teams: v["teams"].map(team),
    ...(v["invitations"] === undefined ? {} : { invitations: v["invitations"].map(invitation) }),
    ...(v["removed"] === undefined ? {} : { removed: v["removed"] }),
  };
};
export interface WebSession {
  readonly email: string;
  readonly teams: readonly WebTeam[];
  readonly invitations: readonly WebInvitation[];
  /** The teams the person was removed from since their last sign-in: said once, on the first page after it. */
  readonly removed: readonly string[];
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

/** The cloud's refusal, its known fields only, or null. */
const refusal = (v: unknown): WebFailure | null =>
  isFields(v) && isText(v["code"], 0, 64) && isText(v["message"], 1, 500) && isOptional(v["fix"], text(0, 500))
    ? { code: v["code"], message: v["message"], ...(v["fix"] === undefined ? {} : { fix: v["fix"] }) }
    : null;

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

/** The cloud's refusal in its own words, else one that says the status. */
const refusalOf = async (response: Response): Promise<WebFailure> => {
  return refusal(await readJson(response)) ?? { code: "", message: `fleetd cloud answered ${String(response.status)}.`, fix: "Try again in a minute." };
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
  const got = sessionOf(answer.body);
  if (got === null) return { ok: false, failure: { code: "", message: "fleetd cloud answered in a way this page doesn't read.", fix: "Reload the page." } };
  return { ok: true, session: { email: got.email, teams: got.teams, invitations: got.invitations ?? [], removed: got.removed ?? [] } };
};

/** How long after a team is made its session is read again, while it doesn't list a team yet: about 7.5 s in all. */
export const MADE_READS_MS = [500, 1000, 2000, 4000] as const;

/** A team made, and not listed yet by the session read this many times: said in place of No team yet's line. */
export const NOT_LISTED_YET: WebFailure = { code: "not_listed_yet", message: "Your team is made, but fleetd cloud isn't showing it yet.", fix: "Press Make a team again in a moment to open it." };

/**
 * After Make a team: the session read again (`read`), at MADE_READS_MS apart, until it lists a team; true once it
 * does. Signed out on the way is said as such; a read that fails is tried again like one that lists none.
 */
export const untilListed = async (read: () => Promise<SessionRead>, wait: (ms: number) => Promise<void>): Promise<"listed" | "signed_out" | "not_yet"> => {
  for (const ms of MADE_READS_MS) {
    const got = await read();
    if (got.ok && got.session.teams.length > 0) return "listed";
    if (!got.ok && got.signedOut === true) return "signed_out";
    await wait(ms);
  }
  const last = await read();
  if (last.ok && last.session.teams.length > 0) return "listed";
  return !last.ok && last.signedOut === true ? "signed_out" : "not_yet";
};

/**
 * Where Sign in goes: WorkOS's page, then back to `back` (this page's path and route), only ever a path of this origin.
 * `signUp`: Make an account's, which asks WorkOS for its sign-up form (WorkOS's own name for it, screen_hint).
 */
export const signInPath = (back: string, signUp = false): string => {
  const path = back.startsWith("/") && !back.startsWith("//") ? back : "/";
  const q = new URLSearchParams();
  if (path !== "/") q.set("return", path);
  if (signUp) q.set("screen_hint", "sign-up");
  const query = q.toString();
  return query === "" ? "/web/sign-in" : `/web/sign-in?${query}`;
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

/**
 * The team an address names (`?team=<team id>`: the one picked on WorkOS's page at sign-in, or Stripe's way back), as
 * the address the app opens: the screen its hash names, on that team's hub, and the parameter gone. Null when it names
 * none of `hubs` (team id → hub id), which leaves the address as it is.
 */
export const teamFromAddress = (address: { readonly search: string; readonly hash: string }, hubs: ReadonlyMap<string, string>): { search: string; hash: string } | null => {
  const params = new URLSearchParams(address.search);
  const team = params.get("team");
  if (team === null) return null;
  params.delete("team");
  const rest = params.toString();
  const search = rest === "" ? "" : `?${rest}`;
  const hub = hubs.get(team);
  if (hub === undefined) return { search, hash: address.hash };
  return { search, hash: toHash({ ...parseHash(address.hash), at: hub }) };
};

/** The one line a person removed from teams reads at their next sign-in. */
export const removedLine = (teams: readonly string[]): string => `You were removed from ${teams.join(", ")}.`;

/**
 * Whom the person was removed from, as the session says it once (the cloud forgets it as it answers), kept until a
 * screen has said it: the gates (no team left, an invitation) as a line, else the app as a toast. A second read after
 * Join or Not now doesn't lose it, and the app doesn't say it again after a gate did.
 */
export function removedNotice() {
  let teams: readonly string[] | null = null;
  let said = false;
  return {
    /** A session read; the line a gate shows, while there is one to say. */
    read(session: Pick<WebSession, "removed">): string | undefined {
      if (session.removed.length > 0) teams = session.removed;
      return teams === null ? undefined : removedLine(teams);
    },
    /** A gate showed the line. */
    shown(): void {
      if (teams !== null) said = true;
    },
    /** The app opens: its toast's line when no gate said it, once. */
    app(): string | undefined {
      const line = teams !== null && !said ? removedLine(teams) : undefined;
      teams = null;
      return line;
    },
  };
}

/**
 * What a page that opened from its kept account (main.tsx) does once its session is read: goes on (`keep`), starts
 * again from the session (`fresh`: signed out, another account, other teams, or something a gate says: invitations,
 * no team, a removal), or stays as it is with the cloud out of reach (`offline`: the app says so, and reconnects).
 */
export const afterKeptStart = (kept: { readonly email: string; readonly teams: ReadonlyArray<{ readonly id: string }> }, read: SessionRead): "keep" | "fresh" | "offline" => {
  if (!read.ok) return read.signedOut === true ? "fresh" : "offline";
  const { session } = read;
  const ids = (teams: ReadonlyArray<{ readonly id: string }>) => teams.map((t) => t.id).sort().join("\n");
  if (session.email !== kept.email || ids(session.teams) !== ids(kept.teams)) return "fresh";
  if (session.invitations.length > 0 || session.teams.length === 0 || session.removed.length > 0) return "fresh";
  return "keep";
};
