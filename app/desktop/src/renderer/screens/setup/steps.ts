// The setup steps (docs/design/setup.md), as a pure function of the hub's address and its doctor checks. A design
// prototype: the hub will serve these steps itself (setup_list), so `fleetd init`, the first run and Administration ›
// Setup render the same ones. Until then the guide half lives here and the status half comes from doctor_list.

import type { DoctorCheck } from "../../../shared/contracts";

export type StepId = "address" | "machines" | "claude" | "github" | "hub-github" | "people" | "google" | "notion" | "onepassword";

/** Required: agents can't run without it. Before: needed before a feature's first use, never before. Optional. */
export type Need = { readonly kind: "required" } | { readonly kind: "before"; readonly what: string } | { readonly kind: "optional" };

/** done: its checks pass. todo: not set up. look: set up, but a check fails or warns. skipped: the admin said later. */
export type StepStatus = "done" | "todo" | "look" | "skipped";

/** A value to paste into the provider's form, computed for this hub. `note` is how to paste it. */
export interface PasteValue {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  /** Not a value to copy: what to tick or leave alone. */
  readonly plain?: boolean;
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
  /** What the checks say now: the first failing one's message, else the passing one's. */
  readonly said?: string;
  /** The provider's page for this step, opened in the browser. */
  readonly link?: { readonly site: string; readonly label: string; readonly url: string };
  readonly values: ReadonlyArray<PasteValue>;
  readonly fields: ReadonlyArray<ResultField>;
  /** What Test does, in a few words; absent where the checks are the test. */
  readonly test?: string;
  /** The doctor checks whose worst status is this step's: `hub/<name>`, or `*` for every machine's. */
  readonly checks: ReadonlyArray<string>;
}

type Guide = Omit<SetupStep, "status" | "said">;

/** Every step in order, its paste values computed for `hub` (the URL devices reach it at). */
export const guides = (hub: string): ReadonlyArray<Guide> => {
  const base = hub.replace(/\/+$/u, "");
  const host = new URL(base).hostname.split(".")[0] ?? "hub";
  return [
    {
      id: "address",
      group: "This hub",
      title: "Where the hub listens",
      why: "Your devices and machines reach the hub at this address; a tailnet keeps it off the internet.",
      need: { kind: "required" },
      link: { site: "Tailscale", label: "Tailscale admin", url: "https://login.tailscale.com/admin/machines" },
      values: [{ label: "Hub address", value: base }],
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
      values: [{ label: "On the machine", value: "fleetd init --join", note: "or from the hub: fleetd machine add <ssh host>" }],
      fields: [],
      checks: ["*/online"],
    },
    {
      id: "claude",
      group: "Accounts",
      title: "Claude",
      why: "Agents think with Claude: a hub API key for everyone, or each person's own subscription.",
      need: { kind: "required" },
      link: { site: "the Claude Console", label: "Claude Console › API keys", url: "https://console.anthropic.com/settings/keys" },
      values: [
        { label: "Key name", value: `fleetd on ${host}` },
        { label: "No key?", value: "Leave it empty: each person connects their own Claude subscription when they first start work.", plain: true },
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
      title: "GitHub OAuth app",
      why: "Each person connects their own GitHub through it, so PRs open as the person who asked.",
      need: { kind: "before", what: "the first PR" },
      link: { site: "GitHub", label: "Register a new OAuth app", url: "https://github.com/settings/applications/new" },
      values: [
        { label: "Application name", value: `fleetd on ${host}` },
        { label: "Homepage URL", value: base },
        { label: "Authorization callback URL", value: `${base}/oauth/github/callback`, note: "Exactly this, no trailing slash." },
        { label: "Enable Device Flow", value: "Tick it: the terminal and other devices connect with a code.", plain: true },
      ],
      fields: [
        { name: "clientId", label: "Client ID", placeholder: "Ov23li…" },
        { name: "clientSecret", label: "Client secret", secret: true, placeholder: "Generate a new client secret, then paste it" },
      ],
      test: "Ask GitHub whether it knows this app",
      checks: ["hub/github_app"],
    },
    {
      id: "hub-github",
      group: "Accounts",
      title: "The hub's own GitHub login",
      why: "The merge train and work nobody asked for (automations) use the hub's account, never a person's.",
      need: { kind: "before", what: "the first merge" },
      link: { site: "GitHub", label: "New fine-grained token", url: "https://github.com/settings/personal-access-tokens/new" },
      values: [{ label: "On the hub", value: "gh auth login", note: "or a bot account's token below" }],
      fields: [{ name: "token", label: "Token", secret: true, optional: true, placeholder: "github_pat_…" }],
      checks: ["hub/gh_auth", "hub/commit_identity"],
    },
    {
      id: "people",
      group: "People",
      title: "Invite people",
      why: "Each person gets their own sign-in, chats and Navi; you choose who is an admin.",
      need: { kind: "optional" },
      values: [],
      fields: [{ name: "handle", label: "Their name", placeholder: "alice" }],
      checks: ["hub/people"],
    },
    {
      id: "google",
      group: "Integrations",
      title: "Google, through xaq",
      why: "Navi reads and drafts mail and calendar through your own xaq server and Google Cloud app.",
      need: { kind: "optional" },
      link: { site: "xaq", label: "xaq's setup", url: "https://github.com/wynn-dev/xaq" },
      values: [{ label: "Agent name in xaq", value: `fleetd on ${host}` }],
      fields: [
        { name: "url", label: "xaq MCP URL", placeholder: "https://xaq.your-tailnet.ts.net/mcp" },
        { name: "token", label: "Agent token", secret: true },
      ],
      test: "List xaq's tools",
      checks: ["hub/google"],
    },
    {
      id: "notion",
      group: "Integrations",
      title: "Notion",
      why: "Navi and leads read and write the pages you share with your own Notion integration.",
      need: { kind: "optional" },
      link: { site: "Notion", label: "Notion › Integrations", url: "https://www.notion.so/profile/integrations" },
      values: [{ label: "Integration name", value: `fleetd on ${host}` }],
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
      link: { site: "1Password", label: "1Password › Service accounts", url: "https://developer.1password.com/docs/service-accounts/get-started/" },
      values: [{ label: "Service account name", value: `fleetd on ${host}` }],
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
