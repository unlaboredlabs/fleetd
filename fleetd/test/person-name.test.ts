// A person's own name over a real hub (person_name_set): a member renames themself from their own device, the hub
// keeps it cleaned as an invite's name is, every open app hears `renamed`, and nobody else's key changes it.
import { expect, test } from "bun:test";
import { people } from "../src/hub/people/store.ts";
import type { Hub } from "../src/hub/api/hub.ts";
import { eventsOf, refusal, testHub } from "./people-kit.ts";

function rig() {
  const t = testHub();
  const owner = t.device(undefined, people(t.hub).list(false)[0]?.personId, "desk");
  return { ...t, owner };
}

type PersonOut = { personId: string; name: string; role: string };

const renames = (hub: Hub) => eventsOf(hub, "people.changed").filter((e) => e.data?.change === "renamed");

/** Alice, a member invited by the owner, on a phone of her own. */
async function member(t: ReturnType<typeof rig>) {
  const invite = await t.call<{ invite: { person: { personId: string } } }>(t.owner, "invite_create", { name: "Alice" });
  const id = invite.invite.person.personId;
  return { id, phone: t.device([{ role: "operate", machines: "*" }], id, "Alice's phone") };
}

test("a member renames themself, and every app hears it", async () => {
  const t = rig();
  const { hub, call, owner } = t;
  const alice = await member(t);

  // Cleaned as an invite's name is: trimmed, control characters dropped.
  const set = await call<{ person: PersonOut }>(alice.phone, "person_name_set", { name: "  Alice \u0007Liddell " });
  expect(set.person).toMatchObject({ personId: alice.id, name: "Alice Liddell", role: "member" });

  // hub_info's me and people_list say it, for every app; the owner keeps their own.
  const info = await call<{ me: PersonOut }>(alice.phone, "hub_info");
  expect(info.me.name).toBe("Alice Liddell");
  const list = await call<{ people: PersonOut[] }>(owner, "people_list");
  expect(list.people.map((p) => p.name)).toEqual([owner.person?.name as string, "Alice Liddell"]);

  // One `renamed`, about her and by her.
  const heard = renames(hub);
  expect(heard.map((e) => e.summary)).toEqual(["Alice changed their name to Alice Liddell"]);
  expect(heard[0]?.data).toMatchObject({
    person: { personId: alice.id, name: "Alice Liddell" },
    by: { personId: alice.id, name: "Alice Liddell" },
  });

  // Her next call is made under the new name; the same name again says nothing.
  expect(hub.auth.verify(hub.auth.keys.createKeyFor("laptop", [], "human", alice.id).key).person?.name).toBe("Alice Liddell");
  await call(alice.phone, "person_name_set", { name: "Alice Liddell" });
  expect(renames(hub).length).toBe(1);
});

test("an empty or over-long name is refused, and the name stays", async () => {
  const t = rig();
  const { hub, call, tools } = t;
  const alice = await member(t);

  for (const name of ["", "   ", " \u0007\t "]) {
    const refused = await refusal(call(alice.phone, "person_name_set", { name }));
    expect(refused.code).toBe("invalid");
    expect(refused.message).toBe("The name is empty.");
  }
  // The contract's limit, an invite's too: 80 characters, on one line.
  expect(await tools.call(hub, alice.phone, "person_name_set", { name: "a".repeat(81) })).toMatchObject({ error: { kind: "invalid" } });
  expect(await tools.call(hub, alice.phone, "person_name_set", { name: "Alice\nLiddell" })).toMatchObject({ error: { kind: "invalid" } });
  expect(await tools.call(hub, alice.phone, "person_name_set", {})).toMatchObject({ error: { kind: "invalid" } });
  const kept = await call<{ person: PersonOut }>(alice.phone, "person_name_set", { name: "a".repeat(80) });
  expect(kept.person.name).toBe("a".repeat(80));

  expect(renames(hub).length).toBe(1);
});

test("only a person's own device changes their name", async () => {
  const t = rig();
  const { hub, call, agent, device, owner } = t;
  const alice = await member(t);

  // An agent's key is no one's, whatever it may do elsewhere.
  for (const key of [agent(), agent([{ role: "operate", machines: "*" }])]) {
    const refused = await refusal(call(key, "person_name_set", { name: "Mallory" }));
    expect(refused.code).toBe("forbidden");
    expect(refused.message).toBe("Only a person changes their own name, from one of their own devices.");
  }

  // The tool names no one: another person's call renames the caller, never Alice.
  const invite = await call<{ invite: { person: { personId: string } } }>(owner, "invite_create", { name: "Bob" });
  const bob = device([{ role: "operate", machines: "*" }], invite.invite.person.personId, "Bob's laptop");
  await call(bob, "person_name_set", { name: "Robert", personId: alice.id });
  expect(people(hub).get(alice.id)?.name).toBe("Alice");
  expect(people(hub).get(invite.invite.person.personId)?.name).toBe("Robert");
  // A member still can't rename someone else the admin's way.
  expect((await refusal(call(bob, "person_set", { personId: alice.id, name: "Mallory" }))).code).toBe("forbidden");
  expect(people(hub).get(alice.id)?.name).toBe("Alice");

  // Removed from the hub, their device changes nothing.
  await call(owner, "person_remove", { personId: alice.id });
  expect((await refusal(call(alice.phone, "person_name_set", { name: "Alice Again" }))).code).toBe("forbidden");
  expect(people(hub).get(alice.id)?.name).toBe("Alice");
  expect(renames(hub).map((e) => e.summary)).toEqual(["Bob changed their name to Robert"]);

  // An owner changes their own this way too; renaming someone else stays person_set's.
  const mine = await call<{ person: PersonOut }>(owner, "person_name_set", { name: "Olive" });
  expect(mine.person).toMatchObject({ personId: owner.person?.personId as string, name: "Olive", role: "owner" });
});
