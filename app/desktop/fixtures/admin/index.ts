// The Hub group's fixtures: an owner's hub with three people and an invite waiting, seen by its owner (`admin-owner`),
// by an admin (`admin-admin`, who may not touch the owner) and by a member (`admin-member`, who sees no Hub group
// at all). The people calls follow contracts PR #640 (people_list, invite_create, invite_revoke, person_set,
// person_remove); hub_info names who this app's person is. `admin-claude-member`: Bob on a hub that keeps its Claude API key
// for leads, with no subscription of his own.
import { defineGroup } from "../kit/group.ts";
import { Fixture, HUB } from "../kit/fixture.ts";
import { isObject, type JsonObject } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";
import { profilesList } from "../settings/profiles.ts";

const AT = "2026-10-12T09:00:00.000Z";
const person = (personId: string, name: string, role: string, createdAt = AT): JsonObject => ({ personId, name, role, createdAt });
const ref = (p: JsonObject): JsonObject => ({ personId: p["personId"] ?? "", name: p["name"] ?? "" });

const sam = person("p_aaaaaaaa", "Sam Rivera", "owner", "2026-09-01T08:00:00.000Z");
const alice = person("p_bbbbbbbb", "Alice Chen", "admin");
const bob = person("p_cccccccc", "Bob Okafor", "member", "2026-10-14T16:20:00.000Z");
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
          fix: "Members may not use the hub's API on this hub: connect your subscription in Settings › Claude (paste the token `claude setup-token` prints).",
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

/** The owner's hub as `me` sees it, with every write answered as the hub would. */
function hub(from: Fixture, name: string, note: string, me: JsonObject, admin: boolean, membersUseHubApi = true): Fixture {
  return answerHub(Fixture.from(from, name, note), me, admin, membersUseHubApi);
}

/** Sam's hub, its people and its links, answered on `f` as `me` sees them (the showcase's Hub group too). */
export function answerHub(f: Fixture, me: JsonObject = sam, admin = true, membersUseHubApi = true): Fixture {
  f.answer("hub_info", undefined, hubInfo(me, admin));
  f.answer("claude_accounts_get", undefined, claudeAccounts(me, admin, membersUseHubApi));
  f.answer("usage_status", undefined, usageStatus);
  f.answer("people_list", undefined, people(me));
  const eve = person("p_eeeeeeee", "Eve Park", "member", f.now);
  f.answer("invite_create", undefined, {
    invite: { inviteId: "inv_bbbbbbbb", person: ref(eve), state: "open", createdAt: f.now, expiresAt: "2026-10-26T10:30:00.000Z", createdBy: ref(me) },
    code: "K7QM-4XWD",
    link: `fleetd://pair?hub=${encodeURIComponent(HUB)}&code=K7QM-4XWD`,
    hubUrl: HUB,
  });
  f.answer("invite_revoke", undefined, {
    invite: { inviteId: "inv_aaaaaaaa", person: ref(dana), state: "revoked", createdAt: "2026-10-18T11:00:00.000Z", expiresAt: "2026-10-25T11:00:00.000Z", revokedAt: f.now },
  });
  for (const role of ["owner", "admin", "member"]) f.answer("person_set", { personId: "p_cccccccc", role }, { person: { ...bob, role } });
  f.answer("person_remove", undefined, { person: { ...bob, removedAt: f.now }, revoked: 1 });
  // Hub links minted here (hubLinks/AllLinks): Sam's to home, Alice's limited to one project, Bob's revoked.
  const link = (linkId: string, label: string, p: JsonObject, device: string, extra: JsonObject = {}): JsonObject => ({
    linkId,
    label,
    prefix: `flk_${linkId.slice(3, 9)}`,
    keyId: `fld_${linkId.slice(3, 9)}`,
    device,
    person: ref(p),
    createdAt: "2026-10-15T09:30:00.000Z",
    ...extra,
  });
  f.answer("hub_links_get", undefined, {
    boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=",
    links: [],
    issued: [
      link("hl_samhomea", "home", sam, "Sam's MacBook", { lastUsedAt: "2026-10-19T10:20:00.000Z" }),
      link("hl_aliceaaa", "alice personal", alice, "Alice's ThinkPad", { projects: [{ machineId: "devbox", projectId: "storefront" }] }),
      link("hl_bobaaaaa", "side project", bob, "Bob's iMac", { revokedAt: "2026-10-18T17:00:00.000Z" }),
    ],
  });
  f.answer("hub_link_revoke", undefined, { link: link("hl_samhomea", "home", sam, "Sam's MacBook", { revokedAt: f.now }) });
  // Every project › Profiles: the hub's task profiles.
  f.answer("profiles_list", {}, profilesList());
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
  // The hub's old shared memory (D212): no agent reads it; an admin reads it and retires it.
  const shared = "# How the team works\n- Concise. State first.\n- Use pnpm, not npm.\n- Never estimate time.\n";
  const sharedFile = (text: string): JsonObject => ({ scope: "user", text, chars: text.length, cap: 16000, notes: [] });
  f.answer("memory_shared_get", undefined, { file: sharedFile(shared) });
  f.answer("memory_shared_set", { text: "" }, { file: sharedFile("") });
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
    userServers: true,
  });
  return f;
}

/**
 * Hub accounts › Google (google/AdminGoogle.tsx): no client yet; one saved on devbox only, buildbox missing; one
 * Google refuses; and real-time mail by push, or polling with why.
 */
function google(from: Fixture, name: string, note: string, client: "none" | "set" | "refused" | "push" | "polling"): Fixture {
  const f = hub(from, name, note, sam, true);
  const box = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
  if (f.snapshot !== undefined) f.snapshot["machines"] = arr(f.snapshot["machines"]).map((m) => (isObject(m) ? { ...m, boxPubKey: box } : m));
  const saved = { clientId: "418559210337-q8fj2v0c6m1k3s5t7u9w.apps.googleusercontent.com", sealedOn: [{ machineId: "devbox", fingerprint: "9c41e0b2" }], updatedAt: "2026-10-17T09:00:00.000Z" };
  const scopes = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/drive",
  ];
  const pubsub = { topic: "projects/fleetd-devbox/topics/fleetd-gmail", subscription: "projects/fleetd-devbox/subscriptions/fleetd-gmail-hub", machineId: "devbox", fingerprint: "71d03a5e" };
  const realtime = client === "push" || client === "polling";
  f.answer("google_get", undefined, {
    ...(client === "none" ? {} : { client: { ...saved, ...(realtime ? { pubsub } : {}) } }),
    scopes,
    redirect: "http://127.0.0.1",
    mailMode: client === "push" ? "push" : "polling",
    ...(client === "polling" ? { mailProblem: "devbox is offline, and it holds the key" } : {}),
  });
  f.answer("google_pubsub_set", undefined, { client: saved, next: "The hub checks the mail of each Navi whose mail wakes it about every minute." });
  f.answer(
    "google_client_test",
    undefined,
    client === "refused"
      ? { machineId: "devbox", check: { ok: false, problem: "Google doesn't know this client: check the Client ID and secret, or make a new Desktop app client." } }
      : { machineId: "devbox", check: { ok: true } },
  );
  return f;
}

/**
 * Hub accounts › GitHub (github/AdminGithub.tsx): no App yet, with the button that creates one; one created but not
 * installed; one installed on acme's chosen repositories and all of Sam's, tested; and one whose key GitHub refused.
 * The App is acme's, so its pages are under acme's settings.
 */
function github(
  from: Fixture,
  name: string,
  note: string,
  app: "none" | "created" | "installed" | "refused",
  me: "none" | "connected" | "lapsed" = "none",
): Fixture {
  const f = hub(from, name, note, sam, true);
  const made = {
    appId: 1048576,
    slug: "fleetd-on-devbox",
    name: "fleetd on devbox",
    clientId: "Iv23liQ4fXk8w2ZsT0aB",
    owner: "acme",
    htmlUrl: "https://github.com/apps/fleetd-on-devbox",
    settingsUrl: "https://github.com/organizations/acme/settings/apps/fleetd-on-devbox",
    createdAt: "2026-10-18T09:00:00.000Z",
  };
  const installations = [
    { installationId: 51234567, account: "acme", allRepositories: false, repositoryCount: 2, repositories: ["acme/storefront", "acme/api"] },
    { installationId: 51234568, account: "sam-rivera", allRepositories: true, repositoryCount: 14, repositories: [] },
  ];
  const tested = {
    at: "2026-10-19T08:30:00.000Z",
    ok: true,
    said: '"fleetd on devbox" is installed on acme (2 repositories), sam-rivera (all 14 repositories), and its tokens work.',
  };
  const refused = { at: "2026-10-19T08:30:00.000Z", ok: false, said: "GitHub refused (401): A JSON web token could not be decoded." };
  const kept =
    app === "none"
      ? undefined
      : app === "created"
        ? made
        : app === "installed"
          ? { ...made, installations, lastTest: tested }
          : { ...made, installations, lastTest: refused };
  const permissions = [
    ["contents", "write"],
    ["pull_requests", "write"],
    ["issues", "write"],
    ["workflows", "write"],
    ["statuses", "write"],
    ["actions", "write"],
    ["checks", "read"],
    ["metadata", "read"],
  ];
  const account = { login: "sam-rivera", userId: 583231, connectedAt: "2026-10-18T09:20:00.000Z", ...(me === "lapsed" ? { lapsed: true } : {}) };
  f.answer("github_app_get", undefined, {
    ...(kept === undefined ? {} : { app: kept }),
    permissions,
    ...(me === "none" ? {} : { me: account }),
    authorizeUrl: "https://github.com/login/oauth/authorize",
  });
  f.answer("github_disconnect", undefined, { revoked: true });
  if (kept !== undefined) {
    f.answer("github_app_test", undefined, { app: kept });
    f.answer("github_app_remove", undefined, { settingsUrl: made.settingsUrl });
  }
  return f;
}

/** A hub from before people: an admin key, and no people tools, which it says as it says of any unknown tool. */
function oldHub(from: Fixture): Fixture {
  const f = Fixture.from(from, "admin-old-hub", "A hub from before people: its admin key reaches the Hub group, and People and Invites ask for an update");
  f.answer("hub_info", undefined, { version: "0.8.0", protocol: 1, busy: [], admin: true });
  for (const tool of ["people_list", "invite_create", "invite_revoke", "person_set", "person_remove", "hub_links_get"]) {
    f.fail(tool, undefined, { code: "not_found", message: `No tool ${tool}.`, fix: "Use a tool name from the hub's MCP tool list." });
  }
  // Its MCP servers are older than people: Every project shows them, none here.
  f.answer("mcp_servers_get", undefined, { global: [], project: [], userServers: true });
  return f;
}

// Each is built on chat-empty (three projects, two machines, their slots and roles; a few hundred KB), not on typical:
// every fixture stays in memory until the build writes them all, and typical's chats are megabytes a copy.
/**
 * Two hubs Sam administers, Personal and Acme, and a third, Club, where Sam is a member (docs/design/hubs.md):
 * the Hub group names the hub it manages and switches between the first two only.
 */
function hubs(base: (name: "chat-empty") => Fixture): Fixture {
  const f = hub(base("chat-empty"), "admin-hubs", "Sam owns Personal, is an admin on Acme and a member on Club; the Hub group manages one at a time", sam, true);
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
    hub(base("chat-empty"), "admin-owner", "Sam owns the hub: Alice is an admin, Bob a member, and Dana's invite waits", sam, true),
    hub(base("chat-empty"), "admin-admin", "The same hub as Alice, an admin: Sam the owner is out of her reach", alice, true),
    // Bob's device holds admin on every machine, as every paired device did before people: his role alone hides it.
    google(base("chat-empty"), "admin-google-none", "Hub accounts › Google on a hub with no OAuth client yet: the steps and the form", "none"),
    google(base("chat-empty"), "admin-google-set", "Hub accounts › Google with the client saved on devbox, not on buildbox; Test finds it", "set"),
    google(base("chat-empty"), "admin-google-push", "Hub accounts › Google with real-time mail read on devbox, by push", "push"),
    google(base("chat-empty"), "admin-google-polling", "Hub accounts › Google with real-time mail set up, polling because devbox is offline", "polling"),
    google(base("chat-empty"), "admin-google-refused", "Hub accounts › Google with a client Google doesn't know: Test says so", "refused"),
    github(base("chat-empty"), "admin-github-none", "Hub accounts › GitHub on a hub with no App yet: Create GitHub App", "none"),
    github(base("chat-empty"), "admin-github-created", "Hub accounts › GitHub with the App created and not installed yet", "created"),
    github(base("chat-empty"), "admin-github-installed", "Hub accounts › GitHub with the App installed on acme and Sam's account, tested", "installed"),
    github(base("chat-empty"), "admin-github-refused", "Hub accounts › GitHub with an App whose key GitHub refused", "refused"),
    github(base("chat-empty"), "admin-github-me-none", "Settings › GitHub: the hub has its App, and Sam hasn't connected yet", "installed"),
    github(base("chat-empty"), "admin-github-me-connected", "Settings › GitHub: Sam connected as sam-rivera", "installed", "connected"),
    github(base("chat-empty"), "admin-github-me-lapsed", "Settings › GitHub: GitHub no longer takes Sam's connection", "installed", "lapsed"),
    hub(base("chat-empty"), "admin-member", "The same hub as Bob, a member: no Hub group anywhere", bob, true),
    // Members may not use the hub's key there, and Bob has connected no subscription: nothing to run his orders on.
    hub(base("chat-empty"), "admin-claude-member", "The same hub as Bob, with the hub's key kept for leads: Bob must connect his own Claude", bob, true, false),
  ],
});
