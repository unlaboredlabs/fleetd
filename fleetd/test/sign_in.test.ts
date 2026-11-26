// A sign-in form (request_sign_in; src/hub/vault/sign_in.ts, approvals/sign_in_rules.ts): a vault login for the site
// answers with no ask; else the form opens as a request sealed to the hub's own key; the person's box goes on to the
// node sealed to it; "Save to Vault" keeps the login for that site so the next sign-in fills by itself; a code alone is
// never kept; and no value ever shows in the request, its events or the lead's wake.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { approvals } from "../src/hub/approvals/index.ts";
import { requestOutcome } from "../src/hub/approvals/outcome.ts";
import { fieldsOf, loginTarget, signInLabel, signInValues, vaultLogin, vaultTried } from "../src/hub/approvals/sign_in_rules.ts";
import { leadCalls, type LeadCaller } from "../src/hub/lead_calls/index.ts";
import { start as startVault } from "../src/hub/vault/loops.ts";
import type { ItemRow } from "../src/hub/vault/item.ts";
import { ToolError } from "../src/shared/errors.ts";
import { seal } from "../src/shared/sealed_box.ts";
import { browserSession, M, PROJECT, type VaultHub, vaultHub } from "./vault-kit.ts";

let k: VaultHub;
const S = "B0123456789abcdef0123456789abcdef";
/** Another browser session of the same lead: a fresh browser. */
const S2 = "B1123456789abcdef0123456789abcdef";
const lead: LeadCaller = { projectRef: PROJECT, by: "lead:devbox/p1", agent: { kind: "lead" }, threadId: "t-lead", via: M };
const SITE = { domain: "shop.example", name: "Shop" };
const USER = "ada@shop.example";
const PASSWORD = "planted-signin-pw-41";
const CODE = "730214";
/** What the fake node got for each fill: the opened box. */
let delivered: { sink: string; requestId: string; plain: Record<string, string> }[];

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

beforeEach(async () => {
  k = vaultHub();
  startVault(k.hub);
  await k.v.load();
  browserSession(k, S);
  browserSession(k, S2);
  delivered = [];
  approvals(k.hub).deps.nodes.deliverSecret = async (_m, input) => {
    const plain = k.open(String(input.sealed));
    delivered.push({ sink: String(input.sink), requestId: String(input.requestId), plain: JSON.parse(plain) });
    return { fingerprint: "0badf00d" };
  };
});
afterEach(() => k.done());

const open = async (input: Record<string, unknown>, sessionId = S, caller: LeadCaller = lead) =>
  (await leadCalls(k.hub).handler("sign_in_open")!(caller, { op: "sign_in_open", sessionId, input: { site: SITE, why: "upload the build", ...input } } as never)) as {
    requestId?: string;
    state?: string;
    vault?: { itemId: string; label: string };
  };
const submit = (requestId: string, fields: Record<string, string>, save = true) =>
  k.call<{ fingerprint: string; next: string }>(k.ownerDevice, "secret_submit", { requestId, sealed: b64(seal(k.hubPub(), Buffer.from(JSON.stringify(fields)))), save });
const logins = () => k.v.store.select("kind = 'login'", []);
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError || (e as { message?: string }).message) return e as Error;
    throw e;
  }
  throw new Error("expected a refusal");
};

test("no vault login: the form opens as a request sealed to the hub's key, once per session and fields", async () => {
  const opened = await open({ username: "#email", password: "#pw" });
  expect(opened.vault).toBeUndefined();
  const r = approvals(k.hub).get(opened.requestId!)!;
  expect(r.kind).toBe("secret");
  expect(r.state).toBe("open");
  expect(r.secret).toMatchObject({ key: "browser.sign_in", sink: `fill:${M}:${S}`, sealTo: b64(k.hubPub()) });
  expect(r.secureInput).toMatchObject({ label: "Sign in to Shop", site: SITE, target: "#email", sessionId: S, signIn: { fields: ["username", "password"] } });
  expect(r.text).toBe("Sign in to Shop (shop.example): upload the build");
  // Asked again while it is open: the same card.
  expect((await open({ username: "#email", password: "#pw" })).requestId).toBe(opened.requestId!);
  // No field: refused before anything opens.
  expect((await refused(open({}))).message).toContain("at least one field");
});

test("submitted with Save: filled on the node, saved as the site's login, and the next sign-in fills with no form", async () => {
  const opened = await open({ username: "#email", password: "#pw" });
  const out = await submit(opened.requestId!, { username: USER, password: PASSWORD });
  expect(out.next).toBe("Filled on shop.example; saved to the vault as Shop. The agent never sees it.");
  expect(delivered).toEqual([{ sink: `fill:${M}:${S}`, requestId: opened.requestId!, plain: { username: USER, password: PASSWORD } }]);
  const [row] = logins();
  expect(row).toMatchObject({ label: "Shop", scope: "hub", meta: { sites: ["shop.example"], fields: ["username", "password"] } });
  expect(k.v.store.open(row!)).toEqual({ username: USER, password: PASSWORD });
  const r = approvals(k.hub).get(opened.requestId!)!;
  expect(r.state).toBe("stored");
  expect(r.secureInput?.signIn?.saved).toEqual({ itemId: row!.itemId, label: "Shop" });
  expect(requestOutcome(r).outcome).toContain("saved it to the vault as Shop: the next sign-in there fills by itself");
  // Its use is logged as the person's.
  const audit = k.hub.db.all<{ action: string; person_id: string | null }>("SELECT action, person_id FROM vault_audit WHERE item_id = ?", [row!.itemId]);
  expect(audit).toEqual([{ action: "create", person_id: k.owner.personId }]);
  // The next sign-in on that site, in a fresh browser: the vault's login, no request.
  expect(await open({ username: "#email", password: "#pw" }, S2)).toEqual({ vault: { itemId: row!.itemId, label: "Shop" } });
  const opens = approvals(k.hub).list({ projectRef: PROJECT, limit: 100 }).length;
  expect(opens).toBe(1);
});

test("a login the site refused: asked again in that browser, the person gets the form, and their Save replaces it", async () => {
  // Typed wrong and saved (Save is on by default).
  const first = await open({ username: "#email", password: "#pw" });
  await submit(first.requestId!, { username: USER, password: "typo-pw" });
  const id = logins()[0]!.itemId;
  // The site refused it; the agent asks again in the same browser: the form, not the vault's wrong password.
  const again = await open({ username: "#email", password: "#pw" });
  expect(again.vault).toBeUndefined();
  expect(again.requestId).not.toBe(first.requestId);
  await submit(again.requestId!, { username: USER, password: PASSWORD });
  expect(logins().map((r) => r.itemId)).toEqual([id]);
  expect(k.v.store.open(logins()[0]!)).toEqual({ username: USER, password: PASSWORD });
  // A fresh browser fills the corrected login with no ask; once it filled there, asked again, the person is asked.
  expect((await open({ username: "#email", password: "#pw" }, S2)).vault?.itemId).toBe(id);
  await leadCalls(k.hub).handler("vault_fill")!(lead, { op: "vault_fill", sessionId: S2, item: id, field: "password", page: "https://www.shop.example/login" } as never);
  expect((await open({ username: "#email", password: "#pw" }, S2)).requestId).toMatch(/^Q\d+$/);
});

test("a two-page sign-in (the username, then the password) fills both from the vault, from a form's Save as well", async () => {
  // From the vault: the username page, then the password page, in a fresh browser.
  const first = await open({ username: "#email", password: "#pw" });
  await submit(first.requestId!, { username: USER, password: PASSWORD });
  const id = logins()[0]!.itemId;
  expect((await open({ username: "#email" }, S2)).vault?.itemId).toBe(id);
  await leadCalls(k.hub).handler("vault_fill")!(lead, { op: "vault_fill", sessionId: S2, item: id, field: "username", page: "https://shop.example/login" } as never);
  expect((await open({ password: "#pw" }, S2)).vault?.itemId).toBe(id);
});

test("a two-page sign-in through the form: the username's form saves the login, and the password page fills from it", async () => {
  const user = await open({ username: "#email" });
  await submit(user.requestId!, { username: USER, password: PASSWORD });
  expect(delivered.at(-1)!.plain).toEqual({ username: USER, password: PASSWORD });
  expect((await open({ password: "#pw" })).vault?.itemId).toBe(logins()[0]!.itemId);
});

test("a code the site asks for after the password: its own form, filled, never kept", async () => {
  const login = await open({ username: "#email", password: "#pw" });
  await submit(login.requestId!, { username: USER, password: PASSWORD });
  // The vault's login has no TOTP: the code needs the person.
  const code = await open({ otp: "#code" });
  expect(code.vault).toBeUndefined();
  const r = approvals(k.hub).get(code.requestId!)!;
  expect(r.secureInput).toMatchObject({ label: "Code for Shop", signIn: { fields: ["otp"] } });
  expect(r.text).toBe("Enter the code Shop sent you (shop.example): upload the build");
  const out = await submit(code.requestId!, { otp: ` ${CODE} ` });
  expect(out.next).toBe("Filled on shop.example. The agent never sees it.");
  expect(delivered.at(-1)!.plain).toEqual({ otp: CODE });
  expect(logins()).toHaveLength(1);
  expect(k.v.store.open(logins()[0]!)).toEqual({ username: USER, password: PASSWORD });
});

test("unticked, nothing is kept; a box missing an asked field is refused and the form stays open", async () => {
  const opened = await open({ username: "#email", password: "#pw" });
  expect((await refused(submit(opened.requestId!, { username: USER }))).message).toContain("needs the password");
  expect(approvals(k.hub).get(opened.requestId!)!.state).toBe("open");
  expect((await refused(submit(opened.requestId!, { username: USER, password: PASSWORD, notes: "x" }))).message).toContain("no field notes");
  await submit(opened.requestId!, { username: USER, password: PASSWORD }, false);
  expect(logins()).toHaveLength(0);
  expect(approvals(k.hub).get(opened.requestId!)!.secureInput?.signIn?.saved).toBeUndefined();
});

test("Save again with the same username updates that login, keeping its other fields; another username adds one", async () => {
  // A form for the password alone (the vault's login, once saved, would fill a second ask by itself).
  const form = () =>
    approvals(k.hub).create({
      projectRef: PROJECT,
      kind: "secret",
      text: "Sign in to Shop (shop.example): upload the build",
      secret: { key: "browser.sign_in", sink: `fill:${M}:${S}` },
      secureInput: { site: SITE, target: "#pw", label: "Sign in to Shop", why: "upload the build", sessionId: S, signIn: { fields: ["password"] } },
      at: new Date(k.clock.now()).toISOString(),
      atMs: k.clock.now(),
    });
  await submit(form().requestId, { username: USER, password: "old-pw-1" });
  const id = logins()[0]!.itemId;
  // The person adds a TOTP secret to it; a new password through the form keeps it.
  await k.call(k.ownerDevice, "vault_save", { itemId: id, sealed: k.sealToHub({ totp: "JBSWY3DPEHPK3PXP" }) });
  await submit(form().requestId, { username: USER.toUpperCase(), password: "new-pw-2" });
  expect(logins()).toHaveLength(1);
  expect(k.v.store.open(logins()[0]!)).toEqual({ username: USER.toUpperCase(), password: "new-pw-2", totp: "JBSWY3DPEHPK3PXP" });
  // Now it holds a TOTP secret too: a code asked for fills from it, with no form.
  expect((await open({ otp: "#code" })).vault?.itemId).toBe(id);
  // Another account on the same site: a second login.
  await submit(form().requestId, { username: "bo@shop.example", password: "bo-pw-3" });
  expect(logins()).toHaveLength(2);
});

test("no value shows in the request, its events or the lead's wake", async () => {
  const opened = await open({ username: "#email", password: "#pw" });
  await submit(opened.requestId!, { username: USER, password: PASSWORD });
  const code = await open({ otp: "#code" });
  await submit(code.requestId!, { otp: CODE });
  const seen = JSON.stringify([
    approvals(k.hub).list({ projectRef: PROJECT, limit: 100 }),
    k.hub.db.all("SELECT * FROM events"),
    k.hub.db.all("SELECT data FROM vault_audit"),
    approvals(k.hub).list({ projectRef: PROJECT, limit: 100 }).map(requestOutcome),
  ]);
  for (const v of [USER, PASSWORD, CODE]) expect(seen).not.toContain(v);
});

test("the rules: fields in fill order, labels, the box's checks, the vault hit and the login a save updates", () => {
  expect(fieldsOf({ otp: "#c", username: "#u" })).toEqual(["username", "otp"]);
  expect(signInLabel(SITE, ["otp"])).toBe("Code for Shop");
  expect(signInLabel(SITE, ["username", "otp"])).toBe("Sign in to Shop");
  expect(vaultTried(["password"], new Set(["password"]))).toBe(true);
  expect(vaultTried(["password"], new Set(["username"]))).toBe(false);
  expect(vaultTried(["otp"], new Set(["username", "password"]))).toBe(false);
  expect(vaultTried(["username", "password"], new Set())).toBe(false);
  expect(signInValues({ username: "a", password: "", otp: null }, ["username"])).toEqual({ username: "a" });
  expect(() => signInValues({ password: 7 }, ["password"])).toThrow("isn't text");
  expect(() => signInValues("x", ["password"])).toThrow("JSON object");
  const row = (itemId: string, sites: string[], fields: string[], updatedMs = 1, kind = "login") => ({ itemId, kind, label: itemId, meta: { sites, fields, source: { kind: "typed" } }, updatedMs }) as unknown as ItemRow;
  const rows = [row("A", ["shop.example"], ["username", "password"], 1), row("B", ["shop.example"], ["username", "password", "totp"], 2), row("C", ["shop.example.evil"], ["username", "password"], 3), row("D", ["shop.example"], [], 4, "address")];
  expect(vaultLogin(rows, "www.shop.example", ["username", "password"])?.itemId).toBe("B");
  expect(vaultLogin(rows, "shop.example", ["otp"])?.itemId).toBe("B");
  expect(vaultLogin(rows, "evilshop.example", ["password"])).toBeUndefined();
  const c = (r: ItemRow, username: string | undefined, canEdit = true) => ({ row: r, username, canEdit });
  expect(loginTarget([c(rows[0]!, "ada"), c(rows[1]!, "bo")], "shop.example", "Bo")).toBe("B");
  expect(loginTarget([c(rows[0]!, "ada", false)], "shop.example", "ada")).toBeUndefined();
  expect(loginTarget([c(rows[0]!, undefined)], "shop.example", "ada")).toBe("A");
  expect(loginTarget([c(row("E", ["www.shop.example"], ["password"]), "ada")], "shop.example", "ada")).toBeUndefined();
});
