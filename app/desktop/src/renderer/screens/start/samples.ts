// Get started with sample data, each step of both paths, for the QA screens (qa/registry.ts, `#/start?sample=<name>`)
// and the tests: the page itself reads the hub's own state (state.ts).
import type { StartRepo, StartView } from "./model";
import { settingsPath } from "../../../shared/settingsPages";
import { FLEETD_COMPUTERS } from "../../../shared/providers";

// The code as the cloud mints it: one long token, which the line has to wrap.
const LINE = "curl -fsSL https://fleetd.sh | sh -s -- --join https://sam.fleetd.dev --code fle_q7k4m2xdw9pt3vbn6hc8rj5ysa2ezu4gkf7lwo3xmd6ncp";

const REPOS: readonly StartRepo[] = [
  { owner: "sam-dev", name: "notes-api", pushed: "Today" },
  { owner: "sam-dev", name: "website", pushed: "Yesterday" },
  { owner: "sam-dev", name: "mobile", pushed: "Friday" },
  { owner: "inkwell-labs", name: "billing", pushed: "Nov 9" },
  { owner: "inkwell-labs", name: "design-system", pushed: "Oct 28" },
  { owner: "sam-dev", name: "dotfiles", pushed: "Sep 14" },
  { owner: "sam-dev", name: "advent-2025", pushed: "Dec 2025" },
];

const owner = { who: "owner", team: "sam" } as const;
const ready = { at: "ready", machine: "devbox" } as const;
const pick = { at: "pick", repos: REPOS, query: "" } as const;
/** Steps 1 and 2 settled: a computer, Claude logged in there. */
const set = { ...owner, computer: ready, tailscale: { at: "todo" }, claude: { at: "done", what: "devbox" }, tailnet: false } as const;
/** A new team: its own computer, free, beside fleetd's computers not bought yet. */
const choose = { at: "line", line: LINE, computers: { canBuy: true } } as const;

export const SAMPLES = {
  // A new team: 1. where agents run, a computer of its own or fleetd's computers, Tailscale's Connect under those.
  computer: { ...owner, computer: choose, tailscale: { at: "todo" }, claude: { at: "wait" }, github: { at: "todo" }, project: pick },
  // ...signing in to Tailscale for fleetd's computers, or connected.
  "computer-tailscale-signin": { ...owner, computer: choose, tailscale: { at: "signin", url: "https://login.tailscale.com/a/1a2b3c" }, claude: { at: "wait" }, github: { at: "todo" }, project: pick },
  "computer-tailscale-done": { ...owner, computer: choose, tailscale: { at: "done", tailnet: "Sam's tailnet" }, claude: { at: "wait" }, github: { at: "todo" }, project: pick },
  // ...before fleetd's computers are on for the workspace: its own computer alone.
  "computer-own": { ...owner, computer: { at: "line", line: LINE }, tailscale: { at: "todo" }, claude: { at: "wait" }, github: { at: "todo" }, project: pick },
  unusable: {
    ...owner,
    computer: { at: "unusable", machine: "devbox", reason: "claude is not installed (claude not found). Fix: install Claude Code on devbox, then run claude there once." },
    tailscale: { at: "todo" },
    claude: { at: "wait" },
    github: { at: "todo" },
    project: pick,
  },
  offline: { ...owner, computer: { at: "offline", machine: "devbox" }, tailscale: { at: "todo" }, claude: { at: "wait" }, github: { at: "todo" }, project: pick },
  // ...or a hosted provider whose sandboxes didn't get ready within the wait: why, the fix and Try again.
  "hosted-failed": {
    ...owner,
    computer: { at: "hosted_failed", provider: FLEETD_COMPUTERS, reason: `${FLEETD_COMPUTERS} didn't get ready.`, fix: `If it keeps failing, check ${FLEETD_COMPUTERS} in ${settingsPath(true, "Machines")}.` },
    tailscale: { at: "todo" },
    claude: { at: "wait" },
    github: { at: "todo" },
    project: pick,
  },
  // ...or fleetd's computers, stopped once their credits ran out: open on them, Billing's line and Pick a plan.
  "computers-held": {
    ...owner,
    computer: { ...choose, computers: { canBuy: true, message: "No credits left, so bots on fleetd's computers are stopped. Add credits or pick a plan." } },
    tailscale: { at: "todo" },
    claude: { at: "wait" },
    github: { at: "todo" },
    project: pick,
  },
  // 2. Claude: the hub's API key and its endpoint, or the place's own way in.
  "claude-key": {
    ...owner,
    computer: { at: "hosted", provider: FLEETD_COMPUTERS },
    tailscale: { at: "done", tailnet: "Sam's tailnet" },
    claude: { at: "account", provider: FLEETD_COMPUTERS },
    tailnet: true,
    github: { at: "todo" },
    project: pick,
  },
  // Tailscale not connected: an endpoint on the tailnet says so, with Connect (the QA screen types one).
  "claude-tailnet": {
    ...owner,
    computer: { at: "hosted", provider: FLEETD_COMPUTERS },
    tailscale: { at: "todo" },
    claude: { at: "account", provider: FLEETD_COMPUTERS },
    tailnet: false,
    github: { at: "todo" },
    project: pick,
  },
  claude: { ...owner, computer: ready, tailscale: { at: "todo" }, claude: { at: "login", machine: "devbox", login: "start" }, tailnet: false, github: { at: "todo" }, project: pick },
  "claude-blocked": {
    ...owner,
    computer: ready,
    tailscale: { at: "todo" },
    claude: { at: "login", machine: "devbox", login: "code", url: "https://claude.ai/oauth/authorize", opened: false },
    tailnet: false,
    github: { at: "todo" },
    project: pick,
  },
  "claude-code": { ...owner, computer: ready, tailscale: { at: "todo" }, claude: { at: "login", machine: "devbox", login: "code" }, tailnet: false, github: { at: "todo" }, project: pick },
  // 3. GitHub, one trip: sign in and choose the repositories.
  github: { ...set, github: { at: "todo" }, project: pick },
  "github-waiting": { ...set, github: { at: "waiting" }, project: pick },
  "github-failed": { ...set, github: { at: "todo", error: "GitHub said the sign-in was cancelled." }, project: pick },
  // 4. A bot: a repository, or an empty one; then its chat opens.
  project: { ...set, github: { at: "done", login: "sam-dev" }, project: pick },
  "project-skipped": { ...set, github: { at: "skipped" }, project: pick },
  "project-truncated": { ...set, github: { at: "done", login: "sam-dev" }, project: { ...pick, truncated: true } },
  "project-none": { ...set, github: { at: "done", login: "sam-dev" }, project: { at: "pick", repos: [], query: "", none: true } },
  "project-adding": { ...set, github: { at: "done", login: "sam-dev" }, project: { at: "adding", what: "notes-api", machine: "devbox" } },
  // A teammate who joined inkwell: the team's bots, then their own GitHub.
  teammate: {
    who: "teammate",
    team: "inkwell",
    github: { at: "todo" },
    projects: [
      { key: "devbox/billing", name: "billing", line: "3 agents at work", busy: true },
      { key: "devbox/design-system", name: "design-system", line: "Quiet since Monday", busy: false },
      { key: "devbox/website", name: "website", line: "1 agent at work", busy: true },
    ],
  },
  "teammate-open": {
    who: "teammate",
    team: "inkwell",
    github: { at: "done", login: "ada-l" },
    projects: [
      { key: "devbox/billing", name: "billing", line: "3 agents at work", busy: true },
      { key: "devbox/design-system", name: "design-system", line: "Quiet since Monday", busy: false },
      { key: "devbox/website", name: "website", line: "1 agent at work", busy: true },
    ],
  },
} satisfies Record<string, StartView>;

export type SampleName = keyof typeof SAMPLES;

export const isSample = (name: string): name is SampleName => Object.hasOwn(SAMPLES, name);
