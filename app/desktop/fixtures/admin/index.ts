// The Hub group's fixtures: an owner's hub with three people and an invite waiting, seen by its owner (`admin-owner`),
// by an admin (`admin-admin`, who may not touch the owner) and by a member (`admin-member`, who sees no Hub group
// at all). The people calls follow contracts PR #640 (people_list, invite_create, invite_revoke, person_set,
// person_remove); hub_info names who this app's person is. `admin-claude-member`: Bob on a hub that keeps its Claude API key
// for leads, with no subscription of his own.
import { defineGroup } from "../kit/group.ts";
import { Fixture, HUB } from "../kit/fixture.ts";
import { asText, type JsonObject } from "../kit/json.ts";
import { profilesList } from "../settings/profiles.ts";
import steps from "../setup/steps.json" with { type: "json" };

const AT = "2026-10-12T09:00:00.000Z";
const person = (personId: string, name: string, role: string, createdAt = AT): JsonObject => ({ personId, name, role, createdAt });
const ref = (p: JsonObject): JsonObject => ({ personId: p["personId"] ?? "", name: p["name"] ?? "" });

export const sam = person("p_aaaaaaaa", "Sam Rivera", "owner", "2026-09-01T08:00:00.000Z");
export const alice = person("p_bbbbbbbb", "Alice Chen", "admin");
export const bob = person("p_cccccccc", "Bob Okafor", "member", "2026-10-14T16:20:00.000Z");
const dana = person("p_dddddddd", "Dana Ito", "member", "2026-10-18T11:00:00.000Z");
/** The people as a chat message names them (ChatMessage.person): Sam is the app's, the others write from theirs. */
export const PEOPLE = { sam: ref(sam), alice: ref(alice), bob: ref(bob) } as const;

const device = (keyId: string, name: string, p: JsonObject, lastUsedAt: string): JsonObject => ({
  keyId,
  name,
  prefix: keyId.slice(0, 10),
  kind: "human",
  grants: [{ role: "admin", machines: "*" }],
  createdAt: AT,
  lastUsedAt,
  person: ref(p),
});

const people = (me: JsonObject): JsonObject => ({
  people: [sam, alice, bob, dana],
  devices: [
    device("fld_samaaa", "Sam's MacBook", sam, "2026-10-19T10:21:00.000Z"),
    device("fld_sambbb", "Sam's phone", sam, "2026-10-18T19:02:00.000Z"),
    device("fld_alicea", "Alice's ThinkPad", alice, "2026-10-19T09:40:00.000Z"),
    device("fld_bobaaa", "Bob's iMac", bob, "2026-10-17T14:12:00.000Z"),
  ],
  invites: [
    {
      inviteId: "inv_aaaaaaaa",
      person: ref(dana),
      state: "open",
      createdAt: "2026-10-18T11:00:00.000Z",
      expiresAt: "2026-10-25T11:00:00.000Z",
      createdBy: ref(sam),
    },
  ],
  me: me["personId"] ?? "",
});

const hubInfo = (me: JsonObject, admin: boolean): JsonObject => ({ version: "0.9.0", protocol: 1, busy: [], admin, me, people: 4 });

// Teams step 8 (contracts PR #744): the hub's API key on devbox and buildbox, tested; Sam's own subscription, which
// leads fall back to; Alice on the hub's key by choice; Bob with no subscription; Sam's subscription paused on devbox.
const sealedOn = [
  { machineId: "buildbox", fingerprint: "4f2a91c0" },
  { machineId: "devbox", fingerprint: "4f2a91c0" },
];
const tested = (at: string, ok = true): JsonObject => ({ at, machineId: "devbox", ok });
const ownAccount = (p: JsonObject): JsonObject => ({ kind: "account", account: { kind: "person", personId: p["personId"] ?? "" } });
const hubAccount: JsonObject = { kind: "account", account: { kind: "hub" } };
const claudeOf = (membersUseHubApi: boolean): Record<string, JsonObject> => ({
  [sam["personId"] as string]: {
    person: ref(sam),
    mayUseHubApi: true,
    subscription: { sealedOn, connectedAt: "2026-10-12T09:30:00.000Z", lastTest: tested("2026-10-19T08:12:00.000Z") },
    runsOn: ownAccount(sam),
  },
  [alice["personId"] as string]: { person: ref(alice), choice: "hub_api", mayUseHubApi: true, runsOn: hubAccount },
  [bob["personId"] as string]: membersUseHubApi
    ? { person: ref(bob), mayUseHubApi: true, runsOn: hubAccount }
    : {
        person: ref(bob),
        mayUseHubApi: false,
        runsOn: {
          kind: "refused",
          message: "Connect your Claude to start this order.",
          fix: "Members may not use the workspace's API on this workspace: connect your subscription in Settings › Claude (paste the token `claude setup-token` prints).",
        },
      },
  [dana["personId"] as string]: { person: ref(dana), mayUseHubApi: membersUseHubApi, runsOn: membersUseHubApi ? hubAccount : { kind: "refused", message: "Connect your Claude to start this order.", fix: "Open Settings › Claude." } },
});
const claudeAccounts = (me: JsonObject, admin: boolean, membersUseHubApi: boolean): JsonObject => {
  const all = claudeOf(membersUseHubApi);
  return {
    hubApi: { sealedOn, updatedAt: "2026-10-12T09:20:00.000Z", updatedBy: ref(sam), lastTest: tested("2026-10-19T08:10:00.000Z") },
    settings: { membersUseHubApi },
    leadsRunOn: hubAccount,
    me: all[me["personId"] as string] ?? null,
    people: admin ? Object.values(all) : [],
  };
};
const usageStatus: JsonObject = {
  machines: [
    {
      machineId: "devbox",
      login: "subscription",
      breaker: { state: "closed" },
      parked: { leads: 0, tasks: 0 },
      accounts: [
        { account: { kind: "hub" }, breaker: { state: "closed" }, parked: { leads: 0, tasks: 0 } },
        {
          account: { kind: "person", personId: sam["personId"] ?? "" },
          breaker: { state: "open", since: "2026-10-19T09:40:00.000Z", until: "2026-10-19T14:00:00.000Z", class: "usage_limit", message: "Usage limit reached" },
          parked: { leads: 0, tasks: 2 },
        },
      ],
      lastEvents: [],
    },
  ],
};

/**
 * The hub's setup steps as it reads them here (setup_list; steps.json's `team`, the hub's own words): Claude on the
 * hub's key, GitHub on gh while the App is installed nowhere, Sam's 1Password token reading two vaults, which asks
 * for a look, and a Mac for agents still to add. Test finds each step as it is.
 */
const setup = (f: Fixture): void => {
  const guides = steps.guides as unknown as ReadonlyArray<JsonObject & { readonly id: string }>;
  const team = steps.team as unknown as { readonly requiredLeft: number; readonly list: Readonly<Record<string, JsonObject>> };
  const list = guides.map((g) => ({ ...g, ...team.list[g.id] }));
  f.answer("setup_list", undefined, { steps: list, requiredLeft: team.requiredLeft });
  for (const step of list) f.answer("setup_test", { step: step.id }, { step }, 600);
};

/**
 * Settings › Workspace › Audit log: a morning of Sam's workspace, newest first, by name: an admin's safety changes, a
 * member's refused one, the vault, an approval, a merge and the people pages; older rows behind Older.
 */
const auditList = (f: Fixture): void => {
  const at = (minutesAgo: number) => new Date(Date.parse(f.now) - minutesAgo * 60_000).toISOString();
  const by = (p: JsonObject) => ({ kind: "person", personId: p["personId"] ?? "", name: p["name"] ?? "" });
  const bot = (name: string) => ({ machineId: name === "billing" ? "buildbox" : "devbox", projectId: `bot-${name}`, name });
  const rows: JsonObject[] = [
    { at: at(4), kind: "bot.settings", actor: by(alice), bot: bot("storefront"), target: "Approvals", outcome: "ok", summary: "Set approvals to Ask me" },
    { at: at(9), kind: "bot.settings", actor: by(bob), bot: bot("storefront"), target: "Merging", outcome: "refused", summary: "Tried to set who merges to fleetd" },
    { at: at(15), kind: "vault.filled", actor: { kind: "agent", personId: "p_aaaaaaaa", name: "Sam Rivera's agent" }, bot: bot("checkout"), target: "Stripe test login", outcome: "ok", summary: 'Filled "Stripe test login" on dashboard.stripe.com' },
    { at: at(22), kind: "pr.merged", actor: { kind: "workspace", name: "fleetd's merge train" }, bot: bot("docs"), target: "#412", outcome: "ok", summary: "Merged #412 into acme/docs" },
    { at: at(31), kind: "approval.answered", actor: by(sam), bot: bot("billing"), target: "approval", outcome: "ok", summary: "Approved: Run the database migration on staging" },
    { at: at(48), kind: "vault.revealed", actor: by(alice), target: "AWS root", outcome: "ok", summary: 'Showed "AWS root"' },
    { at: at(62), kind: "bot.settings", actor: by(sam), bot: bot("billing"), target: "Max agents", outcome: "ok", summary: "Set max agents to 4" },
    { at: at(75), kind: "vault.refused", actor: { kind: "agent", name: "An agent" }, bot: bot("search"), target: "GitHub login", outcome: "refused", summary: 'Was refused a fill of "GitHub login" on github-login.example.net' },
    { at: at(90), kind: "connection.added", actor: by(alice), target: "the workspace's tool server linear", outcome: "ok", summary: "Connected the workspace's tool server linear" },
    { at: at(130), kind: "person.role", actor: by(sam), target: "Alice Chen", outcome: "ok", summary: "Changed Alice Chen's role from member to admin" },
    { at: at(160), kind: "device.added", actor: by(bob), target: "Bob's MacBook", outcome: "ok", summary: "Added the device Bob's MacBook" },
    { at: at(161), kind: "person.joined", actor: by(bob), target: "Bob Okafor", outcome: "ok", summary: "Bob Okafor joined the workspace on Bob's MacBook" },
    { at: at(200), kind: "invite.created", actor: by(sam), target: "Bob Okafor", outcome: "ok", summary: "Invited Bob Okafor as member" },
    { at: at(60 * 26), kind: "bot.erased", actor: by(sam), bot: bot("analytics"), target: "analytics", outcome: "ok", summary: 'Deleted the bot "analytics"' },
    { at: at(60 * 30), kind: "workspace.settings", actor: by(alice), target: "Updates", outcome: "ok", summary: "Changed how the workspace updates" },
  ].map((r, i, all) => ({ n: 9000 + all.length - i, ...r }));
  f.answer("audit_list", undefined, { events: rows, more: true });
};

/** The owner's hub as `me` sees it, with every write answered as the hub would. */
function hub(from: Fixture, name: string, note: string, me: JsonObject, admin: boolean, membersUseHubApi = true): Fixture {
  return answerHub(Fixture.from(from, name, note), me, admin, membersUseHubApi);
}

/** Sam's hub, its people and its links, answered on `f` as `me` sees them (the showcase's Hub group too). */
export function answerHub(f: Fixture, me: JsonObject = sam, admin = true, membersUseHubApi = true): Fixture {
  f.answer("hub_info", undefined, hubInfo(me, admin));
  f.answer("claude_accounts_get", undefined, claudeAccounts(me, admin, membersUseHubApi));
  setup(f);
  // Sam saved a 1Password service account that reads two vaults; anyone else has none yet.
  const vaults = { at: "2026-10-19T09:20:00.000Z", machineId: "devbox", ok: true, vaults: ["Agents", "Shared logins"] };
  f.answer("onepassword_get", undefined, me === sam ? { token: { sealedOn: [{ machineId: "buildbox", fingerprint: "0b5e55ed" }, { machineId: "devbox", fingerprint: "0b5e55ed" }], savedAt: "2026-10-19T09:20:00.000Z", lastTest: vaults } } : {});
  f.answer("onepassword_test", undefined, { test: { ...vaults, at: f.now } });
  f.answer("usage_status", undefined, usageStatus);
  f.answer("people_list", undefined, people(me));
  if (admin) auditList(f);
  // Settings › You › General, Name: the hub keeps a name as typed, trimmed, and refuses an empty one in its own words.
  const renamed = `${asText(me["name"])} Jr.`;
  f.answer("person_name_set", { name: renamed }, { person: { ...me, name: renamed } });
  f.fail("person_name_set", { name: "" }, { code: "invalid", message: "The name is empty.", fix: "Type the name you go by." });
  const eve = person("p_eeeeeeee", "Eve Park", "member", f.now);
  f.answer("invite_create", undefined, {
    invite: { inviteId: "inv_bbbbbbbb", person: ref(eve), state: "open", createdAt: f.now, expiresAt: "2026-10-26T10:30:00.000Z", createdBy: ref(me) },
    code: "K7QM-4XWD",
    link: `fleetd://pair?hub=${encodeURIComponent(HUB)}&code=K7QM-4XWD`,
    hubUrl: HUB,
  });
  // Pair a phone (Settings › Hubs & devices): a 15-minute code, at the address the app reaches the hub at.
  f.answer("pair_code_create", undefined, {
    code: "R4TN-8HQC",
    link: `fleetd://pair?hub=${encodeURIComponent(HUB)}&code=R4TN-8HQC`,
    hubUrl: HUB,
    expiresAt: new Date(Date.parse(f.now) + 15 * 60_000).toISOString(),
  });
  f.answer("invite_revoke", undefined, {
    invite: { inviteId: "inv_aaaaaaaa", person: ref(dana), state: "revoked", createdAt: "2026-10-18T11:00:00.000Z", expiresAt: "2026-10-25T11:00:00.000Z", revokedAt: f.now },
  });
  for (const role of ["owner", "admin", "member"]) f.answer("person_set", { personId: "p_cccccccc", role }, { person: { ...bob, role } });
  f.answer("person_remove", undefined, { person: { ...bob, removedAt: f.now }, revoked: 1 });
  // Every project › Agents: the hub's task profiles.
  f.answer("profiles_list", {}, profilesList());
  // Providers: Google not connected yet, devbox the one machine to sign in, its Google page waiting for the code.
  answerGoogle(f, { machines: [{ machineId: "devbox", checked: true }], keyIn: [] });
  // The hub's GitHub App, and everyone's connection through it, for People's rows: Sam's and Alice's connected,
  // Bob's not yet. A member is answered with their own only.
  const login = (l: string): JsonObject => ({ login: l, userId: l.length, connectedAt: "2026-10-18T09:20:00.000Z" });
  f.answer("github_app_get", undefined, {
    app: { appId: 1048576, slug: "fleetd-on-devbox", name: "fleetd on devbox", clientId: "Iv23liQ4fXk8w2ZsT0aB", owner: "acme", htmlUrl: "https://github.com/apps/fleetd-on-devbox", settingsUrl: "https://github.com/organizations/acme/settings/apps/fleetd-on-devbox", createdAt: "2026-10-18T09:00:00.000Z" },
    permissions: [],
    authorizeUrl: "https://github.com/login/oauth/authorize",
    ...(me === sam ? { me: login("sam-rivera") } : {}),
    people: admin
      ? [
          { person: ref(sam), account: login("sam-rivera") },
          { person: ref(alice), account: login("alice-chen") },
          { person: ref(bob) },
        ]
      : [],
  });
  // Every project's global MCP servers: GitHub's, its token sealed on every machine.
  f.answer("mcp_servers_get", undefined, {
    global: [
      {
        scope: { kind: "global" },
        name: "github",
        enabled: true,
        roles: { lead: true, writers: true, reviewers: false },
        transport: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        headers: [{ name: "Authorization", kind: "secret", sealedOn: [{ machineId: "buildbox", fingerprint: "5ec2e7a1" }, { machineId: "devbox", fingerprint: "5ec2e7a1" }] }],
        updatedAt: "2026-10-15T09:30:00.000Z",
      },
    ],
    project: [],
  });
  return f;
}

/** A hub from before people: an admin key, and no people tools, which it says as it says of any unknown tool. */
function oldHub(from: Fixture): Fixture {
  const f = Fixture.from(from, "admin-old-hub", "A workspace from before people: its admin key reaches the Workspace group, and People and Invites ask for an update");
  f.answer("hub_info", undefined, { version: "0.8.0", protocol: 1, busy: [], admin: true });
  for (const tool of ["people_list", "invite_create", "invite_revoke", "person_set", "person_remove", "audit_list"]) {
    f.fail(tool, undefined, { code: "not_found", message: `No tool ${tool}.`, fix: "Use a tool name from the workspace's MCP tool list." });
  }
  // Its MCP servers are older than people: Every project shows them, none here.
  f.answer("mcp_servers_get", undefined, { global: [], project: [] });
  return f;
}

// Each is built on chat-empty (three projects, two machines, their slots and roles; a few hundred KB), not on typical:
// every fixture stays in memory until the build writes them all, and typical's chats are megabytes a copy.
/**
 * Two hubs Sam administers, Personal and Acme, and a third, Club, where Sam is a member:
 * the Hub group names the hub it manages and switches between the first two only.
 */
function hubs(base: (name: "chat-empty") => Fixture): Fixture {
  const f = hub(base("chat-empty"), "admin-hubs", "Sam owns Personal, is an admin on Acme and a member on Club; the Workspace group manages one at a time", sam, true);
  f.label = "Personal";
  f.color = "green";
  const acme = hub(base("chat-empty"), "admin-hubs-acme", "Acme, where Sam is an admin", { ...sam, role: "admin" }, true);
  acme.state = { phase: "live", hub: "https://hub.acme.example", protocol: f.state.phase === "live" ? f.state.protocol : 1 };
  const club = hub(base("chat-empty"), "admin-hubs-club", "Club, where Sam is a member", { ...sam, role: "member" }, true);
  club.state = { phase: "live", hub: "http://club-hub:4790", protocol: f.state.phase === "live" ? f.state.protocol : 1 };
  f.hubs = [
    { label: "Acme", color: "amber", fixture: acme },
    { label: "Club", fixture: club },
  ];
  return f;
}

export default defineGroup({
  fixtures: (base) => [
    hubs(base),
    oldHub(base("chat-empty")),
    hub(base("chat-empty"), "admin-owner", "Sam owns the workspace: Alice is an admin, Bob a member, and Dana's invite waits", sam, true),
    hub(base("chat-empty"), "admin-admin", "The same workspace as Alice, an admin: Sam the owner is out of her reach", alice, true),
    // Bob's device holds admin on every machine, as every paired device did before people: his role alone hides it.
    hub(base("chat-empty"), "admin-member", "The same workspace as Bob, a member: no Workspace group anywhere", bob, true),
    // Members may not use the hub's key there, and Bob has connected no subscription: nothing to run his orders on.
    // Providers with Google connected: devbox signed in on a Google AI Pro plan, the team's Gemini key on devbox and
    // buildbox through a gateway, and storefront holding a key of its own.
    answerGoogle(hub(base("chat-empty"), "admin-google", "Sam's workspace with Google connected: devbox signed in, the workspace's Gemini key, and storefront's own", sam, true), {
      machines: [{ machineId: "devbox", checked: true, signedIn: "Google AI Pro" }],
      keyIn: [{ machineId: "devbox", projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22" }],
      teamKey: {
        endpoint: "https://gemini-gw.devbox.example",
        sealedOn: [
          { machineId: "buildbox", fingerprint: "7c41aa02" },
          { machineId: "devbox", fingerprint: "7c41aa02" },
        ],
        updatedAt: "2026-10-19T09:30:00.000Z",
      },
    }),
    hub(base("chat-empty"), "admin-claude-member", "The same workspace as Bob, with the workspace's key kept for leads: Bob must connect his own Claude", bob, true, false),
  ],
});

/** Where Google is connected (antigravity_status), and a sign-in on devbox: its Google page, then the code taken. */
export function answerGoogle(f: Fixture, status: JsonObject): Fixture {
  f.answer("antigravity_status", undefined, status);
  f.answer("machine_antigravity_login", { code: "g#1" }, { machineId: "devbox", message: "Antigravity is signed in (Google AI Pro)", signedIn: "Google AI Pro" });
  f.answer("machine_antigravity_login", { machineId: "devbox" }, { machineId: "devbox", message: "sign in at the URL, then give the code it shows", loginUrl: "https://accounts.google.com/o/oauth2/auth?state=devbox" });
  return f;
}
