// Get started with sample data, each step of both paths, for the QA screens (qa/registry.ts, `#/start?sample=<name>`)
// and the tests: the page itself reads the hub's own state (state.ts).
import type { StartRepo, StartView } from "./model";
import { settingsPath } from "../../../shared/settingsPages";

const LINE = "curl -fsSL https://fleetd.sh | sh -s -- --join https://sam.fleetd.dev --code 7QK4-M2XD";

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
/** Steps 1 to 3 settled: a computer, Tailscale skipped, Claude logged in there. */
const set = { ...owner, computer: ready, tailscale: { at: "skipped" }, claude: { at: "done", what: "devbox" }, tailnet: false } as const;

export const SAMPLES = {
  // A new team: 1. where agents run, a computer (or a hosted provider).
  computer: { ...owner, computer: { at: "line", line: LINE }, tailscale: { at: "todo" }, claude: { at: "wait" }, github: { at: "todo" }, project: pick },
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
    computer: { at: "hosted_failed", provider: "boat.dev", reason: "boat.dev's sandboxes didn't get ready.", fix: `If it keeps failing, check boat.dev in ${settingsPath(true, "Machines")}.` },
    tailscale: { at: "todo" },
    claude: { at: "wait" },
    github: { at: "todo" },
    project: pick,
  },
  // ...or fleetd's computers, held until the team has a plan or credits: Billing's line and Pick a plan.
  "computers-held": {
    ...owner,
    computer: { at: "computers_held", message: "This team has no plan and no credits, so fleetd can't start a computer for its bots. Pick a plan or buy credits.", canBuy: true },
    tailscale: { at: "todo" },
    claude: { at: "wait" },
    github: { at: "todo" },
    project: pick,
  },
  // 2. Tailscale, optional: Connect and sign in at Tailscale, or Skip.
  tailscale: { ...owner, computer: { at: "hosted", provider: "boat.dev" }, tailscale: { at: "todo" }, claude: { at: "account", provider: "boat.dev" }, tailnet: false, github: { at: "todo" }, project: pick },
  "tailscale-signin": {
    ...owner,
    computer: { at: "hosted", provider: "boat.dev" },
    tailscale: { at: "signin", url: "https://login.tailscale.com/a/1a2b3c" },
    claude: { at: "account", provider: "boat.dev" },
    tailnet: false,
    github: { at: "todo" },
    project: pick,
  },
  // 3. Claude: the hub's API key and its endpoint, or the place's own way in.
  "claude-key": {
    ...owner,
    computer: { at: "hosted", provider: "boat.dev" },
    tailscale: { at: "done", tailnet: "Sam's tailnet" },
    claude: { at: "account", provider: "boat.dev" },
    tailnet: true,
    github: { at: "todo" },
    project: pick,
  },
  // Tailscale skipped: an endpoint on the tailnet says so, with Connect (the QA screen types one).
  "claude-tailnet": {
    ...owner,
    computer: { at: "hosted", provider: "boat.dev" },
    tailscale: { at: "skipped" },
    claude: { at: "account", provider: "boat.dev" },
    tailnet: false,
    github: { at: "todo" },
    project: pick,
  },
  claude: { ...owner, computer: ready, tailscale: { at: "skipped" }, claude: { at: "login", machine: "devbox", login: "start" }, tailnet: false, github: { at: "todo" }, project: pick },
  "claude-blocked": {
    ...owner,
    computer: ready,
    tailscale: { at: "skipped" },
    claude: { at: "login", machine: "devbox", login: "code", url: "https://claude.ai/oauth/authorize", opened: false },
    tailnet: false,
    github: { at: "todo" },
    project: pick,
  },
  "claude-code": { ...owner, computer: ready, tailscale: { at: "skipped" }, claude: { at: "login", machine: "devbox", login: "code" }, tailnet: false, github: { at: "todo" }, project: pick },
  // 4. GitHub, one trip: sign in and choose the repositories.
  github: { ...set, github: { at: "todo" }, project: pick },
  "github-waiting": { ...set, github: { at: "waiting" }, project: pick },
  "github-failed": { ...set, github: { at: "todo", error: "GitHub said the sign-in was cancelled." }, project: pick },
  // 5. A bot: a repository, or an empty one; then its chat opens.
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
