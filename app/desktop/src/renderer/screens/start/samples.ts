// Get started with sample data, each step of both paths, for the QA screens (qa/registry.ts, `#/start?sample=<name>`)
// until the page reads the hub's own state.
import type { StartRepo, StartView } from "./model";

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

export const SAMPLES = {
  // A new team: 1. a computer, and its Claude login when it isn't logged in.
  computer: { ...owner, computer: { at: "line", line: LINE }, github: { at: "todo" }, project: { at: "pick", repos: REPOS, query: "" } },
  claude: { ...owner, computer: { at: "claude", machine: "devbox", login: "start" }, github: { at: "todo" }, project: { at: "pick", repos: REPOS, query: "" } },
  "claude-code": { ...owner, computer: { at: "claude", machine: "devbox", login: "code" }, github: { at: "todo" }, project: { at: "pick", repos: REPOS, query: "" } },
  // 2. GitHub, one trip: sign in and choose the repositories.
  github: { ...owner, computer: ready, github: { at: "todo" }, project: { at: "pick", repos: REPOS, query: "" } },
  "github-waiting": { ...owner, computer: ready, github: { at: "waiting" }, project: { at: "pick", repos: REPOS, query: "" } },
  // 3. A project: a repository, or an empty one; then its chat opens.
  project: { ...owner, computer: ready, github: { at: "done", login: "sam-dev" }, project: { at: "pick", repos: REPOS, query: "" } },
  "project-skipped": { ...owner, computer: ready, github: { at: "skipped" }, project: { at: "pick", repos: REPOS, query: "" } },
  "project-adding": { ...owner, computer: ready, github: { at: "done", login: "sam-dev" }, project: { at: "adding", what: "notes-api", machine: "devbox" } },
  // A teammate who joined inkwell: their own GitHub, then the team's projects.
  teammate: {
    who: "teammate",
    team: "inkwell",
    github: { at: "todo" },
    projects: [
      { name: "billing", line: "3 agents at work", busy: true },
      { name: "design-system", line: "Quiet since Monday", busy: false },
      { name: "website", line: "1 agent at work", busy: true },
    ],
  },
  "teammate-open": {
    who: "teammate",
    team: "inkwell",
    github: { at: "done", login: "ada-l" },
    projects: [
      { name: "billing", line: "3 agents at work", busy: true },
      { name: "design-system", line: "Quiet since Monday", busy: false },
      { name: "website", line: "1 agent at work", busy: true },
    ],
  },
} satisfies Record<string, StartView>;

export type SampleName = keyof typeof SAMPLES;

export const isSample = (name: string): name is SampleName => Object.hasOwn(SAMPLES, name);
