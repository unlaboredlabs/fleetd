// The setup steps (docs/design/setup.md), as a pure function of the hub's address and its doctor checks. A design
// prototype: the hub will serve these steps itself (setup_list), so `fleetd init`, the first run and Administration ›
// Setup render the same ones. Until then the guide half lives here and the status half comes from doctor_list.

import type { DoctorCheck } from "../../../shared/contracts";
import { REDIRECT, SCOPES, scopeFor, scopeLabel } from "../google/model";

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
  /** A part the step works without: said beside its title, and its fields are optional. */
  readonly optional?: boolean;
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
  /** A pasted file (a JSON key): several lines. */
  readonly multiline?: boolean;
  /** Where a secret is sealed to, said under it, when not the default. */
  readonly note?: string;
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
  /** Where in the app what the provider gives back is saved, in place of fields here. */
  readonly savedIn?: { readonly label: string; readonly hash: string; readonly note: string };
  /** What Test does, in a few words; absent where the checks are the test. */
  readonly test?: string;
  /** The ways to complete the step; one is enough. Most steps have one. */
  readonly ways: ReadonlyArray<Way>;
  /** The way the status was read from, when there is more than one: the one done, else the one that wants a look. */
  readonly way?: string;
}

/**
 * One way to complete a step: its doctor checks (`hub/<name>`, or a star for every machine's), whose worst status
 * is the way's. `label` names it where a step has several ("the hub's API key").
 */
export interface Way {
  readonly label?: string;
  readonly checks: ReadonlyArray<string>;
}

type Guide = Omit<SetupStep, "status" | "said" | "way">;

/**
 * Gmail in real time (D195, #743): Gmail publishes to this topic as its push account, and one machine reads the
 * subscription as this service account, with the Pub/Sub scope. The names google.md gives them.
 */
export const GMAIL_TOPIC = "fleetd-gmail";
export const GMAIL_SUBSCRIPTION = "fleetd-gmail-hub";
const GMAIL_READER = "fleetd-gmail-reader";
const GMAIL_PUSH = "gmail-api-push@system.gserviceaccount.com";

/** The Cloud project the guide names for a hub: `fleetd-<host>`. */
export const cloudProject = (hub: string): string => `fleetd-${new URL(hub.replace(/\/+$/u, "")).hostname.split(".")[0] ?? "hub"}`;

/**
 * The Google step's required parts, for this hub: the Cloud project, the APIs, the sign-in screen with the exact scopes
 * the hub asks for, and a Desktop app client with the loopback redirect. Administration › Google shows the same ones,
 * with google_get's scopes and redirect.
 */
export const googleParts = (hub: string, scopes: ReadonlyArray<string> = SCOPES, redirect: string = REDIRECT): ReadonlyArray<Part> => {
  const host = new URL(hub.replace(/\/+$/u, "")).hostname.split(".")[0] ?? "hub";
  const name = `fleetd on ${host}`;
  return [
    {
      title: "Create a Google Cloud project",
      links: [{ label: "New project", url: "https://console.cloud.google.com/projectcreate" }],
      values: [{ label: "Project name", value: `fleetd-${host}`, note: "Keep the project ID the same as the name." }],
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
      links: [
        { label: "Branding", url: "https://console.cloud.google.com/auth/branding" },
        { label: "Audience", url: "https://console.cloud.google.com/auth/audience" },
      ],
      values: [
        { label: "App name", value: name },
        { label: "Audience", value: "Internal if everyone is in your Google Workspace; otherwise External.", plain: true },
        {
          label: "Publishing status",
          value: "External: press Publish app, so it is In production. In Testing, Google ends each connection after 7 days.",
          plain: true,
        },
      ],
    },
    {
      title: "Add the scopes",
      note: "Gmail and Drive are restricted scopes: until Google verifies the app, people see a warning when they connect and press Advanced, then Go to the app. An unverified app takes up to 100 people.",
      links: [{ label: "Data access", url: "https://console.cloud.google.com/auth/scopes" }],
      values: scopes.map((s) => ({ label: scopeLabel(s), value: s, note: scopeFor(s) })),
    },
    {
      title: "Create the OAuth client",
      links: [{ label: "Create client", url: "https://console.cloud.google.com/auth/clients/create" }],
      values: [
        { label: "Application type", value: "Desktop app", plain: true },
        { label: "Name", value: name },
        {
          label: "Redirect URI",
          value: redirect,
          note: "Nothing to register: a Desktop app client takes it on any port. When someone connects, the fleetd app listens on a free port on their own computer, and Google sends them back there.",
        },
      ],
    },
  ];
};

/**
 * Real-time mail's parts, both optional: the topic Gmail tells and its subscription, then a service account that may
 * only read it, with its key. Administration › Google shows the same ones above its fields.
 */
export const realtimeParts = (hub: string): ReadonlyArray<Part> => {
  const project = cloudProject(hub);
  return [
    {
      title: "Gmail in real time",
      optional: true,
      note: "New mail reaches Navi in seconds. Gmail publishes to a Pub/Sub topic and fleetd pulls from it, so no public address is needed. Without it, Navi checks Gmail about every minute.",
      links: [
        { label: "Enable Pub/Sub", url: "https://console.cloud.google.com/flows/enableapi?apiid=pubsub.googleapis.com" },
        { label: "Create the topic", url: "https://console.cloud.google.com/cloudpubsub/topic/create" },
        { label: "Create the subscription", url: "https://console.cloud.google.com/cloudpubsub/subscription/create" },
      ],
      values: [
        { label: "Topic ID", value: GMAIL_TOPIC, note: `Untick "Add a default subscription". Its full name is projects/${project}/topics/${GMAIL_TOPIC}.` },
        { label: "Publisher on the topic", value: GMAIL_PUSH, note: "Topic › Permissions › Add principal, role Pub/Sub Publisher. Gmail publishes as this account." },
        { label: "Subscription ID", value: GMAIL_SUBSCRIPTION, note: `Topic ${GMAIL_TOPIC}, delivery type Pull. Its full name is projects/${project}/subscriptions/${GMAIL_SUBSCRIPTION}.` },
      ],
    },
    {
      title: "A key to read it",
      optional: true,
      note: "A service account that may only read the subscription. Its key goes to one machine, which pulls new-mail notices and passes them to the hub.",
      links: [
        { label: "Create the service account", url: "https://console.cloud.google.com/iam-admin/serviceaccounts/create" },
        { label: "Subscriptions", url: "https://console.cloud.google.com/cloudpubsub/subscription/list" },
        { label: "Service accounts", url: "https://console.cloud.google.com/iam-admin/serviceaccounts" },
      ],
      values: [
        { label: "Service account ID", value: GMAIL_READER, note: "No project roles: skip the optional steps and press Done." },
        {
          label: "Subscriber on the subscription",
          value: `${GMAIL_READER}@${project}.iam.gserviceaccount.com`,
          note: "Subscriptions › the subscription above › Permissions › Add principal, role Pub/Sub Subscriber.",
        },
        { label: "Key", value: "Service accounts › the account above › Keys › Add key › Create new key › JSON. Paste the downloaded file into Service account key, then delete it.", plain: true },
        {
          label: "Or in Cloud Shell",
          value: [
            `gcloud config set project ${project}`,
            `SA=${GMAIL_READER}@${project}.iam.gserviceaccount.com`,
            [
              `gcloud services enable pubsub.googleapis.com`,
              `gcloud pubsub topics create ${GMAIL_TOPIC}`,
              `gcloud pubsub topics add-iam-policy-binding ${GMAIL_TOPIC} --member=serviceAccount:${GMAIL_PUSH} --role=roles/pubsub.publisher`,
              `gcloud pubsub subscriptions create ${GMAIL_SUBSCRIPTION} --topic=${GMAIL_TOPIC}`,
              `gcloud iam service-accounts create ${GMAIL_READER}`,
              `sleep 30`,
              `gcloud pubsub subscriptions add-iam-policy-binding ${GMAIL_SUBSCRIPTION} --member=serviceAccount:$SA --role=roles/pubsub.subscriber`,
              `gcloud iam service-accounts keys create key.json --iam-account=$SA`,
              `cat key.json && rm key.json`,
            ].join(" &&\n"),
          ].join("\n"),
          note: `Both parts in one go, in project ${project}: it prints the key once, to paste into Service account key. A new account can take a minute to show up; if the Subscriber grant says it doesn't exist, run the last three lines again.`,
        },
      ],
    },
  ];
};

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
      ways: [{ checks: ["hub/reachable", "hub/https"] }],
    },
    {
      id: "machines",
      group: "This hub",
      title: "Machines that run agents",
      why: "Agents run on machines; the hub's own machine can be one.",
      need: { kind: "required" },
      parts: [
        {
          title: "Add a machine",
          values: [
            {
              label: "On the machine",
              value: `fleetd init --join ${base} --code <code>`,
              note: "The one-time code from fleetd pair --worker <name> on the hub. Or, from the hub: fleetd machine add <ssh host>.",
            },
          ],
        },
      ],
      fields: [],
      ways: [{ checks: ["*/online"] }],
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
      // Either is enough: with a hub key, machines need no login of their own (D186).
      ways: [
        { label: "the hub's API key", checks: ["hub/claude_key"] },
        { label: "every machine's own login", checks: ["*/claude_login"] },
      ],
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
          note: "Pick the repositories fleetd works on; you can add more on GitHub later. The link follows the App's name as GitHub saved it.",
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
      ways: [{ checks: ["hub/github_app"] }],
    },
    {
      id: "people",
      group: "People",
      title: "Invite people",
      why: "Each person gets their own sign-in, chats and Navi; you choose who is an admin.",
      need: { kind: "optional" },
      parts: [],
      fields: [{ name: "handle", label: "Their name", placeholder: "alice" }],
      ways: [{ checks: ["hub/people"] }],
    },
    {
      id: "google",
      group: "Integrations",
      title: "Google",
      why: "Each person's Navi reads and drafts their mail, calendar and Drive, through a Google client you own.",
      need: { kind: "optional" },
      parts: [
        ...googleParts(hub),
        ...realtimeParts(hub),
      ],
      fields: [],
      savedIn: {
        label: "Open Administration › Google",
        hash: "#/admin/google",
        note: "Paste the Client ID and secret, and the key for real-time mail, in Administration › Google: it seals them on this device, saves them and tests them. Then each person connects their own account from their Navi.",
      },
      ways: [{ checks: ["hub/google"] }],
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
      ways: [{ checks: ["hub/notion"] }],
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
      ways: [{ checks: ["hub/onepassword"] }],
    },
  ];
};

const RANK: Readonly<Record<DoctorCheck["status"], number>> = { ok: 0, unknown: 1, warn: 2, fail: 3 };

const matches = (pattern: string, id: string): boolean =>
  pattern.startsWith("*/") ? !id.startsWith("hub/") && id.endsWith(pattern.slice(1)) : id === pattern;

type Read = { readonly status: StepStatus; readonly said?: string };

/** One way's status from its checks: none yet, or the worst unknown ("not set up"), is todo; the worst failing or
 * warning is look; all passing is done. */
const readWay = (way: Way, checks: ReadonlyArray<DoctorCheck>): Read => {
  const own = checks.filter((c) => way.checks.some((p) => matches(p, c.id)));
  const worst = own.reduce<DoctorCheck | undefined>((w, c) => (w === undefined || RANK[c.status] > RANK[w.status] ? c : w), undefined);
  const said = worst === undefined ? {} : { said: worst.message };
  if (worst === undefined || worst.status === "unknown") return { status: "todo", ...said };
  return { status: worst.status === "ok" ? "done" : "look", ...said };
};

const BEST: ReadonlyArray<StepStatus> = ["done", "look", "todo"];

/**
 * Each step's status is its best way's: one way done is enough, else one set up but failing wants a look, else it is
 * to do. Skipping is the only state the hub keeps; everything else is read from what is there, so the flow resumes at
 * any point.
 */
export const setupSteps = (
  hub: string,
  checks: ReadonlyArray<DoctorCheck>,
  skipped: ReadonlySet<StepId> = new Set(),
): ReadonlyArray<SetupStep> =>
  guides(hub).map((guide) => {
    const reads = guide.ways.map((way) => ({ way, ...readWay(way, checks) }));
    const best = BEST.flatMap((status) => reads.filter((r) => r.status === status))[0];
    const said = best?.said ?? reads.find((r) => r.said !== undefined)?.said;
    const way = guide.ways.length > 1 && best !== undefined && best.status !== "todo" ? best.way.label : undefined;
    const status = best === undefined || best.status === "todo" ? (skipped.has(guide.id) ? "skipped" : "todo") : best.status;
    return { ...guide, status, ...(said === undefined ? {} : { said }), ...(way === undefined ? {} : { way }) };
  });

/** Required steps left: until none, the app keeps the setup in front; after, it is a quiet line in Administration. */
export const requiredLeft = (steps: ReadonlyArray<SetupStep>): number =>
  steps.filter((s) => s.need.kind === "required" && s.status !== "done").length;

export const needWords = (need: Need): string =>
  need.kind === "required" ? "Required" : need.kind === "before" ? `Before ${need.what}` : "Optional";
