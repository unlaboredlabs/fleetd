// fleetd cloud's Sign in, on a build that has it (src/main/cloud/fixture.ts reads each fixture's `cloud` section):
// the first screen's two ways in, the wait for the browser and how a sign-in fails; back from it, who signed in and
// an invitation asked about before anything connects; Connect a computer on a team with
// no machine yet; the account's row in Settings; People on a team, where owners and admins invite by email; and
// `cloud-admin`, the Hub group as a team's owner sees it, the hub's own controls (Updates, Restart hub, adding a machine
// over SSH, setup steps, creating a GitHub App) gone, as hub_info's leftOut says; and `cloud-github-*`, its GitHub step
// with fleetd's one App: to install, installed, the person's own GitHub to connect first, and a service without the
// App. Without a `cloud` section every other fixture is today's app.
import { alice, answerHub, bob, sam } from "../admin/index.ts";
import { Fixture, PROTOCOL } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject } from "../kit/json.ts";

const TEAM = "https://acme.fleetd.dev";

/** What fleetd cloud's hub_info leaves out: the tools of its port map's `left out:` rows. */
const LEFT_OUT = [
  "hub_update",
  "hub_update_settings",
  "hub_update_status",
  "hub_restart",
  "doctor_list",
  "doctor_fix",
  "setup_list",
  "setup_test",
  "machine_add_plan",
  "machine_add",
  "machine_add_status",
  "machine_hosts",
  "github_app_manifest",
  "github_app_create",
];
const EMAIL = "sam@example.com";

const unpaired = (name: string, note: string, cloud: JsonObject): Fixture => {
  const f = new Fixture(`cloud-${name}`, note);
  f.state = { phase: "unpaired" };
  f.cloud = cloud;
  return f;
};

/** A team of fleetd cloud just signed in to: no machine yet, its person an owner. */
const team = (base: Fixture, name: string, note: string, cloud: JsonObject): Fixture => {
  const f = Fixture.from(base, `cloud-${name}`, note);
  f.state = { phase: "live", hub: TEAM, protocol: PROTOCOL };
  f.label = "acme";
  f.cloud = { email: EMAIL, hub: true, ...cloud };
  if (f.snapshot !== undefined) f.snapshot = { ...f.snapshot, machines: [] };
  f.live = f.live.map((l) => ({ ...l, machines: [] }));
  f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: true });
  f.answer("machine_join", undefined, {
    hubUrl: TEAM,
    code: "fje_7QmK2xVd9LpR4sNw",
    expiresAt: "2026-10-19T09:16:00Z",
    line: `curl -fsSL https://fleetd.sh | sh -s -- --join ${TEAM} --code fje_7QmK2xVd9LpR4sNw`,
    next: "Run the line on the computer: it installs fleetd and joins under the computer's own name.",
  });
  return f;
};

/** Two invites by email waiting on the team: Kai's as a member, Lee's as an admin, newest first. */
const INVITES: JsonObject[] = [
  { inviteId: "inv_2b7c90d1e4", email: "lee@example.com", role: "admin", createdAt: "2026-10-18T15:40:00.000Z", expiresAt: "2026-10-25T15:40:00.000Z" },
  { inviteId: "inv_0a91f3c2b8", email: "kai@example.com", role: "member", createdAt: "2026-10-14T09:10:00.000Z", expiresAt: "2026-10-21T09:10:00.000Z" },
];

/** Settings › Hub › People on the team acme, as `me`, with its invites by email. */
const people = (base: Fixture, name: string, note: string, me: JsonObject, cloud: JsonObject = {}): Fixture => {
  const f = answerHub(Fixture.from(base, `cloud-people-${name}`, note), me, me !== bob);
  f.state = { phase: "live", hub: TEAM, protocol: PROTOCOL };
  f.label = "acme";
  f.cloud = { email: EMAIL, hub: true, invites: INVITES, ...cloud };
  return f;
};

/** Settings' Hub group as the owner of the team acme, whose hub_info leaves the hub's own controls out. */
const admin = (base: Fixture, name: string, note: string, cloud: JsonObject = {}): Fixture => {
  const f = answerHub(Fixture.from(base, name, note));
  f.state = { phase: "live", hub: TEAM, protocol: PROTOCOL };
  f.label = "acme";
  f.cloud = { email: EMAIL, hub: true, ...cloud };
  f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: true, people: 4, url: TEAM, leftOut: LEFT_OUT });
  return f;
};

/** fleetd's one GitHub App as a cloud team's github_app_get answers it (fleetd-cloud src/github/app.ts getApp). */
const fleetdApp = (installations: JsonObject[]): JsonObject => ({
  appId: 5736169,
  slug: "fleetd-cloud",
  name: "fleetd-cloud",
  clientId: "Iv23liX0kkkRsQcthp98",
  owner: "fleetd",
  htmlUrl: "https://github.com/apps/fleetd-cloud",
  settingsUrl: "https://github.com/apps/fleetd-cloud",
  createdAt: installations.length === 0 ? "1970-01-01T00:00:00.000Z" : "2026-10-18T09:00:00.000Z",
  installations,
});

/** The GitHub step on the team acme: fleetd's App (or none, `app` null), and whether Sam's own GitHub is connected. */
const github = (base: Fixture, name: string, note: string, app: JsonObject | null, connected: boolean, cloud: JsonObject = {}): Fixture => {
  const f = admin(base, `cloud-github-${name}`, note, cloud);
  f.answer("github_app_get", undefined, {
    ...(app === null ? {} : { app }),
    permissions: [],
    authorizeUrl: "https://github.com/login/oauth/authorize",
    ...(connected ? { me: { login: "sam-rivera", userId: 10, connectedAt: "2026-10-18T09:20:00.000Z" } } : {}),
    people: [],
  });
  return f;
};

export default defineGroup({
  fixtures: (base) => [
    unpaired("first-screen", "First launch on a build with fleetd cloud: Sign in, and Use your own hub under it.", {}),
    unpaired("sign-in-refused", "Sign in came back from the browser without signing in.", {
      signIn: { failure: { code: "refused", message: "The browser came back without signing you in.", fix: "Nothing was changed. Sign in again." } },
    }),
    unpaired("signed-in", "Back from the browser: who signed in, before anything connects.", {
      signIn: { arrival: { email: EMAIL, invitations: [] } },
    }),
    unpaired("invited", "Back from the browser with an invitation from someone else's team: asked before it connects.", {
      signIn: { arrival: { email: EMAIL, invitations: [{ name: "security", invitedBy: "eve@example.com", role: "admin" }] } },
    }),
    unpaired("sign-in-timeout", "The sign-in page was left unfinished and ran out.", {
      signIn: { failure: { code: "timeout", message: "The sign-in page wasn't finished, so it ran out after 10 minutes." } },
    }),
    team(base("empty"), "connect", "Signed in, the team has no machine: Connect a computer, and a terminal opens.", { terminal: "a terminal" }),
    team(base("empty"), "connect-no-terminal", "Connect a computer where no terminal opens: the line is the way.", {}),
    (() => {
      const f = Fixture.from(base("typical"), "cloud-account", "Settings with a fleetd account signed in, and its team acme.");
      f.state = { phase: "live", hub: TEAM, protocol: PROTOCOL };
      f.label = "acme";
      f.cloud = { email: EMAIL, hub: true };
      f.answer("people_list", undefined, { people: [], devices: [], invites: [] });
      return f;
    })(),
    people(base("chat-empty"), "owner", "People on a cloud team, as its owner: Invite by email, and two invites waiting.", sam),
    people(base("chat-empty"), "admin", "People on a cloud team, as an admin: the same field and list.", alice),
    people(base("chat-empty"), "member", "A member of a cloud team: no People page, so no field and no invites.", bob),
    people(base("chat-empty"), "limit", "People on a cloud team at its limit of people: the invite is refused by the field.", sam, {
      inviteFailure: { code: "failed", message: "This team has reached its limit of people (50).", fix: "Remove one first, or ask fleetd's operator for a higher limit." },
    }),
    github(base("typical"), "install", "GitHub on a cloud team: fleetd's App, installed nowhere yet; the owner's own GitHub is connected, so Install.", fleetdApp([]), true),
    github(
      base("typical"),
      "installed",
      "GitHub on a cloud team with fleetd's App installed on acme's repositories: Test, Install on more, Remove.",
      fleetdApp([{ installationId: 7, account: "acme", allRepositories: false, repositoryCount: 2, repositories: ["acme/web", "acme/api"] }]),
      true,
    ),
    github(base("typical"), "connect-first", "Install on a cloud team that answers 409, the owner's own GitHub no longer taken: Connect GitHub first.", fleetdApp([]), true, {
      githubInstallFailure: {
        connectFirst: true,
        code: "failed",
        message: "Connect your own GitHub first: fleetd asks GitHub, as you, that you administer the account you install it on.",
        fix: "Connect GitHub in Settings › Your accounts › GitHub, then install again.",
      },
    }),
    github(base("typical"), "not-set-up", "GitHub on a cloud team whose service wasn't given fleetd's App.", null, true),
    (() => {
      const f = admin(base("typical"), "cloud-admin", "Settings' Hub group as the owner of a team of fleetd cloud, which leaves its own updates, restart, setup and SSH out.");
      f.answer("machine_join", undefined, {
        machineId: "laptop",
        hubUrl: TEAM,
        code: "fje_7QmK2xVd9LpR4sNw",
        expiresAt: "2026-10-19T10:45:00Z",
        line: `curl -fsSL https://fleetd.sh | sh -s -- --join ${TEAM} --code fje_7QmK2xVd9LpR4sNw --machine-id laptop`,
      });
      return f;
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "cloud-account-signed-out", "Settings on a build with fleetd cloud, not signed in.");
      f.cloud = { signIn: { arrival: { email: EMAIL, invitations: [{ name: "security", invitedBy: "eve@example.com", role: "admin" }] } } };
      f.answer("people_list", undefined, { people: [], devices: [], invites: [] });
      return f;
    })(),
  ],
});
