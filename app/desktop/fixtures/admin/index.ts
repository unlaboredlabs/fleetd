// Administration's fixtures: an owner's hub with three people and an invite waiting, seen by its owner (`admin-owner`),
// by an admin (`admin-admin`, who may not touch the owner) and by a member (`admin-member`, who sees no Administration
// at all). The people calls follow contracts PR #640 (people_list, invite_create, invite_revoke, person_set,
// person_remove); hub_info names who this app's person is.
import { defineGroup } from "../kit/group.ts";
import { Fixture, HUB } from "../kit/fixture.ts";
import type { JsonObject } from "../kit/json.ts";

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
  return f;
}

export default defineGroup({
  fixtures: (base) => [
    hub(base("typical"), "admin-owner", "Sam owns the hub: Alice is an admin, Bob a member, and Dana's invite waits", sam, true),
    hub(base("typical"), "admin-admin", "The same hub as Alice, an admin: Sam the owner is out of her reach", alice, true),
    hub(base("typical"), "admin-member", "The same hub as Bob, a member: no Administration anywhere", bob, false),
  ],
});
