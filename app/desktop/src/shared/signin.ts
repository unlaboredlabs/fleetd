// A fleetd cloud workspace's sign-in as its owners and admins read it (`GET /accounts/v1/signin` on the workspace's
// own address): the sign-in method its admins and members must use, its email domains (added and verified on WorkOS's domain
// verification page, which the workspace's answer opens), and whether people of its verified domains join by
// themselves. Shared by the desktop's main and page, and importable from the package (`fleetd/apps/signin`) so the
// cloud can test its answers through the apps' own reading. Checked by hand, as billing.ts is: the package takes no
// dependency.

export const ACCOUNTS_SIGNIN_PATH = "/accounts/v1/signin";
/** POST `{}`: the page that adds and verifies a domain, `{ url }`, good for minutes: asked on each click. */
export const ACCOUNTS_SIGNIN_DOMAIN_PATH = "/accounts/v1/signin/domain";

/** The one sign-in method admins and members must use; null: any. Owners are let in however they sign in. */
export type SigninRequire = "google" | null;

export interface SigninDomain {
  readonly domain: string;
  readonly state: "verified" | "pending" | "failed";
}

export interface SigninState {
  readonly domains: readonly SigninDomain[];
  readonly require: SigninRequire;
  /** People signing in with an email of a verified domain join as members. */
  readonly domainJoin: boolean;
}

/** What a change asks: either or both. */
export interface SigninChange {
  readonly require?: SigninRequire;
  readonly domainJoin?: boolean;
}

const record = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const domain = (v: unknown): SigninDomain | null => {
  const d = record(v);
  return d !== null && typeof d.domain === "string" && d.domain.length > 0 && d.domain.length <= 253 && (d.state === "verified" || d.state === "pending" || d.state === "failed")
    ? { domain: d.domain, state: d.state }
    : null;
};

/** The service's answer to `GET` (and `POST`) ACCOUNTS_SIGNIN_PATH, checked; null when it isn't one. */
export const readSignin = (json: unknown): SigninState | null => {
  const o = record(json);
  if (o === null || typeof o.domainJoin !== "boolean" || !(o.require === null || o.require === undefined || o.require === "google")) return null;
  if (!Array.isArray(o.domains) || o.domains.length > 50) return null;
  const domains = (o.domains as unknown[]).map(domain);
  if (domains.some((d) => d === null)) return null;
  return { domains: domains as SigninDomain[], require: o.require ?? null, domainJoin: o.domainJoin };
};

// ── The page's words ──────────────────────────────────────────────────────────────────────────────────────────

const andList = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`);

/** The workspace's verified domains, by name. */
export const verifiedDomains = (state: SigninState): string[] => state.domains.filter((d) => d.state === "verified").map((d) => d.domain);

/** A domain's state as its line says it. */
export const domainWord = (d: SigninDomain): string => (d.state === "verified" ? "Verified" : d.state === "pending" ? "Waiting for its DNS record" : "Not verified");

/** "@acme.com", "@acme.com and @acme.io": the domains the join switch names. */
export const atDomains = (domains: readonly string[]): string => andList(domains.map((d) => `@${d}`));

/** The method's choice, in the order the picker lists them. */
export const REQUIRE_CHOICES: ReadonlyArray<{ readonly value: "any" | "google"; readonly label: string }> = [
  { value: "any", label: "Any method" },
  { value: "google", label: "Google only" },
];

/** The picker's value for a requirement, and back. */
export const requireChoice = (r: SigninRequire): "any" | "google" => r ?? "any";
export const requireOf = (choice: string): SigninRequire => (choice === "google" ? "google" : null);

/** Who may sign in now, as the method's hint says it. */
export const requireLine = (r: SigninRequire): string =>
  r === "google"
    ? "Admins and members sign in with their Google account only; any other way is refused."
    : "Everyone signs in with Google, GitHub or an emailed code.";

/** The owners' way in whatever is required, and when a change applies, said under the method. */
export const BREAK_GLASS =
  "Owners are let in however they sign in, so nobody gets locked out. A change applies from each person's next sign-in; anyone already signed in stays signed in.";
