// fleetd cloud's Sign in, on a build that has it (src/main/cloud/fixture.ts reads each fixture's `cloud` section):
// the first screen's two ways in, the wait for the browser and how a sign-in fails; back from it, who signed in and
// an invitation asked about before anything connects; Connect a computer on a team with
// no machine yet; the account's row in Settings, and its Delete account (`cloud-account-delete*`: what goes, a plan that
// stops, and the only owner of a team with others in it held back); People on a team, where owners and admins invite by email; and
// `cloud-admin`, the Hub group as a team's owner sees it, the hub's own controls (Updates, Restart hub, adding a machine
// over SSH, setup steps, creating a GitHub App) gone, as hub_info's leftOut says; and `cloud-github-*`, its GitHub step
// with fleetd's one App: to install, installed, the person's own GitHub to connect first, and a service without the
// App; and `cloud-billing-*`, Settings › Hub › Billing in each state (src/shared/billing.samples.ts): no plan, a plan
// with credits, a declined card, the cap reached, and the service not answering; and fleetd's computers not on yet for
// the team, beside a self-hosted hub, where no Billing shows at all; and `cloud-fleetd-*`, Hub › Machines once
// fleetd's computers are on for the team: with no machine of its own (they alone run its agents), with one (What runs
// where's Linux machine a pick between them), and on a cloud that doesn't answer the pick yet.
// Without a `cloud` section every other fixture is today's app.
import { alice, answerHub, bob, sam } from "../admin/index.ts";
import { BILLING_SAMPLES, type BillingSample } from "../../src/shared/billing.samples.ts";
import { Fixture, HUB, PROTOCOL } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { isObject, type JsonObject, type JsonValue } from "../kit/json.ts";

const TEAM = "https://acme.fleetd.dev";

/** What fleetd cloud's hub_info leaves out: the tools of its port map's `left out:` rows. */
export const LEFT_OUT = [
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
  // Where agents run can be hosted sandboxes too: the team's providers, none connected yet.
  f.answer("sandbox_get", undefined, {
    boxPubKey: "dGVhbS1ib3gta2V5LWZvci1zYW5kYm94LWtleXMtMDAwMDA=",
    placing: true,
    providers: [{ provider: "boat", connected: false, limit: 0 }],
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
  f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: true, people: 4, leftOut: LEFT_OUT });
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

/** Billing on the team acme as its owner, the team answering `GET /billing/v1` as `sample`. */
const billing = (base: Fixture, sample: BillingSample, note: string): Fixture =>
  admin(base, `cloud-billing-${sample}`, note, { billing: BILLING_SAMPLES[sample] as unknown as JsonObject });

/** The hub's runner for fleetd's computers, as a cloud team's snapshot lists it: no machine of the team's. */
const RUNNER = { machineId: "hosted", name: "fleetd's computers", runner: true, status: "online", lastSeenAt: "2026-10-19T10:29:00Z", nodeVersion: "1.0.0" };

/**
 * Hub › Machines on the team acme once fleetd's computers are on for it, on the Team plan (BILLING_SAMPLES.plan): its
 * bots storefront and checkout run there (checkout's computer asleep, storefront's at work with two agents, picked at
 * 8 CPU · 16 GB), 2 of the plan's 10 at once. `own`: billing runs on laptop, a machine of the team's that runs agents,
 * and the team runs its machines first, then fleetd's computers; else every bot runs on fleetd's computers. `older`: a
 * cloud that doesn't answer the pick yet (sandbox_get not found).
 */
const fleetd = (base: Fixture, name: string, note: string, own: boolean, older = false): Fixture => {
  const f = admin(base, `cloud-fleetd-${name}`, note, { billing: BILLING_SAMPLES.plan as unknown as JsonObject });
  const onFleetd = (json: JsonValue): JsonValue => {
    const text = JSON.stringify(json)
      .replaceAll('"machineId":"devbox"', '"machineId":"hosted"')
      .replaceAll('"machineId":"buildbox"', own ? '"machineId":"laptop"' : '"machineId":"hosted"');
    return JSON.parse(text) as JsonValue;
  };
  if (f.snapshot !== undefined) {
    const snap = onFleetd(f.snapshot) as JsonObject;
    const projects = Array.isArray(snap["projects"]) ? snap["projects"].filter(isObject) : [];
    const storefront = projects.find((p) => p["title"] === "storefront");
    const checkout = projects.find((p) => p["title"] === "checkout");
    const chats = (Array.isArray(snap["chats"]) ? snap["chats"].filter(isObject) : []).map((c) =>
      isObject(c["projectRef"]) && c["projectRef"]["projectId"] === checkout?.["projectId"] ? { ...c, leadAsleep: true, leadWorking: false } : c,
    );
    const laptop = { machineId: "laptop", name: "laptop", status: "online", lastSeenAt: "2026-10-19T10:29:00Z", nodeVersion: "1.0.0" };
    f.snapshot = {
      ...snap,
      machines: own ? [laptop, RUNNER] : [RUNNER],
      chats,
      slots: {
        cap: 10,
        used: 2,
        queued: 0,
        perProject: storefront === undefined ? [] : [{ projectRef: { machineId: "hosted", projectId: storefront["projectId"] ?? "" }, maxAgents: 10, running: 2, queued: 0 }],
        hosted: [{ provider: "boat", limit: 10, running: 2 }],
      },
    };
    if (storefront !== undefined) {
      f.answer("project_settings_get", { machineId: "hosted", projectId: storefront["projectId"] ?? "" }, {
        settings: {
          machineId: "hosted",
          projectId: storefront["projectId"] ?? "",
          title: "storefront",
          workspaceRoot: storefront["workspaceRoot"] ?? "",
          env: [],
          setup: { commands: [] },
          computer: { kind: "boat", cpu: 8, memGb: 16 },
        },
      });
    }
  }
  f.live = f.live.map((l) => ({ ...(onFleetd(l) as JsonObject), machines: [] }));
  // The recorded answers (the chat behind Settings among them) follow the bots to where they run now.
  f.calls = f.calls.map((c) => ({
    ...c,
    ...(c.input === undefined ? {} : { input: onFleetd(c.input) as JsonObject }),
    ...(c.output === undefined ? {} : { output: onFleetd(c.output) }),
  }));
  f.events = f.events.map((e) => onFleetd(e) as JsonObject);
  f.timeline = f.timeline.map((t) => ({ ...t, payload: onFleetd(t.payload) as JsonObject }));
  f.update("machine_roles", (out) =>
    isObject(out) && Array.isArray(out["machines"])
      ? { ...out, machines: own ? out["machines"].filter(isObject).filter((m) => m["machineId"] === "laptop").map((m) => ({ ...m, name: "laptop", roles: ["agents", "sessions"] })) : [] }
      : out,
  );
  if (older) f.fail("sandbox_get", undefined, { code: "not_found", message: "fleetd provides the hosted computers here: no workspace brings a key of its own." });
  else f.answer("sandbox_get", undefined, { boxPubKey: "", placing: true, provided: true, providers: [{ provider: "boat", connected: true, limit: 10, running: 2 }], linux: own ? "ours_first" : "boat" });
  return f;
};

export default defineGroup({
  fixtures: (base) => [
    unpaired("first-screen", "First launch on a build with fleetd cloud: Sign in, and Use your own workspace under it.", {}),
    unpaired("sign-in-refused", "Sign in came back from the browser without signing in.", {
      signIn: { failure: { code: "refused", message: "The browser came back without signing you in.", fix: "Nothing was changed. Sign in again." } },
    }),
    unpaired("signed-in", "Back from the browser: who signed in, before anything connects.", {
      signIn: { arrival: { email: EMAIL, invitations: [] } },
    }),
    unpaired("invited", "Back from the browser with an invitation from someone else's workspace: asked before it connects.", {
      signIn: { arrival: { email: EMAIL, invitations: [{ name: "security", invitedBy: "eve@example.com", role: "admin" }] } },
    }),
    unpaired("no-team", "Back from the browser in no workspace of their own, with one invitation: Not now leaves No workspace yet, with Make a workspace.", {
      signIn: { arrival: { email: EMAIL, invitations: [{ name: "security", invitedBy: "eve@example.com", role: "admin" }], canMake: true } },
    }),
    unpaired("sign-in-timeout", "The sign-in page was left unfinished and ran out.", {
      signIn: { failure: { code: "timeout", message: "The sign-in page wasn't finished, so it ran out after 10 minutes." } },
    }),
    team(base("empty"), "connect", "Signed in, the workspace has no machine: Connect a computer, and a terminal opens.", { terminal: "a terminal" }),
    team(base("empty"), "connect-no-terminal", "Connect a computer where no terminal opens: the line is the way.", {}),
    (() => {
      // W743: fleetd's computers connected, its sandboxes stuck coming up: past the wait (3 s in the QA build), why, the fix and
      // Try again.
      const f = team(base("empty"), "hosted-stuck", "Hosted sandboxes connected that never get ready: why, the fix and Try again.", { terminal: "a terminal" });
      f.answer("sandbox_get", undefined, {
        boxPubKey: "dGVhbS1ib3gta2V5LWZvci1zYW5kYm94LWtleXMtMDAwMDA=",
        placing: true,
        providers: [{ provider: "boat", connected: true, limit: 5, check: { at: "2026-10-19T09:00:00Z", ok: true } }],
      });
      const runner = { machineId: "hosted", name: "Hosted sandboxes", runner: true, status: "degraded", degradedReason: "checking the node's runner", lastSeenAt: "2026-10-19T09:00:00Z", nodeVersion: "1.0.0" };
      // The runner joins after the screen opened, as it does once the key is connected: a snapshot after the first.
      if (f.snapshot !== undefined) f.later(800, "snapshot", { ...f.snapshot, cursor: Number(f.snapshot["cursor"] ?? 0) + 1, machines: [runner] });
      return f.settleAt(4_500);
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "cloud-account", "Settings with a fleetd account signed in, and its workspace acme.");
      f.state = { phase: "live", hub: TEAM, protocol: PROTOCOL };
      f.label = "acme";
      f.cloud = { email: EMAIL, hub: true };
      f.answer("people_list", undefined, { people: [], devices: [], invites: [] });
      return f;
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "cloud-workspace-cap", "A fleetd account's workspace acme, whose switcher's New workspace the cloud refuses: its person has made the most.");
      f.state = { phase: "live", hub: TEAM, protocol: PROTOCOL };
      f.label = "acme";
      f.cloud = {
        email: EMAIL,
        hub: true,
        newWorkspaceFailure: { code: "workspace_cap", message: "You've made 10 workspaces, the most one person can have.", fix: "Delete one you don't use in Settings › Workspace, then make a new one." },
      };
      return f;
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "cloud-account-delete", "Delete account: leaving acme, side-project deleted with it and its plan stopping.");
      f.state = { phase: "live", hub: TEAM, protocol: PROTOCOL };
      f.label = "acme";
      f.cloud = { email: EMAIL, hub: true, accountPreview: { deletes: [{ name: "side-project", plan: "Team" }], leaves: ["acme"], blocked: [] } };
      f.answer("people_list", undefined, { people: [], devices: [], invites: [] });
      return f;
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "cloud-account-delete-blocked", "Delete account held back: the only owner of acme, which has other members.");
      f.state = { phase: "live", hub: TEAM, protocol: PROTOCOL };
      f.label = "acme";
      f.cloud = { email: EMAIL, hub: true, accountPreview: { deletes: [], leaves: [], blocked: ["acme"] } };
      f.answer("people_list", undefined, { people: [], devices: [], invites: [] });
      return f;
    })(),
    people(base("chat-empty"), "owner", "People on a cloud workspace, as its owner: Invite by email, and two invites waiting.", sam),
    people(base("chat-empty"), "admin", "People on a cloud workspace, as an admin: the same field and list.", alice),
    people(base("chat-empty"), "member", "A member of a cloud workspace: no People page, so no field and no invites.", bob),
    people(base("chat-empty"), "limit", "People on a cloud workspace at its limit of people: the invite is refused by the field.", sam, {
      inviteFailure: { code: "failed", message: "This workspace has reached its limit of people (50).", fix: "Remove one first, or ask fleetd's operator for a higher limit." },
    }),
    github(base("typical"), "install", "GitHub on a cloud workspace: fleetd's App, installed nowhere yet; the owner's own GitHub is connected, so Install.", fleetdApp([]), true),
    github(
      base("typical"),
      "installed",
      "GitHub on a cloud workspace with fleetd's App installed on acme's repositories: Test, Install on more, Remove.",
      fleetdApp([{ installationId: 7, account: "acme", allRepositories: false, repositoryCount: 2, repositories: ["acme/web", "acme/api"] }]),
      true,
    ),
    github(base("typical"), "connect-first", "Install on a cloud workspace that answers 409, the owner's own GitHub no longer taken: Connect GitHub first.", fleetdApp([]), true, {
      githubInstallFailure: {
        connectFirst: true,
        code: "failed",
        message: "Connect your own GitHub first: fleetd asks GitHub, as you, that you administer the account you install it on.",
        fix: "Connect GitHub in Settings › Accounts › GitHub, then install again.",
      },
    }),
    github(base("typical"), "not-set-up", "GitHub on a cloud workspace whose service wasn't given fleetd's App.", null, true),
    (() => {
      const f = admin(base("typical"), "cloud-admin", "Settings' Workspace group as the owner of a workspace of fleetd cloud, which leaves its own updates, restart, setup and SSH out.");
      f.answer("machine_join", undefined, {
        machineId: "laptop",
        hubUrl: TEAM,
        code: "fje_7QmK2xVd9LpR4sNw",
        expiresAt: "2026-10-19T10:45:00Z",
        line: `curl -fsSL https://fleetd.sh | sh -s -- --join ${TEAM} --code fje_7QmK2xVd9LpR4sNw --machine-id laptop`,
      });
      return f;
    })(),
    billing(base("typical"), "none", "Billing on a cloud workspace with no plan and no credits: one line with Add credits, Pick a plan, nothing used."),
    billing(base("typical"), "plan", "Billing on the Team plan with credits left, $10 lapsing within 30 days, two sizes used and a cap."),
    billing(base("typical"), "failed", "Billing after the Team plan's card was declined: one line with Update card, and the plan ends."),
    billing(base("typical"), "cap", "Billing with this month's spend cap reached: one line with Raise cap."),
    (() => {
      const f = billing(base("typical"), "off", "Settings on a workspace before fleetd's computers are on for it, beside a self-hosted workspace: no Billing anywhere.");
      const own = answerHub(Fixture.from(base("typical"), "cloud-billing-off-devbox", "devbox, a self-hosted workspace Sam owns"));
      own.state = { phase: "live", hub: HUB, protocol: PROTOCOL };
      f.hubs = [{ label: "devbox", color: "blue", fixture: own }];
      return f;
    })(),
    fleetd(base("typical"), "only", "Machines on a workspace on fleetd's computers with no machine of its own: they run its bots, at once and time used.", false),
    fleetd(base("typical"), "own", "Machines on a workspace with a machine of its own and fleetd's computers: Linux machine picks between them.", true),
    fleetd(base("typical"), "older", "Machines on fleetd's computers where the cloud doesn't answer the pick yet: still says where agents run.", false, true),
    admin(base("typical"), "cloud-billing-unreachable", "Billing when the workspace doesn't answer: why, and Try again.", {
      billingFailure: { code: "offline", message: "Can't reach acme.", fix: "Check your connection, then try again." },
    }),
    (() => {
      const f = Fixture.from(base("typical"), "cloud-account-signed-out", "Settings on a build with fleetd cloud, not signed in.");
      f.cloud = { signIn: { arrival: { email: EMAIL, invitations: [{ name: "security", invitedBy: "eve@example.com", role: "admin" }] } } };
      f.answer("people_list", undefined, { people: [], devices: [], invites: [] });
      return f;
    })(),
  ],
});
