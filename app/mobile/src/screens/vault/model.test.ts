import { describe, expect, it } from "vitest";
import { auditLine, brandOf, check, copyText, cvcOk, emptyDraft, envNameProblem, expired, groupNumber, hostOf, luhn, importOutcome, parseDotenv, parseExpiry, presentFields, rowLine, scopeTag, sections, shownFields, sitesOf, typeExpiry, utf8Bytes, vaultShown, type Draft } from "./model";
import type { VaultItemSummary } from "./types";

const NOW = new Date("2026-11-09T12:00:00Z");

const item = (over: Partial<VaultItemSummary>): VaultItemSummary => ({
  itemId: "V1",
  kind: "login",
  scope: "person",
  label: "Shop",
  meta: {},
  createdMs: 0,
  updatedMs: 0,
  canEdit: true,
  canReveal: true,
  ...over,
});

const draft = (kind: Draft["kind"], over: Partial<Draft> = {}, fields: Record<string, string> = {}): Draft => ({ ...emptyDraft(kind), ...over, fields });

describe("a card's number", () => {
  it("passes Luhn only when it is one", () => {
    expect(luhn("4242424242424242")).toBe(true);
    expect(luhn("4242424242424241")).toBe(false);
    expect(luhn("378282246310005")).toBe(true);
    expect(luhn("1234")).toBe(false);
    expect(luhn("4242 4242 4242 4242")).toBe(false);
  });

  it("tells the brand from its first digits", () => {
    expect(brandOf("4242")).toBe("Visa");
    expect(brandOf("5555 5555")).toBe("Mastercard");
    expect(brandOf("2223003122003222")).toBe("Mastercard");
    expect(brandOf("3782")).toBe("Amex");
    expect(brandOf("6011")).toBe("Discover");
    expect(brandOf("3530")).toBe("JCB");
    expect(brandOf("")).toBeUndefined();
    expect(brandOf("9")).toBeUndefined();
  });

  it("is grouped as it's printed, Amex 4-6-5", () => {
    expect(groupNumber("4242424242424242")).toBe("4242 4242 4242 4242");
    expect(groupNumber("378282246310005")).toBe("3782 822463 10005");
    expect(groupNumber("42-42")).toBe("4242");
  });

  it("takes a 3 or 4 digit code, 4 for Amex", () => {
    expect(cvcOk("123", "Visa")).toBe(true);
    expect(cvcOk("123", "Amex")).toBe(false);
    expect(cvcOk("1234", "Amex")).toBe(true);
    expect(cvcOk("12", undefined)).toBe(false);
  });
});

describe("a card's expiry", () => {
  it("reads MM/YY in the ways people type it", () => {
    expect(parseExpiry("04/28")).toEqual({ month: "04", year: "28" });
    expect(parseExpiry("0428")).toEqual({ month: "04", year: "28" });
    expect(parseExpiry("4/2028")).toEqual({ month: "04", year: "28" });
    expect(parseExpiry("13/28")).toBeUndefined();
    expect(parseExpiry("04")).toBeUndefined();
  });

  it("puts the slash in while it's typed, and a backspace over it takes the month's digit", () => {
    expect(typeExpiry("0", "")).toBe("0");
    expect(typeExpiry("4", "")).toBe("04/");
    expect(typeExpiry("04", "0")).toBe("04/");
    expect(typeExpiry("04/2", "04/")).toBe("04/2");
    expect(typeExpiry("04", "04/")).toBe("0");
  });

  it("runs out after its month", () => {
    expect(expired("11", "26", NOW)).toBe(false);
    expect(expired("10", "26", NOW)).toBe(true);
    expect(expired("01", "25", NOW)).toBe(true);
  });
});

describe("a site", () => {
  it("is cut to its host from a pasted address", () => {
    expect(hostOf("https://www.Amazon.com/ap/signin?x=1")).toBe("amazon.com");
    expect(hostOf("user@login.example.org:8443/x")).toBe("login.example.org");
    expect(hostOf("github.com")).toBe("github.com");
    expect(hostOf("localhost")).toBeUndefined();
    expect(hostOf("not a site")).toBeUndefined();
    expect(hostOf("")).toBeUndefined();
  });

  it("takes several, each once, and names the ones that aren't", () => {
    expect(sitesOf("amazon.com, https://amazon.com/x\nnope\namazon.de")).toEqual({ sites: ["amazon.com", "amazon.de"], bad: ["nope"] });
  });
});

describe("a variable", () => {
  it("has a name by the hub's rule, and none fleetd sets itself", () => {
    expect(envNameProblem("STRIPE_KEY")).toBeUndefined();
    expect(envNameProblem("")).toBeUndefined();
    expect(envNameProblem("1KEY")).toMatch(/Letters/u);
    expect(envNameProblem("A-B")).toMatch(/Letters/u);
    expect(envNameProblem("PATH")).toBe("fleetd sets PATH itself.");
    expect(envNameProblem("FLEETD_X")).toBe("fleetd sets FLEETD_X itself.");
    expect(envNameProblem("CLAUDE_CODE")).toMatch(/itself/u);
  });

  it("counts UTF-8 bytes without TextEncoder", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("€")).toBe(3);
    expect(utf8Bytes("😀")).toBe(4);
  });

  it("reads a pasted .env", () => {
    const text = '# keys\nexport A=1\nB="two words"\n\nC=\'x\'\nbad line\nPATH=/x\nA=3\n';
    expect(parseDotenv(text)).toEqual({
      vars: [
        { name: "B", value: "two words" },
        { name: "C", value: "x" },
        { name: "A", value: "3" },
      ],
      bad: 2,
    });
  });
});

describe("a row's line", () => {
  it("says the one thing that tells items apart", () => {
    expect(rowLine(item({ kind: "login", meta: { sites: ["amazon.com"] } }))).toBe("amazon.com");
    expect(rowLine(item({ kind: "login", meta: { sites: ["amazon.com", "amazon.de", "a.co"] } }))).toBe("amazon.com +2");
    expect(rowLine(item({ kind: "login", meta: {} }))).toBe("No site");
    expect(rowLine(item({ kind: "card", meta: { brand: "Visa", last4: "4242" } }))).toBe("Visa ••4242");
    expect(rowLine(item({ kind: "address", meta: { city: "Berlin", country: "DE" } }))).toBe("Berlin, DE");
    expect(rowLine(item({ kind: "env", envName: "K", meta: { secret: true } }))).toBe("Secret");
    expect(rowLine(item({ kind: "env", envName: "K", meta: { secret: false } }))).toBe("Plain");
  });

  it("tags where an item is used when it isn't only the person's work", () => {
    const name = (m: string, p: string) => (p === "p1" ? "Nova" : undefined);
    expect(scopeTag(item({ scope: "person" }), name)).toBeUndefined();
    expect(scopeTag(item({ scope: "hub" }), name)).toBe("Everyone");
    expect(scopeTag(item({ scope: "project", machineId: "devbox", projectId: "p1" }), name)).toBe("Nova");
    expect(scopeTag(item({ scope: "person", sharedWith: [{ machineId: "devbox", projectId: "p1" }] }), name)).toBe("Nova");
    expect(scopeTag(item({ scope: "person", sharedWith: [{ machineId: "devbox", projectId: "p1" }, { machineId: "devbox", projectId: "p2" }] }), name)).toBe("2 projects");
  });
});

describe("the list", () => {
  const items = [
    item({ itemId: "a", kind: "login", label: "Zed", meta: { sites: ["zed.dev"] } }),
    item({ itemId: "b", kind: "login", label: "Amazon", meta: { sites: ["amazon.com"] } }),
    item({ itemId: "c", kind: "card", label: "Visa (Personal)", meta: { brand: "Visa", last4: "4242" } }),
    item({ itemId: "d", kind: "env", label: "STRIPE_KEY", envName: "STRIPE_KEY", meta: { secret: true } }),
    item({ itemId: "e", kind: "login", label: "Gone", deletedMs: 1 }),
  ];

  it("has a section per kind with items, sorted, without the trash", () => {
    expect(sections(items, "").map((s) => [s.header, s.items.map((i) => i.itemId)])).toEqual([
      ["Logins", ["b", "a"]],
      ["Cards", ["c"]],
      ["Variables", ["d"]],
    ]);
  });

  it("searches titles, lines and sites", () => {
    expect(sections(items, "4242").map((s) => s.items.map((i) => i.itemId))).toEqual([["c"]]);
    expect(sections(items, "AMAZON.COM").map((s) => s.items.map((i) => i.itemId))).toEqual([["b"]]);
    expect(sections(items, "stripe").map((s) => s.kind)).toEqual(["env"]);
    expect(sections(items, "nothing")).toEqual([]);
  });
});

describe("a form, checked", () => {
  it("takes a login's site from a pasted URL and names it by its host", () => {
    const r = check(draft("login", { sites: "https://www.amazon.com/ap" }, { username: " me@x.com ", password: " p w " }), false, NOW);
    expect(r).toEqual({ ok: true, value: { secret: { username: "me@x.com", password: " p w " }, label: "amazon.com", sites: ["amazon.com"] } });
  });

  it("refuses a login with no site or nothing to sign in with", () => {
    expect(check(draft("login", {}, { password: "x" }), false, NOW)).toEqual({ ok: false, problem: "Add the website it signs in to." });
    expect(check(draft("login", { sites: "x.com" }), false, NOW)).toEqual({ ok: false, problem: "Add a user name or a password." });
    expect(check(draft("login", { sites: "nope" }, { password: "x" }), false, NOW)).toEqual({ ok: false, problem: "nope isn't a website." });
  });

  it("checks a card and splits its expiry", () => {
    const ok = check(draft("card", {}, { number: "4242 4242 4242 4242", expiry: "04/28", cvc: "123", name: "A Person" }), false, NOW);
    expect(ok).toEqual({ ok: true, value: { secret: { number: "4242424242424242", month: "04", year: "28", cvc: "123", name: "A Person" }, label: "Visa ••4242", sites: [] } });
    expect(check(draft("card", {}, { number: "4242 4242 4242 4241", expiry: "04/28", cvc: "123" }), false, NOW)).toMatchObject({ ok: false });
    expect(check(draft("card", {}, { number: "4242424242424242", expiry: "01/25", cvc: "123" }), false, NOW)).toEqual({ ok: false, problem: "That card has expired." });
    expect(check(draft("card", {}, { number: "378282246310005", expiry: "04/28", cvc: "123" }), false, NOW)).toMatchObject({ ok: false, problem: expect.stringMatching(/security code/u) });
  });

  it("sends only the fields typed on an edit, so the rest stay as they are", () => {
    expect(check(draft("card", { label: "Work" }, { cvc: "999" }), true, NOW)).toEqual({ ok: true, value: { secret: { cvc: "999" }, label: "Work", sites: [] } });
    expect(check(draft("login", { label: "Amazon" }), true, NOW)).toEqual({ ok: true, value: { secret: {}, label: "Amazon", sites: [] } });
    expect(check(draft("env", { envName: "K" }), true, NOW)).toEqual({ ok: true, value: { secret: {}, label: "K", sites: [], envName: "K", secretEnv: true } });
  });

  it("needs an address's street, city and country, the country as its code", () => {
    expect(check(draft("address", {}, { line1: "Main St 1", city: "Berlin", country: "de" }), false, NOW)).toEqual({
      ok: true,
      value: { secret: { line1: "Main St 1", city: "Berlin", country: "DE" }, label: "Home", sites: [] },
    });
    expect(check(draft("address", {}, { line1: "x", city: "y", country: "Germany" }), false, NOW)).toMatchObject({ ok: false, problem: expect.stringMatching(/two-letter/u) });
    expect(check(draft("address", {}, { line1: "x" }), false, NOW)).toEqual({ ok: false, problem: "Add the street, city and country." });
  });

  it("checks a variable's name and keeps its value exactly", () => {
    expect(check(draft("env", { envName: "API_KEY", secret: false }, { value: " v " }), false, NOW)).toEqual({ ok: true, value: { secret: { value: " v " }, label: "API_KEY", sites: [], envName: "API_KEY", secretEnv: false } });
    expect(check(draft("env", { envName: "HOME" }, { value: "x" }), false, NOW)).toEqual({ ok: false, problem: "fleetd sets HOME itself." });
    expect(check(draft("env", { envName: "K" }), false, NOW)).toEqual({ ok: false, problem: "Give it a value." });
    expect(check(draft("env", { envName: "K" }, { value: "a\u0000b" }), false, NOW)).toMatchObject({ ok: false });
  });
});

describe("revealed fields", () => {
  it("show a card's number grouped and its expiry as MM/YY, and copy the number bare", () => {
    expect(shownFields("card", { number: "4242424242424242", month: "04", year: "28", cvc: "123" })).toEqual({ number: "4242 4242 4242 4242", expiry: "04/28", cvc: "123" });
    expect(copyText("number", "4242 4242 4242 4242")).toBe("4242424242424242");
    expect(copyText("password", " a b ")).toBe(" a b ");
  });

  it("are the ones the item has, when the hub says which", () => {
    expect(presentFields(item({ kind: "login", meta: { fields: ["username", "password"] } })).map((f) => f.key)).toEqual(["username", "password"]);
    expect(presentFields(item({ kind: "card", meta: { fields: ["number", "month", "year"] } })).map((f) => f.key)).toEqual(["number", "expiry"]);
    expect(presentFields(item({ kind: "env", meta: {} })).map((f) => f.key)).toEqual(["value"]);
  });
});

describe("activity", () => {
  const name = (m: string, p: string) => (p === "p1" ? "Nova" : undefined);
  const entry = { n: 1, atMs: 0, itemId: "V1", outcome: "ok", data: {} };

  it("says what happened, where and for which project, never a value", () => {
    expect(auditLine({ ...entry, action: "fill", machineId: "devbox", projectId: "p1", data: { site: "amazon.com", field: "password" } }, name)).toEqual({ title: "Filled", detail: "amazon.com · Nova" });
    expect(auditLine({ ...entry, action: "reveal", data: {} }, name)).toEqual({ title: "Shown", detail: undefined });
    expect(auditLine({ ...entry, action: "fill_refused", outcome: "refused", data: { site: "amaz0n.com", reason: "off_site" } }, name)).toEqual({ title: "Fill refused", detail: "amaz0n.com · Off site" });
    expect(auditLine({ ...entry, action: "some_new_thing" }, name).title).toBe("Some new thing");
  });

  it("leaves one line once an import proposal is answered", () => {
    expect(importOutcome({ state: "open" })).toBeUndefined();
    expect(importOutcome({ state: "dismissed" })).toBe("Not imported");
    expect(importOutcome({ state: "imported", imported: 1 })).toBe("Imported 1 item into your vault");
    expect(importOutcome({ state: "imported", imported: 3 })).toBe("Imported 3 items into your vault");
  });

  it("shows the Vault only on a hub that has one", () => {
    const live = { phase: "live", hub: "http://devbox:4790", protocol: 1 } as const;
    expect(vaultShown({ ...live, features: ["vault"] })).toBe(true);
    expect(vaultShown({ ...live, features: [] })).toBe(false);
    expect(vaultShown({ phase: "connecting", hub: "http://devbox:4790", attempt: 1 })).toBe(false);
  });
});
