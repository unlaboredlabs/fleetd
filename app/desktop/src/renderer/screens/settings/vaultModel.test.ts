import { describe, expect, it } from "vitest";
import type { VaultAuditEntry, VaultItemSummary } from "../../../shared/contracts";
import {
  auditLine,
  brandOf,
  check,
  draftOf,
  emptyDraft,
  groupNumber,
  hostOf,
  importOutcome,
  listInput,
  luhn,
  onPage,
  parseExpiry,
  presentFields,
  rowLine,
  scopeTag,
  shownFields,
  shownItems,
  sitesOf,
  titleOf,
  vaultErrorWords,
  vaultServed,
} from "./vaultModel";

const NOW = new Date("2026-11-09T12:00:00Z");

const item = (over: Partial<VaultItemSummary>): VaultItemSummary => ({
  itemId: "V00000000000000000000000000000001",
  kind: "login",
  scope: "person",
  label: "Amazon",
  meta: { source: { kind: "typed" }, sites: ["amazon.com"], fields: ["username", "password"] },
  canEdit: true,
  canReveal: true,
  createdMs: 0,
  updatedMs: 0,
  updatedBy: "human:laptop",
  version: 1,
  ...over,
});

const names = (m: string, p: string) => (m === "devbox" && p === "shop" ? "Shop" : undefined);

describe("cards", () => {
  it("checks a number by Luhn and tells its brand as the hub does", () => {
    expect(luhn("4242424242424242")).toBe(true);
    expect(luhn("4242424242424241")).toBe(false);
    expect(luhn("42")).toBe(false);
    expect([brandOf("4242"), brandOf("5555"), brandOf("2223"), brandOf("3782"), brandOf("6011"), brandOf("9999")]).toEqual(["visa", "mastercard", "mastercard", "amex", "discover", undefined]);
    expect(groupNumber("4242424242424242")).toBe("4242 4242 4242 4242");
    expect(groupNumber("378282246310005")).toBe("3782 822463 10005");
  });

  it("reads an expiry as MM/YY or MM/YYYY into a four-digit year", () => {
    expect(parseExpiry("04/28")).toEqual({ month: "04", year: "2028" });
    expect(parseExpiry("0428")).toEqual({ month: "04", year: "2028" });
    expect(parseExpiry("4/2029")).toEqual({ month: "04", year: "2029" });
    expect(parseExpiry("13/28")).toBeUndefined();
    expect(parseExpiry("soon")).toBeUndefined();
  });

  it("refuses a wrong number, an expired card and a short code, and names a new card by brand and last four", () => {
    const d = (fields: Record<string, string>) => ({ ...emptyDraft("card"), fields });
    expect(check(d({ number: "4242 4242 4242 4241", expiry: "04/28", cvc: "123" }), false, NOW)).toEqual({ ok: false, problem: "That card number doesn't look right." });
    expect(check(d({ number: "4242424242424242", expiry: "01/26", cvc: "123" }), false, NOW)).toEqual({ ok: false, problem: "That card has expired." });
    expect(check(d({ number: "378282246310005", expiry: "04/28", cvc: "123" }), false, NOW)).toMatchObject({ ok: false });
    expect(check(d({ number: "4242-4242-4242-4242", expiry: "04/28", cvc: "123", name: "Sam" }), false, NOW)).toEqual({
      ok: true,
      value: { fields: { number: "4242424242424242", month: "04", year: "2028", cvc: "123", name: "Sam" }, label: "Visa ••4242", sites: [] },
    });
  });

  it("on an edit sends only what was typed, so the stored number stays unseen and unchanged", () => {
    const edit = { ...draftOf(item({ kind: "card", label: "Visa (Personal)", meta: { source: { kind: "typed" }, brand: "visa", last4: "4242" } })), fields: { cvc: "999" } };
    expect(check(edit, true, NOW)).toEqual({ ok: true, value: { fields: { cvc: "999" }, label: "Visa (Personal)", sites: [] } });
  });
});

describe("logins, addresses and variables", () => {
  it("cuts a pasted address to its site, and refuses one with no dot", () => {
    expect(hostOf("https://www.Amazon.com/ap/signin?x=1")).toBe("amazon.com");
    expect(hostOf("user@shop.example.org:8443/path")).toBe("shop.example.org");
    expect(hostOf("localhost")).toBeUndefined();
    expect(sitesOf("amazon.com\nhttps://amazon.de, amazon.com\nnope")).toEqual({ sites: ["amazon.com", "amazon.de"], bad: ["nope"] });
  });

  it("needs a login's site, keeps its password exactly as typed, and names it after its site", () => {
    expect(check({ ...emptyDraft("login"), fields: { password: "x" } }, false, NOW)).toEqual({ ok: false, problem: "Add the website it signs in to." });
    expect(check({ ...emptyDraft("login"), sites: "https://github.com/login", fields: { username: " sam ", password: " p a ss " } }, false, NOW)).toEqual({
      ok: true,
      value: { fields: { username: "sam", password: " p a ss " }, label: "github.com", sites: ["github.com"] },
    });
  });

  it("takes an address's country as two letters and needs its street and city", () => {
    expect(check({ ...emptyDraft("address"), fields: { line1: "Main St 1", city: "Berlin", country: "Germany" } }, false, NOW)).toMatchObject({ ok: false });
    expect(check({ ...emptyDraft("address"), fields: { line1: "Main St 1", city: "Berlin", country: "de" } }, false, NOW)).toEqual({
      ok: true,
      value: { fields: { line1: "Main St 1", city: "Berlin", country: "DE" }, label: "Home", sites: [] },
    });
  });

  it("checks a variable's name by the hub's rules, and keeps a secret's value as it is", () => {
    expect(check({ ...emptyDraft("env"), envName: "PATH", fields: { value: "x" } }, false, NOW)).toMatchObject({ ok: false });
    expect(check({ ...emptyDraft("env"), envName: "1X", fields: { value: "x" } }, false, NOW)).toMatchObject({ ok: false });
    expect(check({ ...emptyDraft("env"), envName: "STRIPE_KEY", fields: {} }, false, NOW)).toEqual({ ok: false, problem: "Type or paste the value." });
    expect(check({ ...emptyDraft("env"), envName: "STRIPE_KEY", fields: { value: " sk_\n" } }, false, NOW)).toEqual({
      ok: true,
      value: { fields: { value: " sk_\n" }, label: "STRIPE_KEY", sites: [], envName: "STRIPE_KEY", secret: true },
    });
    // An edit of a secret left empty keeps it; the name can't change.
    expect(check({ ...emptyDraft("env"), envName: "STRIPE_KEY", fields: {} }, true, NOW)).toEqual({ ok: true, value: { fields: {}, label: "STRIPE_KEY", sites: [], secret: true } });
  });

  it("clears a field on an edit only when asked, as \"\", and never a card's number or an address's street", () => {
    const login = { ...draftOf(item({})), cleared: ["totp", "notes"], fields: { password: "new" } };
    expect(check(login, true, NOW)).toEqual({ ok: true, value: { fields: { password: "new", totp: "", notes: "" }, label: "Amazon", sites: ["amazon.com"] } });
    // Left empty without Clear: unchanged, so not sent at all.
    expect(check({ ...draftOf(item({})), fields: {} }, true, NOW)).toEqual({ ok: true, value: { fields: {}, label: "Amazon", sites: ["amazon.com"] } });
    const address = { ...draftOf(item({ kind: "address", label: "Home", meta: { source: { kind: "typed" }, country: "DE" } })), cleared: ["line2", "line1", "country"] };
    expect(check(address, true, NOW)).toEqual({ ok: true, value: { fields: { line2: "" }, label: "Home", sites: [] } });
    const card = { ...draftOf(item({ kind: "card", label: "Visa", meta: { source: { kind: "typed" }, brand: "visa", last4: "4242" } })), cleared: ["number", "cvc"] };
    expect(check(card, true, NOW)).toEqual({ ok: true, value: { fields: { cvc: "" }, label: "Visa", sites: [] } });
  });

  it("keeps a secret variable's value when an edit makes it plain without a new one, and sends an emptied plain one", () => {
    const secret = item({ kind: "env", label: "KEY", envName: "KEY", meta: { source: { kind: "typed" }, secret: true } });
    expect(check({ ...draftOf(secret), secret: false }, true, NOW)).toEqual({ ok: true, value: { fields: {}, label: "KEY", sites: [], secret: false } });
    expect(check({ ...draftOf(secret), secret: false, fields: { value: "v2" } }, true, NOW)).toEqual({ ok: true, value: { fields: { value: "v2" }, label: "KEY", sites: [], secret: false } });
    const plain = item({ kind: "env", label: "REGION", envName: "REGION", value: "eu", meta: { source: { kind: "typed" }, secret: false } });
    expect(check({ ...draftOf(plain), fields: { value: "" } }, true, NOW)).toEqual({ ok: true, value: { fields: { value: "" }, label: "REGION", sites: [], secret: false } });
    // A new plain variable may be empty.
    expect(check({ ...emptyDraft("env"), envName: "EMPTY", secret: false }, false, NOW)).toEqual({ ok: true, value: { fields: { value: "" }, label: "EMPTY", sites: [], envName: "EMPTY", secret: false } });
  });

  it("keeps a name within the hub's 120 characters", () => {
    expect(check({ ...emptyDraft("login"), label: "x".repeat(121), sites: "a.com", fields: { password: "p" } }, false, NOW)).toEqual({ ok: false, problem: "A name is up to 120 characters." });
    expect(check({ ...emptyDraft("login"), label: "x".repeat(120), sites: "a.com", fields: { password: "p" } }, false, NOW)).toMatchObject({ ok: true });
    expect(check({ ...emptyDraft("env"), envName: `K${"x".repeat(120)}`, fields: { value: "v" } }, false, NOW)).toMatchObject({ ok: false });
  });

  it("opens a plain variable's form with its value, a secret's empty", () => {
    expect(draftOf(item({ kind: "env", envName: "REGION", label: "REGION", value: "eu", meta: { source: { kind: "typed" }, secret: false } })).fields).toEqual({ value: "eu" });
    expect(draftOf(item({ kind: "env", envName: "KEY", label: "KEY", meta: { source: { kind: "typed" }, secret: true } })).fields).toEqual({});
  });
});

describe("rows", () => {
  it("says each kind in one quiet line from its metadata alone", () => {
    expect(rowLine(item({}))).toBe("amazon.com");
    expect(rowLine(item({ meta: { source: { kind: "typed" }, sites: ["a.com", "b.com", "c.com"] } }))).toBe("a.com +2");
    expect(rowLine(item({ kind: "card", meta: { source: { kind: "typed" }, brand: "visa", last4: "4242" } }))).toBe("Visa ••4242");
    expect(rowLine(item({ kind: "address", meta: { source: { kind: "typed" }, country: "DE" } }))).toMatch(/Germany|DE/u);
    expect(rowLine(item({ kind: "env", meta: { source: { kind: "typed" }, secret: true } }))).toBe("Secret");
    expect(rowLine(item({ kind: "env", value: "eu-west", meta: { source: { kind: "typed" }, secret: false } }))).toBe("eu-west");
  });

  it("tags an item that isn't only yours: Everyone for the hub's, the project's name, its order, and what it's shared with", () => {
    expect(scopeTag(item({}), names)).toBeUndefined();
    expect(scopeTag(item({ scope: "hub" }), names)).toBe("Everyone");
    expect(scopeTag(item({ scope: "project", machineId: "devbox", projectId: "shop" }), names)).toBe("Shop");
    expect(scopeTag(item({ scope: "order", machineId: "devbox", projectId: "shop", workstreamId: "W12" }), names)).toBe("Shop · W12");
    expect(scopeTag(item({ sharedWith: [{ machineId: "devbox", projectId: "shop" }] }), names)).toBe("Shop");
    expect(scopeTag(item({ sharedWith: [{ machineId: "devbox", projectId: "shop" }, { machineId: "devbox", projectId: "b" }] }), names)).toBe("2 projects");
  });

  it("names a request_secret sink's variable by its label, never the hub's internal sink: name", () => {
    const sink = item({
      kind: "env",
      label: "stripe.test_key",
      envName: "sink:env:stripe.test_key:/srv/app/.env",
      meta: { source: { kind: "adopted", from: "devbox" }, secret: true, sink: { kind: "env", machineId: "devbox", path: "/srv/app/.env", envName: "STRIPE_KEY", secretKey: "stripe.test_key" } },
    });
    expect(titleOf(sink)).toBe("stripe.test_key");
    expect(draftOf(sink).envName).toBe("stripe.test_key");
    expect(shownItems([sink], "all", "sink:")).toEqual([]);
    expect(titleOf(item({ kind: "env", label: "KEY", envName: "KEY", meta: { source: { kind: "typed" }, secret: true } }))).toBe("KEY");
  });

  it("lists by kind then title, narrowed by the filter and the search", () => {
    const list = [
      item({ itemId: "V1", label: "Zeta" }),
      item({ itemId: "V2", kind: "env", label: "API_KEY", envName: "API_KEY", meta: { source: { kind: "typed" }, secret: true } }),
      item({ itemId: "V3", label: "Alpha", meta: { source: { kind: "typed" }, sites: ["alpha.io"] } }),
    ];
    expect(shownItems(list, "all", "").map((i) => i.itemId)).toEqual(["V3", "V1", "V2"]);
    expect(shownItems(list, "env", "").map((i) => i.itemId)).toEqual(["V2"]);
    expect(shownItems(list, "all", "alpha.io").map((i) => i.itemId)).toEqual(["V3"]);
  });

  it("puts each item on its page: yours and the hub's, a project's own and its orders', the hub's own", () => {
    const scopes = ["person", "project", "order", "hub"] as const;
    const on = (whose: Parameters<typeof onPage>[0]) => scopes.filter((scope) => onPage(whose, { scope }));
    expect(on({ kind: "mine" })).toEqual(["person", "hub"]);
    expect(on({ kind: "project", machineId: "devbox", projectId: "shop" })).toEqual(["project", "order"]);
    expect(on({ kind: "hub" })).toEqual(["hub"]);
    expect(listInput({ kind: "project", machineId: "devbox", projectId: "shop" }, true)).toEqual({ machineId: "devbox", projectId: "shop", trash: true });
    expect(listInput({ kind: "hub" })).toEqual({ scope: "hub" });
  });

  it("shows a card's revealed fields grouped and its expiry as MM/YY, and only the fields an item has", () => {
    expect(shownFields("card", { number: "4242424242424242", month: "04", year: "2028", cvc: "123" })).toEqual({ number: "4242 4242 4242 4242", expiry: "04/28", cvc: "123" });
    expect(presentFields(item({})).map((f) => f.key)).toEqual(["username", "password"]);
  });

  it("shows Vault only on a hub that serves it", () => {
    expect(vaultServed(["artifacts"])).toBe(false);
    expect(vaultServed(["artifacts", "vault"])).toBe(true);
  });
});

describe("activity and errors", () => {
  const entry = (over: Partial<VaultAuditEntry>): VaultAuditEntry => ({ n: 1, atMs: 0, action: "fill", outcome: "ok", data: {}, ...over });

  it("says a use in words, where and by whom, and why a refusal was refused, never a value", () => {
    expect(auditLine(entry({ data: { site: "amazon.com", fields: ["password"] }, machineId: "devbox", projectId: "shop", taskId: "T7" }), names)).toEqual({
      title: "Filled",
      detail: "amazon.com · password · Shop · T7",
    });
    expect(auditLine(entry({ action: "fill_refused", outcome: "refused", data: { site: "amaz0n.com", message: "not one of its sites" } }), names)).toEqual({
      title: "Fill refused",
      detail: "amaz0n.com · not one of its sites",
    });
    expect(auditLine(entry({ action: "reveal", data: { by: "human:laptop" } }), names)).toEqual({ title: "Shown", detail: "laptop" });
  });

  it("says how an import card went, and the vault's own refusals in the person's words", () => {
    expect(importOutcome({ state: "open" })).toBeUndefined();
    expect(importOutcome({ state: "dismissed" })).toBe("Not imported");
    expect(importOutcome({ state: "imported", imported: 1 })).toBe("Imported 1 item into your vault");
    expect(vaultErrorWords({ reason: "vault_locked" })).toMatch(/locked/u);
    expect(vaultErrorWords({ reason: "other" })).toBeUndefined();
  });
});
