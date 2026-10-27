// The setup steps (docs/design/setup.md), as a pure function of the hub's address and its doctor checks. A design
// prototype: the hub will serve these steps itself (setup_list), so `fleetd init`, the first run and Administration ›
// Setup render the same ones. Until then the guide half lives here and the status half comes from doctor_list.

import type { DoctorCheck } from "../../../shared/contracts";

export type StepId = "address" | "machines" | "claude" | "github" | "people" | "google" | "notion" | "onepassword";

/** Required: agents can't run without it. Before: needed before a feature's first use, never before. Optional. */
export type Need = { readonly kind: "required" } | { readonly kind: "before"; readonly what: string } | { readonly kind: "optional" };

/** done: its checks pass. todo: not set up. look: set up, but a check fails or warns. skipped: the admin said later. */
export type StepStatus = "done" | "todo" | "look" | "skipped";

/** A value for the provider's form, computed for this hub. `note` is how to paste it. */
export interface PasteValue {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  /** Words, not a value: what to pick, tick or leave alone. */
  readonly plain?: boolean;
  /** Filled in by fleetd (a manifest, a link), shown to read and never copied. */
  readonly filled?: boolean;
}

/** A provider's page, opened in the browser. */
export interface Link {
  readonly label: string;
  readonly url: string;
}

/** One numbered part of a step: what to open, then what to fill in there. */
export interface Part {
  readonly title: string;
  readonly note?: string;
  readonly links?: ReadonlyArray<Link>;
  readonly values?: ReadonlyArray<PasteValue>;
}

/** A field for what the provider gives back; `secret` ones are sealed in the app and never come back. */
export interface ResultField {
  readonly name: string;
  readonly label: string;
  readonly secret?: boolean;
  readonly placeholder?: string;
  readonly optional?: boolean;
}

export interface SetupStep {
  readonly id: StepId;
  readonly group: "This hub" | "Accounts" | "People" | "Integrations";
  readonly title: string;
  /** Why it matters, in one line. */
  readonly why: string;
  readonly need: Need;
  readonly status: StepStatus;
  /** What the checks say now: the worst one's message. */
  readonly said?: string;
  readonly parts: ReadonlyArray<Part>;
  /** What comes back from the provider, the last part; `fieldsNote` says what happens after. */
  readonly fields: ReadonlyArray<ResultField>;
  readonly fieldsNote?: string;
  /** What Test does, in a few words; absent where the checks are the test. */
  readonly test?: string;
  /** The doctor checks whose worst status is this step's: `hub/<name>`, or `*` for every machine's. */
  readonly checks: ReadonlyArray<string>;
}

type Guide = Omit<SetupStep, "status" | "said">;

const GOOGLE_SCOPES = [
  { label: "Gmail", value: "https://www.googleapis.com/auth/gmail.modify" },
  { label: "Calendar", value: "https://www.googleapis.com/auth/calendar.events" },
  { label: "Drive", value: "https://www.googleapis.com/auth/drive.readonly" },
];

/** Every step in order, its values computed for `hub` (the URL devices reach it at). */
export const guides = (hub: string): ReadonlyArray<Guide> => {
  const base = hub.replace(/\/+$/u, "");
  const host = new URL(base).hostname.split(".")[0] ?? "hub";
  const name = `fleetd on ${host}`;
  const https = base.startsWith("https://");
  return [
    {
      id: "address",
      group: "This hub",
      title: "Where the hub listens",
      why: "Your devices and machines reach the hub at this address; a tailnet keeps it off the internet.",
      need: { kind: "required" },
      parts: [
        {
          title: "Pick the address",
          note: "Your tailnet keeps it private. HTTPS (Tailscale Serve) is optional: it turns on GitHub's webhooks and Google's web sign-in.",
          links: [{ label: "Tailscale admin", url: "https://login.tailscale.com/admin/machines" }],
          values: [{ label: "Hub address", value: base }],
        },
      ],
      fields: [],
      test: "Reach the hub from this device",
      checks: ["hub/reachable", "hub/https"],
    },
    {
      id: "machines",
      group: "This hub",
      title: "Machines that run agents",
      why: "Agents run on machines; the hub's own machine can be one.",
      need: { kind: "required" },
      parts: [{ title: "Add a machine", values: [{ label: "On the machine", value: "fleetd init --join", note: "or from the hub: fleetd machine add <ssh host>" }] }],
      fields: [],
      checks: ["*/online"],
    },
    {
      id: "claude",
      group: "Accounts",
      title: "Claude",
      why: "Agents think with Claude: a hub API key for everyone, or each person's own subscription.",
      need: { kind: "required" },
      parts: [
        {
          title: "Make a key in the Claude Console",
          links: [{ label: "Claude Console › API keys", url: "https://console.anthropic.com/settings/keys" }],
          values: [
            { label: "Key name", value: name },
            { label: "No key?", value: "Leave it empty: each person connects their own Claude subscription when they first start work.", plain: true },
          ],
        },
      ],
      fields: [
        { name: "apiKey", label: "API key", secret: true, optional: true, placeholder: "sk-ant-…" },
        { name: "endpoint", label: "Endpoint", optional: true, placeholder: "https://api.anthropic.com" },
      ],
      test: "Ask Claude for a one-word answer",
      checks: ["hub/claude_key", "*/claude_login"],
    },
    {
      id: "github",
      group: "Accounts",
      title: "GitHub App",
      why: "One App does the hub's work (the train, merges, CI) and signs each person in, so their PRs open as them.",
      need: { kind: "before", what: "the first PR" },
      parts: [
        {
          title: "Create it on GitHub",
          note: "GitHub opens with all of this filled in. Check the name, press Create, and GitHub hands the App's keys straight back to the hub.",
          links: [
            { label: "Create on my account", url: `${base}/setup/github/new` },
            { label: "Create in an organization…", url: `${base}/setup/github/new?owner=org` },
          ],
          values: [
            { label: "App name", value: name, filled: true },
            { label: "Homepage URL", value: base, filled: true },
            { label: "Sign-in callback", value: `${base}/oauth/github/callback`, filled: true },
            { label: "Repository access", value: "Contents, pull requests and workflows: write. Checks, actions, statuses: read.", plain: true },
            https
              ? { label: "Webhooks", value: `${base}/webhooks/github`, filled: true, note: "On, since the hub has an HTTPS address." }
              : { label: "Webhooks", value: "Off: the hub polls GitHub, as the train already does.", plain: true },
          ],
        },
        {
          title: "Install it on your repositories",
          note: "Pick the repositories fleetd works on; you can add more on GitHub at any time.",
          links: [{ label: "Install the App", url: `https://github.com/apps/fleetd-on-${host}/installations/new` }],
        },
        {
          title: "Connect your own GitHub",
          note: "Your PRs open as you. Everyone else connects theirs the first time their work opens a PR.",
          links: [{ label: "Connect my GitHub", url: `${base}/oauth/github/start` }],
        },
      ],
      fields: [],
      test: "Mint the App's token and list the repositories it reaches",
      checks: ["hub/github_app"],
    },
    {
      id: "people",
      group: "People",
      title: "Invite people",
      why: "Each person gets their own sign-in, chats and Navi; you choose who is an admin.",
      need: { kind: "optional" },
      parts: [],
      fields: [{ name: "handle", label: "Their name", placeholder: "alice" }],
      checks: ["hub/people"],
    },
    {
      id: "google",
      group: "Integrations",
      title: "Google",
      why: "Each person's Navi reads and drafts their mail, calendar and Drive, through a Google client you own.",
      need: { kind: "optional" },
      parts: [
        {
          title: "Create a Google Cloud project",
          links: [{ label: "New project", url: "https://console.cloud.google.com/projectcreate" }],
          values: [{ label: "Project name", value: `fleetd-${host}` }],
        },
        {
          title: "Turn on Gmail, Calendar and Drive",
          links: [
            {
              label: "Enable the three APIs",
              url: "https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com",
            },
          ],
        },
        {
          title: "Set up the sign-in screen",
          links: [{ label: "Google Auth Platform › Branding", url: "https://console.cloud.google.com/auth/branding" }],
          values: [
            { label: "App name", value: name },
            { label: "Audience", value: "Internal if everyone is in your Google Workspace; otherwise External.", plain: true },
            ...GOOGLE_SCOPES.map((s) => ({ ...s, label: `Scope: ${s.label}`, note: "Data access › Add or remove scopes" })),
            {
              label: "Publishing status",
              value: "External: press Publish app, so it is In production. People then click past Google's unverified-app warning once; in Testing their sign-ins would lapse after 7 days.",
              plain: true,
            },
          ],
        },
        {
          title: "Create the OAuth client",
          links: [{ label: "Google Auth Platform › Clients", url: "https://console.cloud.google.com/auth/clients/create" }],
          values: [
            { label: "Application type", value: "Desktop app", plain: true },
            { label: "Name", value: name },
            { label: "Redirect", value: "Nothing to add: the fleetd app catches Google's answer on its own computer (127.0.0.1).", plain: true },
            ...(https
              ? [{ label: "Or, on this HTTPS hub", value: `${base}/oauth/google/callback`, note: "A Web application client with this redirect also signs in from a browser." }]
              : []),
          ],
        },
      ],
      fields: [
        { name: "clientId", label: "Client ID", placeholder: "….apps.googleusercontent.com" },
        { name: "clientSecret", label: "Client secret", secret: true, placeholder: "GOCSPX-…" },
      ],
      fieldsNote: "Then each person connects their own Google account from their Navi; if a sign-in lapses, Navi offers Reconnect.",
      test: "Ask Google whether it knows this client",
      checks: ["hub/google"],
    },
    {
      id: "notion",
      group: "Integrations",
      title: "Notion",
      why: "Navi and leads read and write the pages you share with your own Notion integration.",
      need: { kind: "optional" },
      parts: [
        {
          title: "Make an internal integration",
          links: [{ label: "Notion › Integrations", url: "https://www.notion.so/profile/integrations" }],
          values: [{ label: "Integration name", value: name }],
        },
      ],
      fields: [{ name: "token", label: "Internal integration secret", secret: true, placeholder: "ntn_…" }],
      test: "Search the pages it can see",
      checks: ["hub/notion"],
    },
    {
      id: "onepassword",
      group: "Integrations",
      title: "1Password",
      why: "Agents sign in to sites from a vault you choose, without ever seeing a password.",
      need: { kind: "optional" },
      parts: [
        {
          title: "Make a service account for one vault",
          links: [{ label: "1Password › Service accounts", url: "https://developer.1password.com/docs/service-accounts/get-started/" }],
          values: [{ label: "Service account name", value: name }],
        },
      ],
      fields: [{ name: "token", label: "Service account token", secret: true, placeholder: "ops_…" }],
      test: "Read the vault's item names",
      checks: ["hub/onepassword"],
    },
  ];
};

const RANK: Readonly<Record<DoctorCheck["status"], number>> = { ok: 0, unknown: 1, warn: 2, fail: 3 };

const matches = (pattern: string, id: string): boolean =>
  pattern.startsWith("*/") ? !id.startsWith("hub/") && id.endsWith(pattern.slice(1)) : id === pattern;

/**
 * Each step's status from its checks: none yet, or the worst one unknown ("not set up"), is todo; the worst failing or
 * warning is look; all passing is done. Skipping is the only state the hub keeps; everything else is read from what is
 * there, so the flow resumes at any point.
 */
export const setupSteps = (
  hub: string,
  checks: ReadonlyArray<DoctorCheck>,
  skipped: ReadonlySet<StepId> = new Set(),
): ReadonlyArray<SetupStep> =>
  guides(hub).map((guide) => {
    const own = checks.filter((c) => guide.checks.some((p) => matches(p, c.id)));
    const worst = own.reduce<DoctorCheck | undefined>((w, c) => (w === undefined || RANK[c.status] > RANK[w.status] ? c : w), undefined);
    const said = worst?.message;
    const base = { ...guide, ...(said === undefined ? {} : { said }) };
    if (worst === undefined || worst.status === "unknown") return { ...base, status: skipped.has(guide.id) ? "skipped" : "todo" };
    return { ...base, status: worst.status === "ok" ? "done" : "look" };
  });

/** Required steps left: until none, the app keeps the setup in front; after, it is a quiet line in Administration. */
export const requiredLeft = (steps: ReadonlyArray<SetupStep>): number =>
  steps.filter((s) => s.need.kind === "required" && s.status !== "done").length;

export const needWords = (need: Need): string =>
  need.kind === "required" ? "Required" : need.kind === "before" ? `Before ${need.what}` : "Optional";
