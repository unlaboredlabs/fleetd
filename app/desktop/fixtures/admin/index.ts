// Administration's fixtures: an owner's hub with three people and an invite waiting, seen by its owner (`admin-owner`),
// by an admin (`admin-admin`, who may not touch the owner) and by a member (`admin-member`, who sees no Administration
// at all). The people calls follow contracts PR #640 (people_list, invite_create, invite_revoke, person_set,
// person_remove); hub_info names who this app's person is.
import { defineGroup } from "../kit/group.ts";
import { Fixture, HUB } from "../kit/fixture.ts";
import { isObject, type JsonObject } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";

const AT = "2026-10-12T09:00:00.000Z";
const person = (personId: string, name: string, role: string, createdAt = AT): JsonObject => ({ personId, name, role, createdAt });
const ref = (p: JsonObject): JsonObject => ({ personId: p["personId"] ?? "", name: p["name"] ?? "" });

const sam = person("p_aaaaaaaa", "Sam Rivera", "owner", "2026-09-01T08:00:00.000Z");
const alice = person("p_bbbbbbbb", "Alice Chen", "admin");
const bob = person("p_cccccccc", "Bob Okafor", "member", "2026-10-14T16:20:00.000Z");
const dana = person("p_dddddddd", "Dana Ito", "member", "2026-10-18T11:00:00.000Z");

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

/** The owner's hub as `me` sees it, with every write answered as the hub would. */
function hub(from: Fixture, name: string, note: string, me: JsonObject, admin: boolean): Fixture {
  const f = Fixture.from(from, name, note);
  f.answer("hub_info", undefined, hubInfo(me, admin));
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
  return f;
}

/**
 * Administration › Google (google/AdminGoogle.tsx): no client yet; one saved on devbox only, buildbox missing; one
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

/** A hub from before people: an admin key, and no people tools, which it says as it says of any unknown tool. */
function oldHub(from: Fixture): Fixture {
  const f = Fixture.from(from, "admin-old-hub", "A hub from before people: its admin key reaches Hub settings, and People and Invites ask for an update");
  f.answer("hub_info", undefined, { version: "0.8.0", protocol: 1, busy: [], admin: true });
  for (const tool of ["people_list", "invite_create", "invite_revoke", "person_set", "person_remove", "hub_links_get"]) {
    f.fail(tool, undefined, { code: "not_found", message: `No tool ${tool}.`, fix: "Use a tool name from the hub's MCP tool list." });
  }
  return f;
}

// Each is built on chat-empty (three projects, two machines, their slots and roles; a few hundred KB), not on typical:
// every fixture stays in memory until the build writes them all, and typical's chats are megabytes a copy.
/**
 * Two hubs Sam administers, Personal and Acme, and a third, Club, where Sam is a member (docs/design/hubs.md):
 * Administration names the hub it manages and switches between the first two only.
 */
function hubs(base: (name: "chat-empty") => Fixture): Fixture {
  const f = hub(base("chat-empty"), "admin-hubs", "Sam owns Personal, is an admin on Acme and a member on Club; Administration manages one at a time", sam, true);
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
    google(base("chat-empty"), "admin-google-none", "Administration › Google on a hub with no OAuth client yet: the steps and the form", "none"),
    google(base("chat-empty"), "admin-google-set", "Administration › Google with the client saved on devbox, not on buildbox; Test finds it", "set"),
    google(base("chat-empty"), "admin-google-push", "Administration › Google with real-time mail read on devbox, by push", "push"),
    google(base("chat-empty"), "admin-google-polling", "Administration › Google with real-time mail set up, polling because devbox is offline", "polling"),
    google(base("chat-empty"), "admin-google-refused", "Administration › Google with a client Google doesn't know: Test says so", "refused"),
    hub(base("chat-empty"), "admin-member", "The same hub as Bob, a member: no Administration anywhere", bob, true),
  ],
});
