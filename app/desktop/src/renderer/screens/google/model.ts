// Google for Navi in the app, as pure functions (docs/site google.md): what each scope is for, the state of a Navi's
// Google connection as google_get tells it, and the checks on what an admin pastes before it goes to main to be
// sealed. The hub checks it all again.
import type { GoogleAccount, GoogleGetOutput } from "../../../shared/contracts";

export const DOCS = "https://fleetd.sh/docs/google/";

/** What the hub asks Google for (google.rs GOOGLE_SCOPES), for when google_get hasn't said. */
export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
] as const;

/** Where the consent page sends the person back (google.rs GOOGLE_REDIRECT): a Desktop app client takes any port. */
export const REDIRECT = "http://127.0.0.1";

/**
 * Each scope in words: `label` where it is pasted, `short` in a list of what was unticked, `for` beside it.
 */
const SCOPE_WORDS: Readonly<Record<string, { label: string; short: string; for: string }>> = {
  openid: { label: "Account", short: "your address", for: "Which account is connected." },
  email: { label: "Address", short: "your address", for: "Which account is connected." },
  "https://www.googleapis.com/auth/gmail.readonly": { label: "Read mail", short: "reading mail", for: "Searching and reading mail." },
  "https://www.googleapis.com/auth/gmail.compose": {
    label: "Draft and send",
    short: "drafting and sending mail",
    for: "Drafts, sends and replies. It can't delete mail or change labels.",
  },
  "https://www.googleapis.com/auth/calendar.events": { label: "Calendar", short: "Calendar", for: "Reading, making and changing events." },
  "https://www.googleapis.com/auth/drive": { label: "Drive", short: "Drive", for: "Searching, reading, uploading and sharing files." },
};

const shortName = (scope: string): string => scope.replace("https://www.googleapis.com/auth/", "");

/** A scope's short name, as Data access lists it: `gmail.readonly`, or `openid` itself. */
export const scopeName = shortName;

export const scopeFor = (scope: string): string => SCOPE_WORDS[scope]?.for ?? "";

/** A scope's name in words, where it is pasted: "Read mail". */
export const scopeLabel = (scope: string): string => SCOPE_WORDS[scope]?.label ?? shortName(scope);

/** "a, b and c". */
export const listWords = (words: ReadonlyArray<string>): string =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1] ?? ""}`;

/** What was asked and isn't granted, in words, once each: Google lets the person untick some. */
export const missingScopes = (asked: ReadonlyArray<string>, granted: ReadonlyArray<string>): string[] => {
  const have = new Set(granted.map(shortName));
  // Google answers `email` as `https://www.googleapis.com/auth/userinfo.email`, and openid as itself.
  if (have.has("userinfo.email")) have.add("email");
  const words = asked.filter((s) => !have.has(shortName(s))).map((s) => SCOPE_WORDS[s]?.short ?? shortName(s));
  return [...new Set(words)];
};

/**
 * A Navi's Google connection, from google_get with its project:
 * - no-client: the hub has no OAuth client; an admin sets one up in Administration › Google.
 * - not-held: there is one, but the Navi's machine wasn't online to take its secret when it was saved.
 * - none: ready to connect.
 * - connected, and lapsed: Google stopped taking it (revoked, a Testing app's 7 days), so Reconnect.
 */
export type GoogleView =
  | { readonly kind: "no-client" }
  | { readonly kind: "not-held"; readonly machineId: string }
  | { readonly kind: "none" }
  | { readonly kind: "connected"; readonly account: GoogleAccount; readonly missing: ReadonlyArray<string> }
  | { readonly kind: "lapsed"; readonly account: GoogleAccount; readonly why: string };

export const googleView = (out: GoogleGetOutput, machineId: string): GoogleView => {
  const { client, account } = out;
  if (account !== undefined) {
    if (account.lapsed !== undefined) return { kind: "lapsed", account, why: account.lapsed };
    return { kind: "connected", account, missing: missingScopes(out.scopes, account.scopes) };
  }
  if (client === undefined) return { kind: "no-client" };
  if (!(client.sealedOn ?? []).some((s) => s.machineId === machineId)) return { kind: "not-held", machineId };
  return { kind: "none" };
};

/** The node's reason a connection lapsed, as a sentence. */
export const lapsedLine = (why: string): string => {
  const w = why.trim().replace(/\.$/u, "");
  return `Google stopped taking this connection: ${w === "" ? "it was revoked or expired" : w}.`;
};

/** Why a pasted client id won't do, or null. */
export const clientIdProblem = (id: string): string | null => {
  const t = id.trim();
  if (t === "") return "Paste the client's Client ID.";
  if (/\s/u.test(t)) return "The Client ID has a space or a line break in it: copy it again.";
  if (!/^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$/u.test(t)) return "A Client ID ends in .apps.googleusercontent.com.";
  return null;
};

/** Why a pasted client secret won't do, or null. */
export const secretProblem = (secret: string): string | null => {
  const t = secret.trim();
  if (t === "") return "Paste the client's Client secret.";
  if (/\s/u.test(t)) return "The secret has a space or a line break in it: copy it again.";
  if (t.endsWith(".apps.googleusercontent.com")) return "That's the Client ID. The secret is the other value, starting with GOCSPX-.";
  return null;
};

/** The machines a client secret is sealed to: every one whose node has a box key, as for a global MCP server. */
export const boxesOf = (machines: ReadonlyArray<{ machineId: string; boxPubKey?: unknown }>): Array<{ machineId: string; boxPubKey: string }> =>
  machines.flatMap((m) => (typeof m.boxPubKey === "string" ? [{ machineId: m.machineId, boxPubKey: m.boxPubKey }] : []));

/** A day, as "Oct 27". */
export const dayWords = (iso: string, timeZone?: string): string =>
  new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", ...(timeZone === undefined ? {} : { timeZone }) });

/** Machines that take secrets but don't hold the client: offline when it was saved, or added since. */
export const notHolding = (out: GoogleGetOutput, boxes: ReadonlyArray<{ machineId: string }>): string[] => {
  const held = new Set((out.client?.sealedOn ?? []).map((s) => s.machineId));
  return boxes.map((b) => b.machineId).filter((m) => !held.has(m));
};

/** Why a Pub/Sub topic's full name won't do, or null (google.rs PubsubTopic). */
export const topicProblem = (t: string): string | null =>
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/u.test(t.trim()) ? null : "A topic's full name is projects/<project>/topics/<topic>.";

/** Why a Pub/Sub subscription's full name won't do, or null (google.rs PubsubSubscription). */
export const subscriptionProblem = (t: string): string | null =>
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/subscriptions\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/u.test(t.trim())
    ? null
    : "A subscription's full name is projects/<project>/subscriptions/<subscription>.";

/** Why a pasted service account key won't do, or null; main checks it again before sealing. */
export const keyProblem = (key: string): string | null => {
  const t = key.trim();
  if (t === "") return "Paste the service account's JSON key.";
  try {
    const k = JSON.parse(t) as unknown;
    if (typeof k === "object" && k !== null && (k as Record<string, unknown>)["type"] === "service_account") return null;
  } catch {
    return "That isn't JSON: paste the whole downloaded file.";
  }
  return "That isn't a service account's key: its JSON has \"type\": \"service_account\".";
};

/** How the hub hears of new mail now, in a line, from google_get. */
export const mailModeLine = (info: Pick<GoogleGetOutput, "client" | "mailMode" | "mailProblem">): { tone: "success" | "quiet" | "warning"; text: string } => {
  if (info.mailMode === "push") return { tone: "success", text: "By push: new mail reaches it within seconds." };
  if (info.client?.pubsub === undefined) return { tone: "quiet", text: "By checking about every minute: real-time mail isn't set up on this hub." };
  const why = (info.mailProblem ?? "").trim().replace(/\.$/u, "");
  return { tone: "warning", text: `By checking about every minute for now${why === "" ? "" : `: ${why}`}. Real-time mail comes back by itself once it reads again.` };
};

/** Why a Gmail search for a mail wake won't do, or null (MailWake.query: a line of 1 to 500). */
export const queryProblem = (q: string): string | null => {
  const t = q.trim();
  if (t === "") return "Type a Gmail search, such as from:boss@example.com OR is:important.";
  if (/[\r\n]/u.test(t)) return "Keep the search on one line.";
  if (t.length > 500) return "Keep the search under 500 characters.";
  return null;
};
