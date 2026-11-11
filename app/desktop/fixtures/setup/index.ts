// The hub admin's setup (screens/setup): a hub `fleetd init` just made on devbox, plain HTTP on its tailnet, at each
// point of its first run. Every answer is the hub's own: steps.json is hub/setup's catalog read from the checks the
// doctor reports at that point, written by `bun scripts/setup-fixtures.ts` (fleetd/scripts/setup-fixtures.ts),
// so the app shows exactly what a hub says. Each fixture answers setup_list and setup_test of any step (as the next
// point finds it); hub_info makes this app's person an admin, who alone sees setup. The pages of the hub's own accounts
// hold their controls (screens/admin/SetupPage.tsx), so each fixture also answers what the hub has of them at that
// point: its Claude API key once Claude is done with it, its GitHub App once GitHub is.
import { Fixture, PROTOCOL } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject } from "../kit/json.ts";
import steps from "./steps.json" with { type: "json" };

type Reads = Readonly<Record<string, JsonObject>>;
interface Scenario {
  readonly requiredLeft: number;
  readonly list: Reads;
  readonly tests: Reads;
}

const guides = steps.guides as unknown as ReadonlyArray<JsonObject & { readonly id: string }>;
const scenarios = steps.scenarios as unknown as Readonly<Record<string, Scenario>>;

/** A step's guide with what a read says of it. */
const step = (id: string, read: JsonObject | undefined): JsonObject => {
  const guide = guides.find((g) => g.id === id);
  if (guide === undefined || read === undefined) throw new Error(`fixtures/setup: no step ${id}`);
  return { ...guide, ...read };
};

const NOTES: Readonly<Record<string, string>> = {
  "setup-fresh": "A hub fleetd init just made on devbox: the hub and devbox up, Claude and GitHub to do (devbox's claude logged out), the rest optional.",
  "setup-claude-logins": "Claude done the plain way: no hub key, devbox's own claude logged in.",
  "setup-github": "Claude done with the hub's API key; GitHub is next, and its Test finds gh logged in on the hub.",
  "setup-done": "Everything required and GitHub done; people left to do.",
  "setup-all": "Every step done: Ada joined, 1Password reads one vault and the agents' Mac is in.",
};

const AT = "2026-10-19T09:01:35.585Z";

/** The hub's Claude accounts: its API key, sealed on devbox and tested, once Claude is done with it; else none. */
const claude = (key: boolean): JsonObject => ({
  ...(key ? { hubApi: { sealedOn: [{ machineId: "devbox", fingerprint: "5ec2e7a1" }], updatedAt: AT, lastTest: { at: AT, machineId: "devbox", ok: true } } } : {}),
  settings: { membersUseHubApi: true },
  leadsRunOn: key ? { kind: "account", account: { kind: "hub" } } : { kind: "machine_login" },
  people: [],
});

/** The hub's GitHub App, installed on acme and tested, once GitHub is done with it; else none. */
const githubApp = (app: boolean): JsonObject => ({
  ...(app
    ? {
        app: {
          appId: 1048576,
          slug: "fleetd-on-devbox",
          name: "fleetd on devbox",
          clientId: "Iv23liQ4fXk8w2ZsT0aB",
          owner: "acme",
          htmlUrl: "https://github.com/apps/fleetd-on-devbox",
          settingsUrl: "https://github.com/organizations/acme/settings/apps/fleetd-on-devbox",
          createdAt: AT,
          installations: [{ installationId: 51234567, account: "acme", allRepositories: false, repositoryCount: 2, repositories: ["acme/storefront", "acme/api"] }],
          lastTest: { at: AT, ok: true, said: '"fleetd on devbox" is installed on acme (2 repositories), and its tokens work.' },
        },
      }
    : {}),
  // What the hub's App asks for (hub/github_app GITHUB_APP_PERMISSIONS).
  permissions: [
    ["contents", "write"],
    ["pull_requests", "write"],
    ["issues", "write"],
    ["workflows", "write"],
    ["statuses", "write"],
    ["actions", "write"],
    ["checks", "read"],
    ["metadata", "read"],
  ],
  authorizeUrl: "https://github.com/login/oauth/authorize",
  people: [],
});

export default defineGroup({
  fixtures: (base) =>
    Object.entries(scenarios).map(([name, sc]) => {
      const f = Fixture.from(base("empty"), name, NOTES[name] ?? name);
      f.state = { phase: "live", hub: steps.hub, protocol: PROTOCOL };
      f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: true });
      f.answer("claude_accounts_get", undefined, claude(sc.list["claude"]?.["way"] === "the hub's API key"));
      f.answer("github_app_get", undefined, githubApp(sc.list["github"]?.["way"] === "the hub's GitHub App"));
      f.answer("usage_status", undefined, { machines: [] });
      f.answer("people_list", undefined, { people: [], devices: [], invites: [] });
      f.answer("setup_list", undefined, {
        steps: guides.map((g) => step(g.id, sc.list[g.id])),
        requiredLeft: sc.requiredLeft,
      });
      for (const [id, read] of Object.entries(sc.tests)) f.answer("setup_test", { step: id }, { step: step(id, read) }, 600);
      return f;
    }),
});
