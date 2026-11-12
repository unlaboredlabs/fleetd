// The vault's tools from a person's device: who lists, changes and reveals what (the team vault, a project's
// variables, items set aside and their move), an older app's refusal, the trash, the limits, and that the database holds
// no value in the clear.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { openSealed, publicKeyOf } from "../src/shared/sealed_box.ts";
import { OTHER, PROJECT, type VaultHub, vaultHub } from "./vault-kit.ts";
import { refusal } from "./people-kit.ts";
import { people } from "../src/hub/people/store.ts";

let k: VaultHub;
beforeEach(async () => {
  k = vaultHub();
  await k.v.load();
});
afterEach(() => k.done());

type Item = { itemId: string; kind: string; scope: string; label: string; meta: Record<string, unknown>; canEdit: boolean; canReveal: boolean; value?: string };
const save = (caller = k.ownerDevice, input: Record<string, unknown>) => k.call<{ item: Item }>(caller, "vault_save", input).then((o) => o.item);
const list = (caller = k.ownerDevice, input: Record<string, unknown> = {}) => k.call<{ items: Item[] }>(caller, "vault_list", input).then((o) => o.items);

async function reveal(caller: typeof k.ownerDevice, itemId: string, fields: string[]) {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const out = await k.call<{ sealed: string }>(caller, "vault_reveal", { itemId, fields, replyKey: Buffer.from(publicKeyOf(secret)).toString("base64") });
  return JSON.parse(Buffer.from(openSealed(secret, new Uint8Array(Buffer.from(out.sealed, "base64")))!).toString("utf8")) as Record<string, string>;
}

const LOGIN = { username: "ada@example.test", password: "planted-pw-1x9z" };
const CARD = { number: "4242 4242 4242 4242", month: "4", year: "31", cvc: "123", name: "Ada" };

test("a team login: metadata worked out by the hub, the value only through a sealed reveal", async () => {
  const item = await save(k.ownerDevice, { kind: "login", label: "Shop", sites: ["www.shop.example"], sealed: k.sealToHub(LOGIN) });
  expect(item.scope).toBe("hub");
  expect(item.meta).toEqual({ sites: ["www.shop.example"], fields: ["username", "password"], source: { kind: "typed" } });
  expect(item.canEdit && item.canReveal).toBe(true);
  expect(JSON.stringify(item)).not.toContain(LOGIN.password);
  expect(await reveal(k.ownerDevice, item.itemId, ["password"])).toEqual({ password: LOGIN.password });
  // Everyone on the hub lists it; an agent key never reaches the vault's tools.
  expect((await list(k.memberDevice)).map((i) => i.itemId)).toContain(item.itemId);
  expect((await refusal(k.call(k.agent(), "vault_list", {}))).code).toBe("forbidden");
  // Every write and reveal is audited, never with a value.
  const audit = await k.call<{ entries: { action: string; data: unknown }[] }>(k.ownerDevice, "vault_audit", { itemId: item.itemId });
  expect(audit.entries.map((e) => e.action)).toEqual(["reveal", "create"]);
  expect(JSON.stringify(audit)).not.toContain(LOGIN.password);
});

test("team items: anyone adds one; its creator or an admin shows, changes or deletes it; others only list and fill it", async () => {
  const bos = await save(k.memberDevice, { kind: "login", label: "Bo's shop", sites: ["shop.example"], sealed: k.sealToHub(LOGIN) });
  expect([bos.canEdit, bos.canReveal]).toEqual([true, true]);
  const asAdmin = (await list(k.ownerDevice)).find((i) => i.itemId === bos.itemId)!;
  expect([asAdmin.canEdit, asAdmin.canReveal]).toEqual([true, true]);
  const ada = await save(k.ownerDevice, { kind: "card", label: "Team", sealed: k.sealToHub(CARD) });
  const asMember = (await list(k.memberDevice)).find((i) => i.itemId === ada.itemId)!;
  expect([asMember.canEdit, asMember.canReveal]).toEqual([false, false]);
  expect((await refusal(reveal(k.memberDevice, ada.itemId, ["number"]))).code).toBe("forbidden");
  expect((await refusal(k.call(k.memberDevice, "vault_delete", { itemId: ada.itemId }))).code).toBe("forbidden");
  // A login's sites changed by someone who can't show it would fill its password wherever they pick.
  const adas = await save(k.ownerDevice, { kind: "login", label: "Bank", sites: ["bank.example"], sealed: k.sealToHub(LOGIN) });
  expect((await refusal(save(k.memberDevice, { itemId: adas.itemId, sites: ["evil.example"] }))).code).toBe("forbidden");
  expect(k.v.store.get(adas.itemId)!.meta.sites).toEqual(["bank.example"]);
  // Any session on the hub may fill it, whichever project.
  expect(k.v.usable().map((r) => r.itemId).sort()).toEqual([bos.itemId, ada.itemId, adas.itemId].sort());
  expect((await refusal(save(k.ownerDevice, { kind: "env", scope: "hub", envName: "X", sealed: k.sealToHub({ value: "y" }) }))).code).toBe("invalid");
});

test("an older app adding a person's own or hub-level item, or a project's login, is refused saying to update; its reads work", async () => {
  for (const scope of ["person", "hub", "project"]) {
    const e = await refusal(save(k.memberDevice, { kind: "login", scope, ...PROJECT, label: "Shop", sites: ["shop.example"], sealed: k.sealToHub(LOGIN) }));
    expect([e.code, e.reason, e.message]).toEqual(["invalid", "vault_update_app", "This app is older than the hub: update it to add vault items."]);
  }
  const e = await refusal(save(k.memberDevice, { kind: "env", scope: "person", envName: "TOKEN", sealed: k.sealToHub({ value: "x" }) }));
  expect(e.reason).toBe("vault_update_app");
  // Nothing was stored, at any level.
  expect(k.hub.db.conn.query("SELECT count(*) AS n FROM vault_items").get()).toEqual({ n: 0 });
  // Its reads: the team's items, under the scope it knows as the hub's, and a project's variables.
  const team = await save(k.ownerDevice, { kind: "card", label: "Team", sealed: k.sealToHub(CARD) });
  const env = await save(k.ownerDevice, { kind: "env", scope: "project", ...PROJECT, envName: "TOKEN", sealed: k.sealToHub({ value: "x" }) });
  expect((await list(k.memberDevice, { scope: "hub" })).map((i) => i.itemId)).toEqual([team.itemId]);
  expect((await list(k.memberDevice, { ...PROJECT })).map((i) => i.itemId)).toEqual([env.itemId]);
  expect((await k.call<{ item: Item }>(k.memberDevice, "vault_get", { itemId: team.itemId })).item.scope).toBe("hub");
});

test("an item set aside: only its owner lists it, nothing fills it, and they move it to the team vault or a project, or delete it", async () => {
  const login = k.v.store.insert(
    { kind: "login", scope: "person", personId: k.member.personId, label: "Bo's own", meta: { sites: ["shop.example"], fields: ["username", "password"], source: { kind: "typed" } } },
    LOGIN,
    k.member.personId,
    k.clock.now(),
  );
  const env = k.v.store.insert({ kind: "env", scope: "person", personId: k.member.personId, envName: "BO_TOKEN", label: "BO_TOKEN", meta: { secret: true, source: { kind: "typed" } } }, { value: "planted-bo-1" }, k.member.personId, k.clock.now());
  const card = k.v.store.insert({ kind: "card", scope: "person", personId: k.member.personId, label: "Bo's Visa", meta: { brand: "visa", last4: "4242", source: { kind: "typed" } } }, CARD, k.member.personId, k.clock.now());
  expect((await list(k.memberDevice)).filter((i) => i.scope === "person").map((i) => i.label).sort()).toEqual(["BO_TOKEN", "Bo's Visa", "Bo's own"]);
  expect((await list(k.ownerDevice)).some((i) => i.scope === "person")).toBe(false);
  expect(k.v.usable()).toEqual([]);
  // Only its owner moves it.
  expect((await refusal(k.call(k.ownerDevice, "vault_move", { itemId: login.itemId }))).code).toBe("not_found");
  const moved = await k.call<{ item: Item }>(k.memberDevice, "vault_move", { itemId: login.itemId });
  expect(moved.item.scope).toBe("hub");
  expect(k.v.usable().map((r) => r.itemId)).toEqual([login.itemId]);
  expect((await reveal(k.memberDevice, login.itemId, ["password"])).password).toBe(LOGIN.password);
  // A variable needs a project, and goes in as that project's.
  expect((await refusal(k.call(k.memberDevice, "vault_move", { itemId: env.itemId }))).code).toBe("invalid");
  const asVar = await k.call<{ item: Item & { projectId?: string } }>(k.memberDevice, "vault_move", { itemId: env.itemId, ...PROJECT });
  expect([asVar.item.scope, asVar.item.projectId]).toEqual(["project", PROJECT.projectId]);
  expect(k.v.store.open(k.v.store.get(env.itemId)!).value).toBe("planted-bo-1");
  // A moved item isn't set aside any more; a set-aside one goes with Delete.
  expect((await refusal(k.call(k.memberDevice, "vault_move", { itemId: login.itemId }))).code).toBe("invalid");
  await k.call(k.memberDevice, "vault_delete", { itemId: card.itemId });
  expect(k.v.store.get(card.itemId)!.deletedMs).toBeDefined();
  const audit = await k.call<{ entries: { action: string }[] }>(k.memberDevice, "vault_audit", { itemId: login.itemId });
  expect(audit.entries.map((x) => x.action)).toEqual(["reveal", "move"]);
});

test("a card is checked (Luhn, expiry), its brand and last 4 derived; an edit merges only the changed fields", async () => {
  expect((await refusal(save(k.ownerDevice, { kind: "card", label: "Bad", sealed: k.sealToHub({ ...CARD, number: "4242 4242 4242 4241" }) }))).code).toBe("invalid");
  const card = await save(k.ownerDevice, { kind: "card", label: "Visa", sealed: k.sealToHub(CARD) });
  expect(card.meta).toMatchObject({ brand: "visa", last4: "4242" });
  const renamed = await save(k.ownerDevice, { itemId: card.itemId, label: "Visa (Personal)" });
  expect(renamed.label).toBe("Visa (Personal)");
  await save(k.ownerDevice, { itemId: card.itemId, sealed: k.sealToHub({ cvc: "999", name: null }) });
  expect(await reveal(k.ownerDevice, card.itemId, ["number", "month", "year", "cvc", "name"])).toEqual({ number: "4242424242424242", month: "04", year: "2031", cvc: "999" });
});

test("project variables: everyone who sees the project lists them; operate changes them; the creator or an admin reveals", async () => {
  const item = await save(k.memberDevice, { kind: "env", scope: "project", ...PROJECT, envName: "STAGING_KEY", sealed: k.sealToHub({ value: "planted-st-1" }) });
  const asOwner = (await list(k.ownerDevice, { ...PROJECT })).find((i) => i.itemId === item.itemId)!;
  expect(asOwner.canEdit).toBe(true);
  expect(asOwner.canReveal).toBe(true); // an admin
  const reader = k.device([{ role: "read", machines: "*" }], k.member.personId, "bo-tablet");
  const asReader = (await list(reader, { ...PROJECT })).find((i) => i.itemId === item.itemId)!;
  expect(asReader.canEdit).toBe(false);
  expect((await refusal(save(reader, { itemId: item.itemId, envName: "X" }))).code).toBe("forbidden");
  // The project's list holds its own variables; `usable` adds the team vault's items.
  const team = await save(k.ownerDevice, { kind: "card", label: "Team", sealed: k.sealToHub(CARD) });
  expect((await list(k.ownerDevice, { ...PROJECT })).map((i) => i.itemId)).toEqual([item.itemId]);
  expect((await list(k.ownerDevice, { ...PROJECT, usable: true })).map((i) => i.itemId).sort()).toEqual([item.itemId, team.itemId].sort());
  expect((await list(k.ownerDevice, { ...OTHER })).map((i) => i.itemId)).toEqual([]);
});

test("making someone's secret variable plain, which would list its value, takes who may reveal it", async () => {
  const other = k.device([{ role: "operate", machines: "*" }], people(k.hub).create("Cy", "member").personId, "cy-phone");
  const item = await save(k.memberDevice, { kind: "env", scope: "project", ...PROJECT, envName: "DB_URL", sealed: k.sealToHub({ value: "planted-db-1" }) });
  expect((await refusal(save(other, { itemId: item.itemId, secret: false }))).code).toBe("forbidden");
  expect((await list(other, { ...PROJECT })).find((i) => i.itemId === item.itemId)!.value).toBeUndefined();
  // A new value with it is fine: the old one never shows.
  expect((await save(other, { itemId: item.itemId, secret: false, sealed: k.sealToHub({ value: "public" }) })).value).toBe("public");
  const mine = await save(k.memberDevice, { kind: "env", scope: "project", ...PROJECT, envName: "MINE", sealed: k.sealToHub({ value: "planted-m-1" }) });
  expect((await save(k.memberDevice, { itemId: mine.itemId, secret: false })).value).toBe("planted-m-1");
});

test("delete goes to the trash, restore brings it back, purge removes it for good", async () => {
  const item = await save(k.ownerDevice, { kind: "address", label: "Home", sealed: k.sealToHub({ line1: "1 Main St", city: "Springfield", country: "US" }) });
  expect(item.meta.country).toBe("US");
  await k.call(k.ownerDevice, "vault_delete", { itemId: item.itemId });
  expect((await list(k.ownerDevice)).some((i) => i.itemId === item.itemId)).toBe(false);
  expect((await list(k.ownerDevice, { trash: true })).map((i) => i.itemId)).toEqual([item.itemId]);
  await k.call(k.ownerDevice, "vault_restore", { itemId: item.itemId });
  expect((await list(k.ownerDevice)).some((i) => i.itemId === item.itemId)).toBe(true);
  expect((await refusal(k.call(k.ownerDevice, "vault_delete", { itemId: item.itemId, purge: true }))).code).toBe("not_found");
  await k.call(k.ownerDevice, "vault_delete", { itemId: item.itemId });
  // 30 days on, the sweep empties the trash.
  k.clock.advance(31 * 24 * 3600_000);
  k.v.store.purgeTrash(k.clock.now());
  expect(k.v.store.get(item.itemId)).toBeUndefined();
});

test("variables: names checked, one per name and scope, the project's 100 and 512 KiB limits kept", async () => {
  expect((await refusal(save(k.ownerDevice, { kind: "env", scope: "project", ...PROJECT, envName: "PATH", sealed: k.sealToHub({ value: "x" }) }))).code).toBe("invalid");
  await save(k.ownerDevice, { kind: "env", scope: "project", ...PROJECT, envName: "TOKEN", sealed: k.sealToHub({ value: "a" }) });
  expect((await refusal(save(k.ownerDevice, { kind: "env", scope: "project", ...PROJECT, envName: "TOKEN", sealed: k.sealToHub({ value: "b" }) }))).message).toContain("TOKEN");
  const big = "x".repeat(60 * 1024);
  for (let i = 0; i < 8; i++) await save(k.ownerDevice, { kind: "env", scope: "project", ...PROJECT, envName: `BIG_${i}`, sealed: k.sealToHub({ value: big }) });
  expect((await refusal(save(k.ownerDevice, { kind: "env", scope: "project", ...PROJECT, envName: "BIG_9", sealed: k.sealToHub({ value: big }) }))).message).toContain("512 KiB");
  // A plain variable's value is listed; a secret one's never is.
  // Renaming onto a taken name is refused as such, not a hub failure.
  const other = await save(k.ownerDevice, { kind: "env", scope: "project", ...PROJECT, envName: "OTHER", sealed: k.sealToHub({ value: "o" }) });
  const taken = await refusal(save(k.ownerDevice, { itemId: other.itemId, envName: "TOKEN" }));
  expect([taken.code, taken.message]).toEqual(["invalid", "There is a variable TOKEN here already."]);
  const plain = await save(k.ownerDevice, { kind: "env", scope: "project", ...PROJECT, envName: "REGION", secret: false, sealed: k.sealToHub({ value: "eu-west" }) });
  expect(plain.value).toBe("eu-west");
  expect((await list(k.ownerDevice, { ...PROJECT })).find((i) => i.label === "TOKEN")!.value).toBeUndefined();
});

test("a value sealed to another key is refused, and the database holds no value in the clear", async () => {
  expect((await refusal(save(k.ownerDevice, { kind: "login", label: "x", sealed: Buffer.from("not sealed at all, just text").toString("base64") }))).code).toBe("invalid");
  await save(k.ownerDevice, { kind: "login", label: "Shop", sites: ["shop.example"], sealed: k.sealToHub(LOGIN) });
  await save(k.ownerDevice, { kind: "card", label: "Visa", sealed: k.sealToHub(CARD) });
  const dump = Buffer.from(k.hub.db.conn.serialize());
  for (const planted of [LOGIN.password, "4242424242424242", "ada@example.test"]) expect(dump.includes(Buffer.from(planted))).toBe(false);
});

test("reveals are rate limited per person", async () => {
  const item = await save(k.ownerDevice, { kind: "login", label: "Shop", sites: ["shop.example"], sealed: k.sealToHub(LOGIN) });
  for (let i = 0; i < 30; i++) await reveal(k.ownerDevice, item.itemId, ["username"]);
  const e = await refusal(reveal(k.ownerDevice, item.itemId, ["username"]));
  expect(e.reason).toBe("vault_rate_limited");
});

test("rotation rewraps every item under a new key, which then opens them alone", async () => {
  const item = await save(k.ownerDevice, { kind: "login", label: "Shop", sites: ["shop.example"], sealed: k.sealToHub(LOGIN) });
  k.v.store.setSetting("recovery_saved_ms", "1");
  const out = await k.call<{ keyId: string; rewrapped: number }>(k.ownerDevice, "vault_rotate", {});
  expect(out).toEqual({ keyId: "k2", rewrapped: 1 });
  expect(k.v.keys.all().map((x) => x.id)).toEqual(["k2"]);
  expect((await reveal(k.ownerDevice, item.itemId, ["password"])).password).toBe(LOGIN.password);
  expect((await refusal(k.call(k.memberDevice, "vault_rotate", {}))).code).toBe("forbidden");
  const status = await k.call<{ keyId: string; keyMode: string; recoverySaved: boolean; hubBoxKey: string }>(k.ownerDevice, "vault_status", {});
  // The code saved before was the retired key's: it needs saving again.
  expect(status).toMatchObject({ keyId: "k2", keyMode: "file", recoverySaved: false, hubBoxKey: Buffer.from(k.hubPub()).toString("base64") });
});
