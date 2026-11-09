// A person's own picture over a real hub: it is kept as a project's is
// (a JPEG at most 512 px square), named on the person in hub_info and people_list, readable by anyone on the hub,
// removed again, and forgotten when the person is removed; each change is a people.changed event; only a person's own
// device sets theirs.
import { afterEach, expect, test } from "bun:test";
import { AVATAR_PX } from "../src/hub/projects/avatar.ts";
import { pngRows } from "../src/hub/projects/avatar-render.ts";
import { people } from "../src/hub/people/store.ts";
import type { Caller } from "../src/hub/api/registry.ts";
import type { Hub } from "../src/hub/api/hub.ts";
import { tempHome } from "./helpers.ts";
import { png } from "./intake-kit.ts";
import { eventsOf, refusal, testHub } from "./people-kit.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0)) done();
});

function rig() {
  const home = tempHome();
  cleanups.push(home.done);
  const t = testHub({ home: home.dir });
  const owner = t.device(undefined, people(t.hub).list(false)[0]?.personId, "phone");
  return { ...t, owner };
}

type Call = ReturnType<typeof testHub>["call"];

/** A 1200 × 800 photo, left half red and right half blue, uploaded as `who`: its attachment id. */
async function uploadPhoto(call: Call, who: Caller): Promise<string> {
  const photo = await new Bun.Image(png(1200, 800, (x) => (x < 600 ? [230, 20, 20] : [20, 20, 230]))).jpeg().bytes();
  const put = await call<{ attachmentId: string }>(who, "attachment_put", {
    name: "photo",
    mime: "image/jpeg",
    dataB64: Buffer.from(photo).toString("base64"),
  });
  return put.attachmentId;
}

const pictureChanges = (hub: Hub) => eventsOf(hub, "people.changed").filter((e) => e.data?.change === "picture_changed");

type PersonOut = { personId: string; avatar?: string };

test("a person sets their own picture, everyone sees it, and removing it brings the initials back", async () => {
  const { hub, call, agent, owner } = rig();
  const me = owner.person?.personId as string;
  let info = await call<{ me: PersonOut }>(owner, "hub_info");
  expect(info.me.avatar).toBeUndefined();

  const id = await uploadPhoto(call, owner);
  const set = await call<{ person: PersonOut }>(owner, "person_avatar_set", {
    attachmentId: id,
    crop: { x: 600, y: 0, size: 600 },
  });
  const avatar = set.person.avatar as string;
  expect(avatar.length).toBe(16);
  expect(set.person.personId).toBe(me);

  // hub_info's me and people_list name it, for every app.
  info = await call<{ me: PersonOut }>(owner, "hub_info");
  expect(info.me.avatar).toBe(avatar);
  const list = await call<{ people: PersonOut[] }>(owner, "people_list");
  expect(list.people[0]?.avatar).toBe(avatar);

  // Anyone on the hub reads its bytes: the crop, a JPEG at most 512 px square.
  const got = await call<{ avatar: string; mime: string; dataB64: string }>(agent([{ role: "operate", machines: "*" }]), "person_avatar_get", {
    personId: me,
  });
  expect(got.avatar).toBe(avatar);
  expect(got.mime).toBe("image/jpeg");
  const bytes = Buffer.from(got.dataB64, "base64");
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  const meta = await new Bun.Image(bytes).metadata();
  expect([meta.width, meta.height]).toEqual([AVATAR_PX, AVATAR_PX]);
  let middle: number[] = [];
  pngRows(await new Bun.Image(bytes).png().bytes(), (y, row) => {
    if (y === 256) middle = [...row.subarray(256 * 3, 256 * 3 + 3)];
    return y < 256;
  });
  const [r, , b] = middle as [number, number, number];
  expect(b > 180 && r < 80).toBe(true);

  // Every open app hears it.
  const changes = pictureChanges(hub);
  expect(changes.length).toBe(1);
  expect((changes[0]?.data?.person as PersonOut).personId).toBe(me);

  // No attachment removes it: the initials again, and a read finds none.
  const removed = await call<{ person: PersonOut }>(owner, "person_avatar_set", {});
  expect(removed.person.avatar).toBeUndefined();
  info = await call<{ me: PersonOut }>(owner, "hub_info");
  expect(info.me.avatar).toBeUndefined();
  expect((await refusal(call(owner, "person_avatar_get", { personId: me }))).code).toBe("not_found");
  expect(pictureChanges(hub).length).toBe(2);
});

test("only a person's own device sets theirs, and a removed person loses it", async () => {
  const { hub, call, agent, device, owner } = rig();

  // An agent's key is no one's: refused, and nothing changes.
  expect((await refusal(call(agent([{ role: "operate", machines: "*" }]), "person_avatar_set", {}))).code).toBe("forbidden");
  expect(pictureChanges(hub)).toEqual([]);

  // A member sets their own, which leaves the owner's initials alone.
  const invite = await call<{ invite: { person: { personId: string } } }>(owner, "invite_create", { name: "Alice" });
  const aliceId = invite.invite.person.personId;
  const alice = device([{ role: "operate", machines: "*" }], aliceId, "Alice's phone");
  await call(alice, "person_avatar_set", { attachmentId: await uploadPhoto(call, alice) });
  const list = await call<{ people: PersonOut[] }>(owner, "people_list");
  expect(list.people[0]?.avatar).toBeUndefined();
  expect(typeof list.people[1]?.avatar).toBe("string");

  // Removed, they keep their name but not their picture.
  await call(owner, "person_remove", { personId: aliceId });
  expect((await refusal(call(owner, "person_avatar_get", { personId: aliceId }))).code).toBe("not_found");
  const all = await call<{ people: PersonOut[] }>(owner, "people_list", { includeRemoved: true });
  const gone = all.people.find((p) => p.personId === aliceId);
  expect(gone).toBeDefined();
  expect(gone?.avatar).toBeUndefined();
});
