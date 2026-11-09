// Fills from fleetd's vault (vault-design §4; browser/vault.ts, credentials.ts, cards.ts, address.ts), with a fake hub
// that seals each value to the node's box key as the hub's vault does, and a real headless Chrome: a login fills on its
// own site only, a card from a purchase claim's `sealedCard` in the payment provider's frame only, an address into the
// page's own form by its autocomplete tokens, and a planted value never shows up in what the agent hears, the
// recording, what the node sends the hub, or its logs. Never a real vault or a real card.
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { ToolError } from "../src/shared/errors.ts";
import { seal } from "../src/shared/sealed_box.ts";
import { addressValue } from "../src/node/browser/address.ts";
import { refField } from "../src/node/browser/credentials.ts";
import { maskName, notInVault, onSite } from "../src/node/browser/vault.ts";
import { chrome, driver, eventually, fakeVault, forms, formValue, type Rig, rig, THREAD, uploaded } from "./browser_rig.ts";

// Each test drives a real Chrome and waits for its recording: past bun's 5 s default on a loaded machine.
setDefaultTimeout(30_000);
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** The planted values: with the characters a form body, HTML and JSON each encode their own way, and none a page, a
 * Chrome id or a timestamp makes by chance (so the security code and postal code aren't plain digits). */
const USER = "grace@shop.devbox.test";
const PASSWORD = 'Vault-Pw+/ &q<7"';
const CARD = { number: "4000056655665556", month: "07", year: "2031", cvc: "cvc-8Rw2Lp6", name: "Grace Devbox" };
const ADDRESS = { name: "Grace Devbox", line1: "12 Canary Lane", line2: "Flat 3b", city: "Springfield", region: "OR", postalCode: "SW1Z 9QX", country: "US", phone: "+1 541 555 0199", email: "grace@mail.devbox.test" };
const PLANTED = [USER, PASSWORD, CARD.number, "4000 0566 5566 5556", CARD.cvc, ADDRESS.line1, ADDRESS.line2, ADDRESS.postalCode, ADDRESS.phone, ADDRESS.email];

/** Fails, naming where, if any planted value is in `text` in any form. */
function expectClean(what: string, text: string): void {
  for (const value of PLANTED) for (const form of forms(value)) if (form.length >= 4 && text.includes(form)) throw new Error(`${what} holds ${JSON.stringify(form)}: ${text.slice(0, 1500)}`);
}

/** The ended session's recording as the hub got it, once its action log and DOM trace are both up. */
async function recording(r: Rig, id: string): Promise<{ actions: string; dom: string }> {
  await eventually(() => r.link.calls.some((c) => c.op === "browser_session" && c.args.state === "recorded"));
  await eventually(() => uploaded(r.link, id).length > 0 && uploaded(r.link, id, "dom").length > 0, 20_000).catch(() => {});
  return { actions: uploaded(r.link, id), dom: uploaded(r.link, id, "dom") };
}

/** Everything the node printed while `fn` ran. */
function captureLogs(): { text: () => string } {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const spy = spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    cleanups.push(() => spy.mockRestore());
  }
  return { text: () => lines.join("\n") };
}

test("an item's site is its host or a subdomain, never a look-alike or a shared host's neighbour; a reference names its field", () => {
  expect(onSite("www.shop.example.test", "shop.example.test")).toBe(true);
  expect(onSite("shop.example.test", "https://shop.example.test/login")).toBe(true);
  expect(onSite("shop.example.test.evil.test", "shop.example.test")).toBe(false);
  expect(onSite("evilshop.example.test", "shop.example.test")).toBe(false);
  expect(onSite("localhost", "localhost")).toBe(false);
  expect(onSite("me.github.io", "me.github.io")).toBe(true);
  expect(onSite("x.me.github.io", "me.github.io")).toBe(false);
  expect(onSite("other.github.io", "github.io")).toBe(false);
  expect(refField("op://Team/Shop/password")).toBe("password");
  expect(refField("op://Team/Shop/one-time password?attribute=otp")).toBe("otp");
  expect(refField("op://Team/Shop/api key")).toBeUndefined();
  expect(maskName("Shop", "password")).toBe("vault:Shop/password");
  expect(notInVault(new ToolError("not_found", "op://Team/Shop isn't in fleetd's vault yet.", undefined, "vault_not_imported"))).toBe(true);
  expect(notInVault(new ToolError("forbidden", "Shop is for shop.example.test, not 127.0.0.1."))).toBe(false);
  expect(addressValue("given", ADDRESS)).toBe("Grace");
  expect(addressValue("family", ADDRESS)).toBe("Devbox");
  expect(addressValue("street", ADDRESS)).toBe("12 Canary Lane\nFlat 3b");
});

type Item = { itemId: string; label: string; kind: "login" | "address"; sites: string[]; fields: Record<string, string> };

/** A fake hub's vault: `vault_fill` sealed to the node's box key for items on the page's site (or, `lenient`, for any
 * page: a hub the node mustn't trust blindly), `vault_filled` kept, `vault_items` listed. */
function fakeHub(r: Rig, items: Item[], opts: { lenient?: boolean } = {}) {
  const filled: Record<string, unknown>[] = [];
  const asked: Record<string, unknown>[] = [];
  let audit = 0;
  const to = () => Buffer.from(r.broker.boxKey().publicKey(), "base64");
  r.answers.set("vault_fill", (args) => {
    asked.push(args);
    const named = args.ref !== undefined ? items.find((i) => i.fields.ref === String(args.ref).split("/").slice(0, 4).join("/")) : items.find((i) => i.itemId === args.item || i.label === args.item);
    if (!named) {
      if (args.ref !== undefined) throw new ToolError("not_found", `${String(args.ref)} isn't in fleetd's vault yet.`, "Find it with vault_import_search.", "vault_not_imported");
      throw new ToolError("not_found", `No vault item ${String(args.item)} this session may use.`);
    }
    const host = new URL(String(args.page)).hostname;
    if (!opts.lenient && !named.sites.some((s) => onSite(host, s))) throw new ToolError("forbidden", `${named.label} is for ${named.sites.join(", ")}, not ${host}.`);
    const plain = args.field === "address" ? { ...named.fields, sites: named.sites } : { value: named.fields[String(args.field)], sites: named.sites };
    audit += 1;
    return { itemId: named.itemId, label: named.label, auditId: audit, sealed: Buffer.from(seal(to(), new TextEncoder().encode(JSON.stringify(plain)))).toString("base64") };
  });
  r.answers.set("vault_filled", (args) => (filled.push(args), { auditId: args.auditId }));
  r.answers.set("vault_items", (args) => ({ items: items.filter((i) => args.kind === undefined || i.kind === args.kind).map((i) => ({ itemId: i.itemId, kind: i.kind, label: i.label })) }));
  const sealedCard = () => Buffer.from(seal(to(), new TextEncoder().encode(JSON.stringify(CARD)))).toString("base64");
  return { filled, asked, sealedCard };
}

/** The shop on 127.0.0.1: a sign-in form, a page that greets the user (and echoes them), a checkout whose card fields
 * are in a payment provider's frame on localhost, and a shipping form whose fields say what they take only by their
 * autocomplete tokens, beside a billing one. Each POST body is kept. */
function shop() {
  const bodies: string[] = [];
  const charges: Record<string, unknown>[] = [];
  let port = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const path = new URL(req.url).pathname;
      const html = (page: string) => new Response(page, { headers: { "content-type": "text/html" } });
      if (path === "/charge") {
        charges.push(JSON.parse(await req.text()));
        return Response.json({ charged: true });
      }
      if (req.method === "POST") {
        const body = await req.text();
        bodies.push(body);
        if (path === "/login") return html(`<html><head><title>Welcome</title></head><body><h1>Welcome ${formValue(body, "user")}</h1></body></html>`);
        if (path === "/ship") return html(`<html><head><title>Shipped</title></head><body><p>Shipping to ${formValue(body, "a1")}, ${formValue(body, "zip")}</p></body></html>`);
        return html("<html><head><title>Done</title></head></html>");
      }
      if (path === "/card") {
        return html(`<html><body>
<input id=number autocomplete=cc-number><input id=exp autocomplete=cc-exp placeholder='MM / YY'><input id=cvc autocomplete=cc-csc>
<script>parent.postMessage({ ready: true }, '*');
addEventListener('message', async (e) => { if (!e.data || e.data.pay === undefined) return;
  const r = await fetch('/charge', { method: 'POST', body: JSON.stringify({ number: number.value, exp: exp.value, cvc: cvc.value }) });
  parent.postMessage(await r.json(), '*'); });</script></body></html>`);
      }
      if (path === "/checkout") {
        return html(`<html><head><title>Checkout</title></head><body><iframe id=card src='http://localhost:${port}/card'></iframe>
<button id=pay>Pay</button><script>
pay.onclick = () => card.contentWindow.postMessage({ pay: true }, '*');
addEventListener('message', (e) => { if (e.data && e.data.ready) document.title = 'Checkout ready'; if (e.data && e.data.charged) document.title = 'Paid'; });
</script></body></html>`);
      }
      if (path === "/address") {
        return html(`<html><head><title>Address</title></head><body>
<form id=billing method=post action=/bill><input name=b1 autocomplete="billing address-line1"><input name=bzip autocomplete="billing postal-code"></form>
<form id=shipping method=post action=/ship>
<input name=n autocomplete="shipping name"><input name=a1 autocomplete="shipping address-line1"><input name=a2 autocomplete="shipping address-line2">
<input name=c autocomplete="shipping address-level2"><input name=zip autocomplete="shipping postal-code">
<select name=country autocomplete="shipping country"><option value="">Pick</option><option value="DE">Germany</option><option value="US">United States</option></select>
<label>E-mail <input name=mail></label><label>Phone <input name=tel></label><button id=ship>Ship</button></form></body></html>`);
      }
      return html(`<html><head><title>Sign in</title></head><body><form method=post action=/login><input id=user name=user><input id=pw name=pw type=password><button>Sign in</button></form></body></html>`);
    },
  });
  port = server.port ?? 0;
  cleanups.push(() => void server.stop(true));
  return { site: `http://127.0.0.1:${port}`, bodies, charges };
}

const LOGIN: Item = { itemId: `V${"a".repeat(32)}`, label: "Shop", kind: "login", sites: ["127.0.0.1"], fields: { username: USER, password: PASSWORD, ref: "op://Team/Shop" } };
const HOME: Item = { itemId: `V${"b".repeat(32)}`, label: "Home", kind: "address", sites: [], fields: ADDRESS };

test.skipIf(!chrome)("a vault login fills on its own site from the hub's sealed value, and never reaches the agent, the recording, the hub or the logs", async () => {
  const logs = captureLogs();
  const r = await rig([]);
  cleanups.push(r.done);
  const { site, bodies } = shop();
  const hub = fakeHub(r, [LOGIN]);
  // 1Password is never asked for a vault item.
  const op = fakeVault({}, []);
  r.broker.credentials.vaultFor = op.vaultFor;
  const started = await r.call("session_start", { purpose: "Sign in to the shop" });
  const d = await driver(String(started.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Page.navigate", { url: site }, page);
  await d.until(page, "document.title", "Sign in");

  const user = await r.call("fill_credential", { item: "Shop", field: "username", target: "#user", submit: false });
  expect(user.error).toBeUndefined();
  expect(String(user.result!.message)).toStartWith("Filled #user from the vault's Shop (username).");
  const password = await r.call("fill_credential", { item: "Shop", field: "password", target: "#pw" });
  expect(String(password.result!.message)).toContain("and submitted its form");
  await d.until(page, "document.title", "Welcome");
  expect(formValue(bodies[0]!, "user")).toBe(USER);
  expect(formValue(bodies[0]!, "pw")).toBe(PASSWORD);
  expect(op.asked).toEqual([]);
  // The hub was asked in the session's name for this page, and told how each fill went.
  expect(hub.asked.map((a) => [a.sessionId, a.item, a.field])).toEqual([
    [started.result!.sessionId, "Shop", "username"],
    [started.result!.sessionId, "Shop", "password"],
  ]);
  expect(String(hub.asked[0]!.page)).toStartWith(site);
  expect(hub.filled).toEqual([
    { auditId: 1, ok: true, typed: true, message: "filled #user" },
    { auditId: 2, ok: true, typed: true, message: "filled #pw and submitted its form" },
  ]);
  const session = r.broker.live(THREAD)!;
  expect(session.sealed()).toBe(true);
  // The agent's next command records the page its submit loaded, in the DOM trace.
  r.broker.item(THREAD, {
    id: "i1",
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    kind: { type: "command", command: "agent-browser snapshot -i", output: "heading Welcome", exitCode: 0 },
  } as never);
  // The page greets the user: what the driver reads of it is scrubbed, as `***vault:Shop/username***`.
  const greeting = await d.send("Accessibility.getFullAXTree", {}, page);
  expect(JSON.stringify(greeting)).toContain("***vault:Shop/username***");
  const masked = r.broker.credentials.filledSince(THREAD, 0)!;
  expect(masked.map(([name]) => name)).toEqual(["vault:Shop/username", "vault:Shop/password"]);

  const ended = await r.call("session_end");
  const { actions, dom } = await recording(r, String(ended.result!.sessionId));
  expect(actions).toContain("fill_credential");
  expect(dom).toContain("***vault:Shop/username***");
  expectClean("what the agent heard", JSON.stringify([user, password, ended, d.got]));
  expectClean("the action log", actions);
  expectClean("the DOM trace", dom);
  // What the node sent the hub, the recording's pieces aside (checked above): never a value.
  expectClean("what the node sent the hub", JSON.stringify(r.link.calls.filter((c) => c.op !== "browser_recording_part")));
  expectClean("the node's log", logs.text());
});

test.skipIf(!chrome)("a fill on a wrong domain is refused, by the hub or by the node, and nothing is typed or sealed", async () => {
  const r = await rig([]);
  cleanups.push(r.done);
  const { site, bodies } = shop();
  const away: Item = { ...LOGIN, sites: ["shop.example.test"] };
  const hub = fakeHub(r, [away]);
  const opened = await r.call("session_start", { purpose: "Sign in" });
  const started = r.broker.live(THREAD)!;
  const d = await driver(String(opened.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Page.navigate", { url: site }, page);
  await d.until(page, "document.title", "Sign in");
  // The hub refuses: its word comes back, and nothing is sealed.
  const refused = await r.call("fill_credential", { item: "Shop", field: "password", target: "#pw" });
  expect(refused.error).toMatchObject({ code: "forbidden", message: "Shop is for shop.example.test, not 127.0.0.1." });
  expect(started.sealed()).toBe(false);
  // A hub that answered anyway (or a page that moved since): the node checks the page against the item's sites itself.
  const lenient = fakeHub(r, [away], { lenient: true });
  const offSite = await r.call("fill_credential", { item: "Shop", field: "password", target: "#pw" });
  expect(offSite.error).toMatchObject({ code: "forbidden" });
  expect(offSite.error!.message).toContain("is for shop.example.test; this page is on 127.0.0.1.");
  expect(lenient.filled).toEqual([{ auditId: 1, ok: false, typed: false, message: "refused: the page is on 127.0.0.1" }]);
  expect(started.sealed()).toBe(false);
  expect(started.credentialsFilled).toBe(0);
  expect(bodies).toEqual([]);
  expect(hub.filled).toEqual([]);
  // Neither names a value.
  expectClean("the refusals", JSON.stringify([refused, offSite]));
  // A wrong call is refused before the hub is asked.
  expect((await r.call("fill_credential", { item: "Shop", target: "#pw" })).error?.code).toBe("invalid");
  for (const call of [
    { item: "Shop", field: "pin", target: "#pw" },
    { field: "password", target: "#pw" },
    { target: "#pw" },
    { item: "Shop", field: "password", ref: "op://Team/Shop/password", target: "#pw" },
  ]) {
    expect((await r.call("fill_credential", call)).error?.code).toBe("invalid");
  }
});

test.skipIf(!chrome)("a 1Password reference fills the vault item imported from it, and reads 1Password only while the vault lacks it", async () => {
  const r = await rig();
  cleanups.push(r.done);
  const { site, bodies } = shop();
  const hub = fakeHub(r, [LOGIN]);
  const op = fakeVault({ "op://Team/Other/password": "from-1password-pw" }, [`${site}/`]);
  r.broker.credentials.vaultFor = op.vaultFor;
  const started = await r.call("session_start", { purpose: "Sign in" });
  const d = await driver(String(started.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Page.navigate", { url: site }, page);
  await d.until(page, "document.title", "Sign in");
  const imported = await r.call("fill_credential", { ref: "op://Team/Shop/password", target: "#pw", submit: false });
  expect(String(imported.result!.message)).toStartWith("Filled #pw from the vault's Shop (password)");
  expect(op.asked).toEqual([]);
  const fallback = await r.call("fill_credential", { ref: "op://Team/Other/password", target: "#pw", submit: false });
  expect(String(fallback.result!.message)).toStartWith("Filled #pw from op://Team/Other/password");
  expect(op.asked).toEqual(["op://Team/Other/password"]);
  expect(hub.asked.map((a) => a.ref)).toEqual(["op://Team/Shop/password", "op://Team/Other/password"]);
  expect(bodies).toEqual([]);
});

test.skipIf(!chrome)("a vault card fills from the claim's sealed card into the payment provider's frame only", async () => {
  const logs = captureLogs();
  const r = await rig([]);
  cleanups.push(r.done);
  const { site, charges } = shop();
  const hub = fakeHub(r, []);
  r.broker.extraPaymentFrames.push("localhost");
  const reported: Record<string, unknown>[] = [];
  r.answers.set("purchase_open", () => ({ requestId: "R1", state: "approved" }));
  r.answers.set("purchase_claim", (args) => ({ requestId: args.requestId, domain: "127.0.0.1", card: `vault:V${"c".repeat(32)}`, sealedCard: hub.sealedCard() }));
  r.answers.set("purchase_filled", (args) => (reported.push(args), { requestId: args.requestId, state: "done" }));
  r.broker.lead(THREAD, "assistant", "proj-1");
  const started = await r.call("session_start", { purpose: "Pay" });
  const d = await driver(String(started.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Page.navigate", { url: `${site}/checkout` }, page);
  await d.until(page, "document.title", "Checkout ready");
  const asked = await r.call("purchase_request", { shop: { domain: "127.0.0.1", name: "Devbox shop" }, total: { amount: "9.90", currency: "EUR" }, items: [{ name: "Socks", quantity: 1, amount: "9.90" }] });
  expect(asked.error).toBeUndefined();
  const filled = await r.call("purchase_fill", { requestId: "R1" });
  expect(filled.error).toBeUndefined();
  expect(String(filled.result!.message)).toStartWith("Filled the card's number, expiry, security code from the vault's card;");
  expect(reported).toEqual([{ requestId: "R1", ok: true, typed: true, message: "the card's number, expiry, security code" }]);
  await dr(d, page, "#pay");
  await d.until(page, "document.title", "Paid");
  expect(charges).toEqual([{ number: CARD.number, exp: "07/31", cvc: CARD.cvc }]);
  expect(r.broker.credentials.filledSince(THREAD, 0)!.some(([name]) => name === "vault:card/number")).toBe(true);
  const ended = await r.call("session_end");
  const { actions, dom } = await recording(r, String(ended.result!.sessionId));
  expectClean("what the agent heard", JSON.stringify([asked, filled, d.got]));
  expectClean("the action log", actions);
  expectClean("the DOM trace", dom);
  expectClean("what the node sent the hub", JSON.stringify(r.link.calls.filter((c) => c.op !== "browser_recording_part")));
  expectClean("the node's log", logs.text());
});

/** A click as agent-browser makes one, on `selector`'s centre. */
async function dr(d: Awaited<ReturnType<typeof driver>>, page: string, selector: string) {
  const root = (await d.ok("DOM.getDocument", { depth: 0 }, page)).root.nodeId;
  const node = (await d.ok("DOM.querySelectorAll", { nodeId: root, selector }, page)).nodeIds[0];
  const quad = (await d.ok("DOM.getBoxModel", { nodeId: node }, page)).model.content as number[];
  const [x, y] = [(quad[0]! + quad[4]!) / 2, (quad[1]! + quad[5]!) / 2];
  for (const type of ["mousePressed", "mouseReleased"]) await d.ok("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, page);
}

test.skipIf(!chrome)("an address fills the shipping form by its autocomplete tokens, never the billing one, and only where the hub allows it", async () => {
  const logs = captureLogs();
  const r = await rig([]);
  cleanups.push(r.done);
  const { site, bodies } = shop();
  const hub = fakeHub(r, [{ ...HOME, sites: ["127.0.0.1"] }]);
  const started = await r.call("session_start", { purpose: "Ship it" });
  const d = await driver(String(started.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Page.navigate", { url: `${site}/address` }, page);
  await d.until(page, "document.title", "Address");
  // No item named: the only address, as vault_items lists it.
  const filled = await r.call("fill_address", { part: "shipping" });
  expect(filled.error).toBeUndefined();
  expect(String(filled.result!.message)).toStartWith("Filled the address's name, street, city, postal code, country, phone, email from the vault's Home.");
  expect(hub.asked).toMatchObject([{ item: HOME.itemId, field: "address" }]);
  expect(hub.filled).toEqual([{ auditId: 1, ok: true, typed: true, message: "filled the name, street, city, postal code, country, phone, email" }]);
  await dr(d, page, "#ship");
  await d.until(page, "document.title", "Shipped");
  const body = bodies[0]!;
  expect([formValue(body, "n"), formValue(body, "a1"), formValue(body, "a2"), formValue(body, "c"), formValue(body, "zip"), formValue(body, "country")]).toEqual([
    ADDRESS.name,
    ADDRESS.line1,
    ADDRESS.line2,
    ADDRESS.city,
    ADDRESS.postalCode,
    "US",
  ]);
  expect([formValue(body, "mail"), formValue(body, "tel")]).toEqual([ADDRESS.email, ADDRESS.phone]);
  // The page echoes the street: scrubbed for the driver.
  const tree = JSON.stringify(await d.send("Accessibility.getFullAXTree", {}, page));
  expect(tree).toContain("***vault:Home/line1***");
  const ended = await r.call("session_end");
  const { actions, dom } = await recording(r, String(ended.result!.sessionId));
  expect(actions).toContain("fill_address");
  expectClean("what the agent heard", JSON.stringify([filled, ended, d.got, tree]));
  expectClean("the DOM trace", dom);
  expectClean("the action log", actions);
  expectClean("what the node sent the hub", JSON.stringify(r.link.calls.filter((c) => c.op !== "browser_recording_part")));
  expectClean("the node's log", logs.text());

  // Where the hub refuses (no checkout, not its sites, no login of its owner's there), nothing is typed.
  const r2 = await rig([]);
  cleanups.push(r2.done);
  fakeHub(r2, [HOME]);
  const s2 = await r2.call("session_start", { purpose: "Ship it" });
  const d2 = await driver(String(s2.result!.cdp));
  cleanups.push(d2.close);
  const p2 = await d2.page();
  await d2.ok("Page.navigate", { url: `${site}/address` }, p2);
  await d2.until(p2, "document.title", "Address");
  const refused = await r2.call("fill_address", { item: "Home" });
  expect(refused.error).toMatchObject({ code: "forbidden", message: "Home is for , not 127.0.0.1." });
  expect(r2.broker.live(THREAD)!.sealed()).toBe(false);
});
