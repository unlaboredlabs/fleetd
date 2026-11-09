// A Navi's purchases and secure inputs in its browser (cards.rs's
// tests), with a fake 1Password and a fake hub: an approved purchase's card fills into the payment provider's frame
// once, a person's typed value into the site's own frame once, an approved passport from 1Password once, and the Navi
// never sees any of them. Never a real vault or a real card.
import { afterEach, expect, test } from "bun:test";
import { cardLabel, paymentFrame, secretForms, selectValues, valueFor } from "../src/node/browser/cards.ts";
import type { Card } from "../src/node/browser/onepassword.ts";
import { NodeBoxKey } from "../src/node/identity.ts";
import { publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { chrome, driver, eventually, fakeVault, forms, rig, THREAD } from "./browser_rig.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const CARD: Card = { number: "4242424242424242", month: "03", year: "2030", cvc: "737", name: "Ada Devbox" };
const CARD_REF = "op://Shared/Visa";
const PASSPORT = "P9X81774Q";

test("each field gets the card's detail in the shape it takes, and a card fills in payment providers' frames only", () => {
  const value = (role: Parameters<typeof valueFor>[0], max: number, placeholder: string) => valueFor(role, CARD, { max, placeholder });
  expect(value("expiry", -1, "mm / yy")).toBe("03/30");
  expect(value("expiry", 7, "mm/yyyy")).toBe("03/2030");
  expect(value("expiry", 4, "")).toBe("0330");
  expect(value("year", 2, "")).toBe("30");
  expect(value("year", -1, "yyyy")).toBe("2030");
  expect(selectValues("month", CARD)).toEqual(["03", "3"]);
  const all = secretForms(CARD).map(([, v]) => v);
  for (const form of ["4242424242424242", "4242 4242 4242 4242", "03/30", "03 / 30", "737"]) expect(all).toContain(form);
  expect(paymentFrame("js.stripe.com")).toBe(true);
  expect(paymentFrame("checkoutshopper-live.adyen.com")).toBe(true);
  expect(paymentFrame("pay.devbox.test", ["pay.devbox.test"])).toBe(true);
  expect(paymentFrame("stripe.com.evil.test")).toBe(false);
  expect(paymentFrame("notstripe.com")).toBe(false);
  expect(cardLabel("op://Personal/Visa")).toBe("Visa (Personal)");
});

/** The checkout on 127.0.0.1, its card fields in a payment provider's frame on localhost (another site, so another
 * process), which charges what was typed; a visa form with a decoy frame on localhost and the site's own frame. */
function checkout() {
  const charges: Record<string, unknown>[] = [];
  const typed: Record<string, unknown>[] = [];
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
      if (path === "/typed") {
        typed.push(JSON.parse(await req.text()));
        return Response.json({});
      }
      if (path === "/card") {
        return html(`<html><body>
<input id=number name=cardnumber autocomplete=cc-number placeholder='1234 1234 1234 1234'>
<input id=exp name=exp-date autocomplete=cc-exp placeholder='MM / YY'>
<input id=cvc name=cvc autocomplete=cc-csc placeholder=CVC>
<script>
parent.postMessage({ ready: true }, '*');
addEventListener('message', async (e) => { if (!e.data || e.data.pay === undefined) return;
  const masked = ['number', 'exp', 'cvc'].every((id) => getComputedStyle(document.getElementById(id)).filter.includes('blur'));
  const body = JSON.stringify({ number: number.value, exp: exp.value, cvc: cvc.value, holder: e.data.pay, masked });
  const r = await fetch('/charge', { method: 'POST', body });
  parent.postMessage(await r.json(), '*'); });
</script></body></html>`);
      }
      if (path === "/passport") {
        return html(`<html><body><label>Passport number <input id=passport name=passport></label>
<label>Code texted to you <input id=code name=code></label><script>
parent.postMessage({ ready: true }, '*');
for (const f of [passport, code]) f.addEventListener('input', () => fetch('/typed',
  { method: 'POST', body: JSON.stringify({ field: f.id, value: f.value, origin: location.host, masked: getComputedStyle(f).filter.includes('blur') }) }));
</script></body></html>`);
      }
      if (path === "/form") {
        return html(`<html><head><title>Visa form</title></head><body><h1>Visa application</h1>
<iframe id=decoy src='http://localhost:${port}/passport'></iframe>
<iframe id=own src='/passport'></iframe><script>let ready = 0;
addEventListener('message', (e) => { if (e.data && e.data.ready && ++ready === 2) document.title = 'Form ready'; });</script></body></html>`);
      }
      return html(`<html><head><title>Checkout</title></head><body><h1>Hotel Devbox</h1><p>Total 129.90 EUR</p>
<label>Name on card <input id=holder name=holder autocomplete=cc-name></label>
<iframe id=card src='http://localhost:${port}/card' style='width:420px;height:120px'></iframe>
<button id=pay style='display:block;width:200px;height:40px'>Pay 129.90 EUR</button>
<script>
document.getElementById('pay').onclick = () => document.getElementById('card').contentWindow.postMessage({ pay: document.getElementById('holder').value }, '*');
addEventListener('message', (e) => {
  if (e.data && e.data.ready) document.title = 'Checkout ready';
  if (e.data && e.data.charged) document.title = 'Paid'; });
</script></body></html>`);
    },
  });
  port = server.port ?? 0;
  cleanups.push(() => void server.stop(true));
  return { site: `http://127.0.0.1:${port}`, charges, typed };
}

const purchase = (domain: string) => ({
  shop: { domain, name: "Hotel Devbox" },
  total: { amount: "129.90", currency: "EUR" },
  items: [{ name: "One night", quantity: 1, amount: "129.90" }],
});

/** A click as agent-browser makes one: the element's box, then a press and a release at its centre. */
async function click(d: Awaited<ReturnType<typeof driver>>, page: string, selector: string) {
  const root = (await d.ok("DOM.getDocument", { depth: 0 }, page)).root.nodeId;
  const node = (await d.ok("DOM.querySelectorAll", { nodeId: root, selector }, page)).nodeIds[0];
  const quad = (await d.ok("DOM.getBoxModel", { nodeId: node }, page)).model.content as number[];
  const [x, y] = [(quad[0]! + quad[4]!) / 2, (quad[1]! + quad[5]!) / 2];
  for (const type of ["mousePressed", "mouseReleased"]) await d.ok("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, page);
}

test.skipIf(!chrome)("an approved purchase fills the card into the provider's frame once, and the Navi never sees it", async () => {
  const r = await rig();
  cleanups.push(r.done);
  const { site, charges } = checkout();
  const fake = fakeVault({}, [], { card: async (reference) => (reference === CARD_REF ? CARD : Promise.reject(new Error("no card"))) });
  r.broker.credentials.vaultFor = fake.vaultFor;
  r.broker.extraPaymentFrames.push("localhost");
  const reported: Record<string, unknown>[] = [];
  r.answers.set("purchase_open", () => ({ requestId: "R1", state: "pending" }));
  r.answers.set("purchase_claim", (args) => ({ requestId: args.requestId, domain: "127.0.0.1", card: CARD_REF }));
  r.answers.set("purchase_filled", (args) => (reported.push(args), { requestId: args.requestId, state: "done" }));

  // Only a project's lead pays at a checkout.
  await r.call("session_start", { purpose: "Book" }, "t-worker");
  expect((await r.call("purchase_request", purchase("127.0.0.1"), "t-worker")).error).toMatchObject({ code: "forbidden", message: "Only a project's lead pays at a checkout." });

  r.broker.lead(THREAD, "assistant", "proj-1");
  const started = await r.call("session_start", { purpose: "Book the hotel" });
  const d = await driver(String(started.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Page.navigate", { url: site }, page);
  await d.until(page, "document.title", "Checkout ready");
  expect((await r.call("purchase_request", purchase("shop.example.test"))).error).toMatchObject({ code: "forbidden", message: "The page is on 127.0.0.1, not shop.example.test." });
  const asked = await r.call("purchase_request", purchase("127.0.0.1"));
  expect(asked.result).toMatchObject({ op: "purchase_request", requestId: "R1" });
  expect(String(asked.result!.message)).toStartWith("Asked the person to approve it (R1).");
  const open = r.link.calls.find((c) => c.op === "purchase_open")!;
  expect(open.args).toMatchObject({ sessionId: started.result!.sessionId, purchase: purchase("127.0.0.1") });
  // It waits on the person: it doesn't idle out meanwhile.
  const session = r.broker.live(THREAD)!;
  expect(session.idleFor(Date.now() + 3_600_000)).toBe(0);

  const filled = await r.call("purchase_fill", { requestId: "R1" });
  expect(filled.error).toBeUndefined();
  expect(String(filled.result!.message)).toStartWith("Filled the card's number, expiry, security code, name on the card from Visa (Shared);");
  expect(reported).toEqual([{ requestId: "R1", ok: true, typed: true, message: "the card's number, expiry, security code, name on the card" }]);
  expect(session.sealed()).toBe(true);
  await click(d, page, "#pay");
  await d.until(page, "document.title", "Paid");
  expect(charges).toEqual([{ number: CARD.number, exp: "03/30", cvc: CARD.cvc, holder: CARD.name, masked: true }]);
  // Whatever the Navi heard: the card in no form.
  const heard = JSON.stringify([asked, filled, d.got]);
  for (const value of [CARD.number, "4242 4242 4242 4242", CARD.cvc, "03/30"]) for (const form of forms(value).slice(0, 5)) expect(heard).not.toContain(form);
  const ended = await r.call("session_end");
  await eventually(() => r.link.calls.some((c) => c.op === "browser_session" && c.args.state === "recorded"));
  const log = r.link.calls
    .filter((c) => c.op === "browser_recording_part" && c.args.sessionId === ended.result!.sessionId)
    .map((c) => Buffer.from(String(c.args.dataB64), "base64").toString())
    .join("");
  expect(log).toContain("purchase_fill");
  expect(log).not.toContain(CARD.number);
});

test.skipIf(!chrome)("what the person types fills the site's own frame once, and an approved passport from 1Password once", async () => {
  const r = await rig();
  cleanups.push(r.done);
  const { site, typed } = checkout();
  r.broker.credentials.vaultFor = fakeVault({}, [], {
    identity: async (reference) => (reference === "op://Shared/Passport/number" ? { value: PASSPORT, urls: [] } : Promise.reject(new Error("not an identity"))),
  }).vaultFor;
  const opened: Record<string, unknown>[] = [];
  r.answers.set("secure_input_open", (args) => {
    opened.push(args);
    const input = args.input as { ref?: string };
    return input.ref ? { requestId: "S2", state: "approved" } : { requestId: "S1", state: "pending" };
  });
  r.answers.set("secure_input_claim", (args) => ({ requestId: args.requestId, domain: "127.0.0.1", target: "#passport", ref: "op://Shared/Passport/number" }));
  const filledReports: Record<string, unknown>[] = [];
  r.answers.set("secure_input_filled", (args) => (filledReports.push(args), { requestId: args.requestId, state: "done" }));
  r.broker.lead(THREAD, "assistant", "proj-1");
  const started = await r.call("session_start", { purpose: "The visa form" });
  const d = await driver(String(started.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Page.navigate", { url: `${site}/form` }, page);
  await d.until(page, "document.title", "Form ready");
  const site_ = { domain: "127.0.0.1", name: "Visa office" };
  expect((await r.call("request_secure_input", { site: site_, target: "#nothing", label: "the code", why: "the form asks" })).error?.message).toBe("No field on the page matches #nothing.");
  const asked = await r.call("request_secure_input", { site: site_, target: "#code", label: "the code texted to you", why: "the form asks for it" });
  expect(String(asked.result!.message)).toStartWith("Asked the person to type the code texted to you (S1) in a sealed field.");
  expect(opened[0]).toMatchObject({ sessionId: started.result!.sessionId, input: { target: "#code", label: "the code texted to you" } });

  // The person's value comes sealed to this machine, from the hub.
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const box = new NodeBoxKey(secret);
  const sealed = (value: string) => Buffer.from(seal(publicKeyOf(secret), new TextEncoder().encode(value))).toString("base64");
  const frame = { id: "d1", sink: `fill:devbox:${started.result!.sessionId}`, sealed: sealed("771204"), requestId: "S1", secretKey: "navi.secure_input" };
  expect(await r.broker.deliver(frame as never, box, "elsewhere")).toMatchObject({ error: "the sink is on devbox, not on elsewhere" });
  const result = await r.broker.deliver(frame as never, box, "devbox");
  expect(result.error).toBeUndefined();
  expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  await eventually(() => typed.some((t) => t.field === "code" && t.value === "771204"));
  // Into the site's own frame, hidden, never the decoy's on another site.
  expect(typed.filter((t) => t.field === "code").every((t) => t.origin === new URL(site).host && t.masked === true)).toBe(true);
  expect((await r.broker.deliver(frame as never, box, "devbox")).error).toBe("nothing waits for S1 in that browser session: it was filled already");

  // A passport from 1Password, recorded with no ask (D310): filled now.
  const fromVault = await r.call("request_secure_input", { site: site_, target: "#passport", label: "passport number", why: "the form asks", ref: "op://Shared/Passport/number" });
  expect(String(fromVault.result!.message)).toStartWith("Ready to fill passport number from 1Password (S2)");
  const filled = await r.call("secure_input_fill", { requestId: "S2" });
  expect(filled.error).toBeUndefined();
  expect(String(filled.result!.message)).toBe("Filled #passport from 1Password; this browser session now refuses reading it back. Carry on with the page.");
  await eventually(() => typed.some((t) => t.field === "passport" && t.value === PASSPORT));
  expect(filledReports).toEqual([{ requestId: "S2", ok: true, typed: true, message: "filled #passport" }]);
  const heard = JSON.stringify([asked, fromVault, filled, d.got]);
  for (const value of [PASSPORT, "771204"]) for (const form of forms(value).slice(0, 5)) expect(heard).not.toContain(form);
  expect(r.broker.credentials.filledSince(THREAD, 0)?.map(([, v]) => v)).toEqual(["771204", PASSPORT]);
});
