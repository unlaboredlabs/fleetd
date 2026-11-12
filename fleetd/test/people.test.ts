import { expect, test } from "bun:test";
import { allowsEverywhere } from "../src/hub/people/tools.ts";
import { pair } from "../src/hub/pair/http.ts";
import { People, people } from "../src/hub/people/store.ts";
import { onPersonRemoved } from "../src/hub/people/events.ts";
import type { Hub } from "../src/hub/api/hub.ts";
import type { Caller } from "../src/hub/api/registry.ts";
import type { RouteContext } from "../src/hub/http/route.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { eventsOf, refusal, testHub } from "./people-kit.ts";

const URL_ = "http://devbox.example.ts.net:4790";

/** Redeems `code` at POST /pair as the app does; the key it gets, verified. */
async function redeem(hub: Hub, code: string, deviceName = "laptop"): Promise<{ caller: Caller; key: string } | number> {
  const req = new Request(`${URL_}/pair`, { method: "POST", body: JSON.stringify({ code, deviceName }) });
  const res = (await pair(req, { hub, ip: "100.64.0.1", params: {} } as unknown as RouteContext)) as Response;
  if (res.status !== 200) return res.status;
  const { key } = (await res.json()) as { key: string };
  return { caller: hub.auth.verify(key), key };
}

const ownerDevice = (hub: Hub, device: (g?: never, p?: string, n?: string) => Caller) =>
  device(undefined, people(hub).list(false)[0]?.personId, "desk");

test("an invite redeemed binds the device to its person, capped by their role, and the list shows both", async () => {
  const { hub, call, device } = testHub({ url: URL_ });
  const owner = ownerDevice(hub, device as never);
  const out = await call<{ code: string; link: string; invite: { state: string; person: { name: string }; createdAt: string; expiresAt: string } }>(
    owner,
    "invite_create",
    { name: "Alice" },
  );
  expect(out.invite.state).toBe("open");
  expect(out.invite.person.name).toBe("Alice");
  expect(out.link).toBe(`fleetd://pair?hub=http%3A%2F%2Fdevbox.example.ts.net%3A4790&code=${out.code}`);
  expect(Date.parse(out.invite.expiresAt) - Date.parse(out.invite.createdAt)).toBe(7 * 24 * 60 * 60_000);

  const paired = await redeem(hub, out.code);
  if (typeof paired === "number") throw new Error(`pair: ${paired}`);
  const laptop = paired.caller;
  expect(laptop.person?.name).toBe("Alice");
  expect(laptop.kind).toBe("human");
  // A member operates on every machine, and administers nothing.
  expect(allowsEverywhere(laptop, "operate")).toBe(true);
  expect(allowsEverywhere(laptop, "admin")).toBe(false);
  expect(await redeem(hub, out.code)).toBe(401);
  expect(eventsOf(hub, "people.changed").map((e) => e.summary)).toEqual([
    `${owner.person?.name} invited Alice as member`,
    "Alice joined the hub on laptop",
  ]);

  const listed = await call<{ people: unknown[]; devices: { keyId: string }[]; invites: unknown[]; me: string; left: unknown[] }>(owner, "people_list");
  expect(listed.people.length).toBe(2);
  // The test clock pairs both in the same millisecond, so they list in key id order.
  expect(listed.devices.map((d) => d.keyId)).toEqual([owner.keyId, laptop.keyId].sort());
  expect(listed.invites).toEqual([]);
  expect(listed.me).toBe(owner.person?.personId as string);
  // A removed person's projects stay as they are (D491): no list of what they left.
  expect(listed.left).toBeUndefined();

  // Alice sees everyone, but only her own devices and no invites.
  const hers = await call<{ people: unknown[]; devices: unknown[]; invites: unknown[]; thisDevice: string; left?: unknown }>(laptop, "people_list");
  expect(hers.people.length).toBe(2);
  expect(hers.devices.length).toBe(1);
  expect(hers.thisDevice).toBe(laptop.keyId);
  expect(hers.left).toBeUndefined();
  // She can't sign out the owner's desk (not found to her), but signs out her own laptop.
  expect((await refusal(call(laptop, "device_revoke", { keyId: owner.keyId }))).code).toBe("not_found");
  const out2 = await call<{ device: { revokedAt?: string } }>(laptop, "device_revoke", { keyId: laptop.keyId });
  expect(out2.device.revokedAt).toBeDefined();
  expect(() => hub.auth.verify(paired.key)).toThrow();
});

test("members can't administer, and a promotion reaches the device their invite paired", async () => {
  const { hub, call, device } = testHub({ url: URL_ });
  const owner = ownerDevice(hub, device as never);
  const { code } = await call<{ code: string }>(owner, "invite_create", { name: "Bob" });
  const paired = await redeem(hub, code);
  if (typeof paired === "number") throw new Error("pair");
  const bob = paired.caller;
  const refused = await refusal(call(bob, "invite_create", { name: "Eve" }));
  expect(refused.message).toBe("This key lacks the admin role.");
  await call(owner, "person_set", { personId: bob.person?.personId, role: "admin" });
  const promoted = hub.auth.verify(paired.key);
  expect(allowsEverywhere(promoted, "admin")).toBe(true);
  await call(promoted, "invite_create", { name: "Eve" });
  expect((await refusal(call(promoted, "invite_create", { name: "Mallory", role: "owner" }))).message).toBe(
    "Only an owner makes someone an owner.",
  );
  expect(eventsOf(hub, "people.changed").some((e) => e.summary === `${owner.person?.name} made Bob admin`)).toBe(true);
});

test("the hub keeps its owners; removing a person signs out their devices; a revoked invite takes its person", async () => {
  const { hub, call, device } = testHub({ url: URL_ });
  const owner = ownerDevice(hub, device as never);
  const ownerId = owner.person?.personId as string;
  for (const input of [{ personId: ownerId, role: "admin" }]) {
    expect((await refusal(call(owner, "person_set", input))).message).toEndWith("is the hub's only owner.");
  }
  expect((await refusal(call(owner, "person_remove", { personId: ownerId }))).message).toEndWith("is the hub's only owner.");
  expect((await refusal(call(owner, "invite_create", { name: "  \u0007 " }))).message).toBe("A new person needs a name.");

  const admin = people(hub).create("Ada", "admin");
  const adminDevice = device(undefined, admin.personId, "ada");
  expect((await refusal(call(adminDevice, "person_remove", { personId: ownerId }))).message).toBe("Only an owner removes an owner.");
  expect((await refusal(call(adminDevice, "device_revoke", { keyId: owner.keyId }))).message).toBe(
    "Only an owner signs out an owner's device.",
  );

  const carol = people(hub).create("Carol", "member");
  const carolDevice = device(undefined, carol.personId, "carol");
  // A hub link minted from Carol's device goes when her device does.
  hub.db.conn.run(
    `INSERT INTO hub_links_issued (link_id, hash, prefix, label, key_id, device, created_ms) VALUES ('hl_1', 'h', 'flk', 'x', '${carolDevice.keyId}', 'carol', 1)`,
  );
  const forgotten: string[] = [];
  onPersonRemoved(hub, (id) => {
    forgotten.push(id);
  });
  const removed = await call<{ revoked: number; person: { removedAt?: string } }>(owner, "person_remove", { personId: carol.personId });
  expect(removed.revoked).toBe(1);
  expect(removed.person.removedAt).toBeDefined();
  expect(forgotten).toEqual([carol.personId]);
  expect(hub.auth.keys.get(carolDevice.keyId)?.revokedAt).toBeDefined();

  const dave = await call<{ invite: { inviteId: string }; code: string }>(owner, "invite_create", { name: "Dave" });
  const taken = await call<{ invite: { state: string } }>(owner, "invite_revoke", { inviteId: dave.invite.inviteId });
  expect(taken.invite.state).toBe("revoked");
  const said = eventsOf(hub, "people.changed").filter((e) => e.data?.change === "invite_revoked").length;
  await call(owner, "invite_revoke", { inviteId: dave.invite.inviteId });
  expect(eventsOf(hub, "people.changed").filter((e) => e.data?.change === "invite_revoked").length).toBe(said);
  expect(await redeem(hub, dave.code)).toBe(401);
  expect(people(hub).list(false).map((p) => p.name)).toEqual([owner.person?.name, "Ada"].map(String));
});

test("revoking a device revokes the hub links minted from it", async () => {
  const { hub, call, device } = testHub();
  const owner = ownerDevice(hub, device as never);
  const phone = device(undefined, owner.person?.personId, "phone");
  hub.db.conn.run(
    `INSERT INTO hub_links_issued (link_id, hash, prefix, label, key_id, device, created_ms) VALUES ('hl_2', 'h2', 'flk', 'x', '${phone.keyId}', 'phone', 1)`,
  );
  await call(owner, "device_revoke", { keyId: phone.keyId });
  expect(hub.db.all<{ revoked_ms: number | null }>("SELECT revoked_ms FROM hub_links_issued")[0]?.revoked_ms).not.toBeNull();
});

test("an older hub's human keys all bind to one owner made from the machine's user", () => {
  const db = HubDb.memory();
  db.conn.run("INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind) VALUES ('k1', 'h1', 'fld_a', 'a', '[]', 1, 'human')");
  db.conn.run("INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind) VALUES ('k2', 'h2', 'fld_b', 'b', '[]', 1, 'agent')");
  const store = new People(db, () => 5);
  const owner = store.ensureOwner();
  expect(owner.role).toBe("owner");
  expect(store.ensureOwner().personId).toBe(owner.personId);
  expect(db.all("SELECT key_id, person_id FROM agent_keys ORDER BY key_id")).toEqual([
    { key_id: "k1", person_id: owner.personId },
    { key_id: "k2", person_id: null },
  ]);
});
