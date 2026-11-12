// `vault_fill` and `vault_filled` (src/hub/vault/calls.ts): who a fill is for comes from the browser session's own
// record; only usable items, only on their own sites, cards never; the value sealed to the hosting node; every fill
// and refusal audited; rate limits.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chat } from "../src/hub/chat/index.ts";
import { leadCalls, type LeadCaller } from "../src/hub/lead_calls/index.ts";
import { onSite, registerLeadCalls } from "../src/hub/vault/calls.ts";
import { totpCode } from "../src/hub/vault/fields.ts";
import { ToolError } from "../src/shared/errors.ts";
import { browserSession, M, OTHER, PROJECT, type VaultHub, vaultHub } from "./vault-kit.ts";

let k: VaultHub;
const S = "B0123456789abcdef0123456789abcdef";
const lead: LeadCaller = { projectRef: PROJECT, by: "lead:devbox/p1", agent: { kind: "lead" }, threadId: "t-lead", via: M };
const SEED = "JBSWY3DPEHPK3PXP";

beforeEach(async () => {
  k = vaultHub();
  await k.v.load();
  registerLeadCalls(k.hub);
  browserSession(k, S);
});
afterEach(() => k.done());

const save = (input: Record<string, unknown>, caller = k.ownerDevice) => k.call<{ item: { itemId: string } }>(caller, "vault_save", input).then((o) => o.item.itemId);
const fill = async (call: Record<string, unknown>, caller: LeadCaller = lead) =>
  (await leadCalls(k.hub).handler("vault_fill")!(caller, { op: "vault_fill", sessionId: S, ...call } as never)) as { itemId: string; label: string; auditId: number; sealed: string };
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};
const audit = () => k.hub.db.all<{ action: string; outcome: string; item_id: string; data: string }>("SELECT action, outcome, item_id, data FROM vault_audit WHERE action LIKE 'fill%' ORDER BY n");

async function shopLogin() {
  return save({ kind: "login", label: "Shop", sites: ["shop.example"], sealed: k.sealToHub({ username: "ada", password: "planted-pw-77", totp: SEED }) });
}

test("the site rule: the host or a subdomain; never a look-alike, a dotless site or a shared-hosting neighbour", () => {
  expect(onSite("shop.example", "shop.example")).toBe(true);
  expect(onSite("www.shop.example", "shop.example")).toBe(true);
  expect(onSite("shop.example.evil.test", "shop.example")).toBe(false);
  expect(onSite("evilshop.example", "shop.example")).toBe(false);
  expect(onSite("localhost", "localhost")).toBe(false);
  expect(onSite("ada.github.io", "github.io")).toBe(false);
  expect(onSite("ada.github.io", "ada.github.io")).toBe(true);
  expect(onSite("x.ada.github.io", "ada.github.io")).toBe(false);
});

test("a login fills on its site and subdomains, sealed to the hosting node; vault_filled closes its audit row once", async () => {
  const id = await shopLogin();
  const out = await fill({ item: "Shop", field: "password", page: "https://www.shop.example/signin" });
  expect(out.itemId).toBe(id);
  expect(out.label).toBe("Shop");
  expect(JSON.stringify(out)).not.toContain("planted-pw-77");
  expect(JSON.parse(k.open(out.sealed))).toEqual({ value: "planted-pw-77", sites: ["shop.example"] });
  const otp = await fill({ item: id, field: "otp", page: "https://shop.example/2fa" });
  expect(JSON.parse(k.open(otp.sealed)).value).toBe(totpCode(SEED, k.clock.now()));
  const filled = leadCalls(k.hub).handler("vault_filled")!;
  await filled(lead, { op: "vault_filled", auditId: out.auditId, ok: true, typed: true } as never);
  const again = await refused((async () => filled({ ...lead, via: "elsewhere" }, { op: "vault_filled", auditId: otp.auditId, ok: true, typed: true } as never))());
  expect(again.code).toBe("forbidden");
  const rows = audit();
  expect(rows.map((r) => [r.action, r.outcome])).toEqual([
    ["fill", "ok"],
    ["fill", "pending"],
  ]);
  expect(JSON.parse(rows[0]!.data)).toMatchObject({ label: "Shop", fields: ["password"], site: "www.shop.example", host: M, sessionId: S, typed: true });
  for (const r of rows) expect(r.data).not.toContain("planted-pw-77");
});

test("refused: off its site, over http, a card, an unknown session, another project's session, another machine", async () => {
  await shopLogin();
  await save({ kind: "card", label: "Visa", sealed: k.sealToHub({ number: "4242424242424242" }) });
  expect((await refused(fill({ item: "Shop", field: "password", page: "https://shop.example.evil.test/" }))).code).toBe("forbidden");
  expect((await refused(fill({ item: "Shop", field: "password", page: "https://shop.example/", frame: "https://evil.test/frame" }))).code).toBe("forbidden");
  expect((await refused(fill({ item: "Shop", field: "password", page: "http://shop.example/" }))).code).toBe("forbidden");
  expect((await refused(fill({ item: "Visa", field: "password", page: "https://shop.example/" }))).message).toContain("purchase");
  expect((await refused(fill({ item: "Shop", field: "password", page: "https://shop.example/", sessionId: "B0123456789abcdef0123456789abcdee" }))).code).toBe("not_found");
  // The team vault fills in any project's session, but only in a session of the calling project.
  expect((await refused(fill({ item: "Shop", field: "password", page: "https://shop.example/" }, { ...lead, projectRef: OTHER }))).code).toBe("not_found");
  expect((await refused(fill({ item: "Shop", field: "password", page: "https://shop.example/" }, { ...lead, via: "builder-1" }))).code).toBe("forbidden");
  // Refusals are audited, never with a value; the third in ten minutes puts one quiet line in the chat.
  const rows = audit();
  expect(rows.filter((r) => r.action === "fill_refused").length).toBeGreaterThanOrEqual(3);
  const lines = chat(k.hub).page(PROJECT, undefined, undefined, 50).messages.map((m) => m.text);
  expect(lines.filter((t) => t.startsWith("An agent tried to fill")).length).toBe(1);
});

test("a team login fills in every project's sessions, whoever added it; an item set aside fills nowhere", async () => {
  const id = await save({ kind: "login", label: "Bo's mail", sites: ["mail.example"], sealed: k.sealToHub({ password: "bo-pw" }) }, k.memberDevice);
  expect((await fill({ item: "Bo's mail", field: "password", page: "https://mail.example/" })).itemId).toBe(id);
  const S2 = "B0123456789abcdef0123456789abcd02";
  browserSession(k, S2, OTHER);
  expect((await fill({ item: "Bo's mail", field: "password", page: "https://mail.example/", sessionId: S2 }, { ...lead, projectRef: OTHER })).itemId).toBe(id);
  // Set aside at the upgrade: its owner's alone, used by nothing.
  const aside = k.v.store.insert(
    { kind: "login", scope: "person", personId: k.member.personId, label: "Bo's bank", meta: { sites: ["bank.example"], fields: ["password"], source: { kind: "typed" } } },
    { password: "planted-aside-1" },
    k.member.personId,
    k.clock.now(),
  );
  for (const [sessionId, projectRef] of [[S, PROJECT], [S2, OTHER]] as const) {
    expect((await refused(fill({ item: aside.itemId, field: "password", page: "https://bank.example/", sessionId }, { ...lead, projectRef }))).code).toBe("not_found");
  }
});

test("an address fills on its own sites or a site the team vault has a login for, and nowhere else", async () => {
  await save({ kind: "address", label: "Home", sealed: k.sealToHub({ line1: "1 Main St", city: "Springfield", postalCode: "00000", country: "US" }) });
  // Bo's login, not the address's creator's: the team vault's logins all count.
  await save({ kind: "login", label: "Store", sites: ["store.example"], sealed: k.sealToHub({ password: "x" }) }, k.memberDevice);
  const out = await fill({ item: "Home", field: "address", page: "https://checkout.store.example/" });
  expect(JSON.parse(k.open(out.sealed))).toEqual({ line1: "1 Main St", city: "Springfield", postalCode: "00000", country: "US", sites: [] });
  const e = await refused(fill({ item: "Home", field: "address", page: "https://random.example/" }));
  expect([e.code, e.message]).toEqual([
    "forbidden",
    "Home doesn't fill on random.example: an address fills at a checkout recorded in this session, on its own sites, or on a site the team vault has a login for.",
  ]);
  // A login set aside doesn't count.
  k.v.store.insert({ kind: "login", scope: "person", personId: k.member.personId, label: "Aside", meta: { sites: ["random.example"], fields: ["password"], source: { kind: "typed" } } }, { password: "y" }, k.member.personId, k.clock.now());
  expect((await refused(fill({ item: "Home", field: "address", page: "https://random.example/" }))).code).toBe("forbidden");
});

test("an op:// reference fills the item imported from it; one not imported says so", async () => {
  await save({ kind: "login", label: "Shop", sites: ["shop.example"], sealed: k.sealToHub({ password: "pw" }) });
  const e = await refused(fill({ ref: "op://Fleet/Shop/password", field: "password", page: "https://shop.example/" }));
  expect(e.reason).toBe("vault_not_imported");
  k.hub.db.conn.query("UPDATE vault_items SET meta = json_set(meta, '$.source', json('{\"kind\":\"1password\",\"ref\":\"op://Fleet/Shop\",\"importedMs\":1}'))").run();
  expect((await fill({ ref: "op://Fleet/Shop/password", field: "password", page: "https://shop.example/" })).label).toBe("Shop");
});

test("30 fills an hour per item per project, then refused until the hour has passed", async () => {
  await shopLogin();
  for (let i = 0; i < 30; i++) await fill({ item: "Shop", field: "username", page: "https://shop.example/" });
  expect((await refused(fill({ item: "Shop", field: "username", page: "https://shop.example/" }))).reason).toBe("vault_rate_limited");
  k.clock.advance(3601_000);
  await fill({ item: "Shop", field: "username", page: "https://shop.example/" });
});

test("a locked vault refuses fills", async () => {
  await shopLogin();
  k.v.problem = undefined;
  (k.v.keys as unknown as { keys: unknown[] }).keys = [];
  const e = await refused(fill({ item: "Shop", field: "password", page: "https://shop.example/" }));
  expect(["vault_key_missing", "vault_locked"]).toContain(e.reason ?? "");
});
