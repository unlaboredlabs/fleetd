// The vault's tools from a person's device: who lists, changes and reveals what (person, project, Only me, order,
// hub), sharing, the trash, the limits, and that the database holds no value in the clear.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { openSealed, publicKeyOf } from "../src/shared/sealed_box.ts";
import { setOnlyMe } from "../src/hub/navi/store.ts";
import { OTHER, PROJECT, type VaultHub, vaultHub } from "./vault-kit.ts";
import { refusal } from "./people-kit.ts";

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

test("a person's own login: metadata worked out by the hub, the value only through a sealed reveal", async () => {
  const item = await save(k.ownerDevice, { kind: "login", scope: "person", label: "Shop", sites: ["www.shop.example"], sealed: k.sealToHub(LOGIN) });
  expect(item.meta).toEqual({ sites: ["www.shop.example"], fields: ["username", "password"], source: { kind: "typed" } });
  expect(item.canEdit && item.canReveal).toBe(true);
  expect(JSON.stringify(item)).not.toContain(LOGIN.password);
  expect(await reveal(k.ownerDevice, item.itemId, ["password"])).toEqual({ password: LOGIN.password });
  // Nobody else lists it, not even an admin's second device of another person.
  expect((await list(k.memberDevice)).map((i) => i.itemId)).not.toContain(item.itemId);
  expect((await refusal(k.call(k.memberDevice, "vault_get", { itemId: item.itemId }))).code).toBe("not_found");
  // An agent key never reaches the vault's tools.
  expect((await refusal(k.call(k.agent(), "vault_list", {}))).code).toBe("forbidden");
  // Every write and reveal is audited, never with a value.
  const audit = await k.call<{ entries: { action: string; data: unknown }[] }>(k.ownerDevice, "vault_audit", { itemId: item.itemId });
  expect(audit.entries.map((e) => e.action)).toEqual(["reveal", "create"]);
  expect(JSON.stringify(audit)).not.toContain(LOGIN.password);
});

test("a card is checked (Luhn, expiry), its brand and last 4 derived; an edit merges only the changed fields", async () => {
  expect((await refusal(save(k.ownerDevice, { kind: "card", scope: "person", label: "Bad", sealed: k.sealToHub({ ...CARD, number: "4242 4242 4242 4241" }) }))).code).toBe("invalid");
  const card = await save(k.ownerDevice, { kind: "card", scope: "person", label: "Visa", sealed: k.sealToHub(CARD) });
  expect(card.meta).toMatchObject({ brand: "visa", last4: "4242" });
  const renamed = await save(k.ownerDevice, { itemId: card.itemId, label: "Visa (Personal)" });
  expect(renamed.label).toBe("Visa (Personal)");
  await save(k.ownerDevice, { itemId: card.itemId, sealed: k.sealToHub({ cvc: "999", name: null }) });
  expect(await reveal(k.ownerDevice, card.itemId, ["number", "month", "year", "cvc", "name"])).toEqual({ number: "4242424242424242", month: "04", year: "2031", cvc: "999" });
});

test("project items: everyone who sees the project lists them; operate changes them; the creator or an admin reveals", async () => {
  const item = await save(k.memberDevice, { kind: "login", scope: "project", ...PROJECT, label: "Staging", sites: ["staging.example.com"], sealed: k.sealToHub(LOGIN) });
  const asOwner = (await list(k.ownerDevice)).find((i) => i.itemId === item.itemId)!;
  expect(asOwner.canEdit).toBe(true);
  expect(asOwner.canReveal).toBe(true); // an admin
  const reader = k.device([{ role: "read", machines: "*" }], k.member.personId, "bo-tablet");
  const asReader = (await list(reader)).find((i) => i.itemId === item.itemId)!;
  expect(asReader.canEdit).toBe(false);
  expect((await refusal(save(reader, { itemId: item.itemId, label: "x" }))).code).toBe("forbidden");
  // The project's list holds its own items; `usable` adds what its work may use.
  expect((await list(k.ownerDevice, { ...PROJECT })).map((i) => i.itemId)).toEqual([item.itemId]);
  expect((await list(k.ownerDevice, { ...OTHER })).map((i) => i.itemId)).toEqual([]);
});

test("an Only me project's items are its owner's alone", async () => {
  setOnlyMe(k.hub.db.conn, OTHER, true, k.member.personId);
  const item = await save(k.memberDevice, { kind: "env", scope: "project", ...OTHER, envName: "API_KEY", sealed: k.sealToHub({ value: "planted-env-7q" }) });
  expect((await list(k.memberDevice)).some((i) => i.itemId === item.itemId)).toBe(true);
  expect((await list(k.ownerDevice)).some((i) => i.itemId === item.itemId)).toBe(false);
  expect((await reveal(k.memberDevice, item.itemId, ["value"])).value).toBe("planted-env-7q");
});

test("hub items: everyone lists and uses them, only admins change and reveal them; variables can't be hub-wide", async () => {
  expect((await refusal(save(k.memberDevice, { kind: "card", scope: "hub", label: "Team", sealed: k.sealToHub(CARD) }))).code).toBe("forbidden");
  const team = await save(k.ownerDevice, { kind: "card", scope: "hub", label: "Team", sealed: k.sealToHub(CARD) });
  const asMember = (await list(k.memberDevice)).find((i) => i.itemId === team.itemId)!;
  expect([asMember.canEdit, asMember.canReveal]).toEqual([false, false]);
  expect((await refusal(reveal(k.memberDevice, team.itemId, ["number"]))).code).toBe("forbidden");
  expect((await refusal(save(k.ownerDevice, { kind: "env", scope: "hub", envName: "X", sealed: k.sealToHub({ value: "y" }) }))).code).toBe("invalid");
});

test("sharing a person's card with a project lets its work use it, never reveal it", async () => {
  const card = await save(k.memberDevice, { kind: "card", scope: "person", label: "Bo's Visa", sealed: k.sealToHub(CARD) });
  expect((await list(k.ownerDevice, { ...PROJECT, usable: true })).some((i) => i.itemId === card.itemId)).toBe(false);
  await k.call(k.memberDevice, "vault_share_set", { itemId: card.itemId, projects: [PROJECT] });
  expect(k.v.usable({ projectRef: PROJECT }).map((r) => r.itemId)).toContain(card.itemId);
  expect(k.v.usable({ projectRef: OTHER }).map((r) => r.itemId)).not.toContain(card.itemId);
  // The owner of the hub still doesn't list another person's item.
  expect((await list(k.ownerDevice, { ...PROJECT, usable: true })).some((i) => i.itemId === card.itemId)).toBe(false);
  expect((await refusal(k.call(k.ownerDevice, "vault_share_set", { itemId: card.itemId, projects: [] }))).code).toBe("not_found");
});

test("delete goes to the trash, restore brings it back, purge removes it for good", async () => {
  const item = await save(k.ownerDevice, { kind: "address", scope: "person", label: "Home", sealed: k.sealToHub({ line1: "1 Main St", city: "Springfield", country: "US" }) });
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
  expect((await refusal(save(k.ownerDevice, { kind: "login", scope: "person", label: "x", sealed: Buffer.from("not sealed at all, just text").toString("base64") }))).code).toBe("invalid");
  await save(k.ownerDevice, { kind: "login", scope: "person", label: "Shop", sites: ["shop.example"], sealed: k.sealToHub(LOGIN) });
  await save(k.ownerDevice, { kind: "card", scope: "person", label: "Visa", sealed: k.sealToHub(CARD) });
  const dump = Buffer.from(k.hub.db.conn.serialize());
  for (const planted of [LOGIN.password, "4242424242424242", "ada@example.test"]) expect(dump.includes(Buffer.from(planted))).toBe(false);
});

test("reveals are rate limited per person", async () => {
  const item = await save(k.ownerDevice, { kind: "login", scope: "person", label: "Shop", sites: ["shop.example"], sealed: k.sealToHub(LOGIN) });
  for (let i = 0; i < 30; i++) await reveal(k.ownerDevice, item.itemId, ["username"]);
  const e = await refusal(reveal(k.ownerDevice, item.itemId, ["username"]));
  expect(e.reason).toBe("vault_rate_limited");
});

test("rotation rewraps every item under a new key, which then opens them alone", async () => {
  const item = await save(k.ownerDevice, { kind: "login", scope: "person", label: "Shop", sites: ["shop.example"], sealed: k.sealToHub(LOGIN) });
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
