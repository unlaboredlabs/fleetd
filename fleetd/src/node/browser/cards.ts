// A Navi's purchases in its browser (D265; the hub's side is
// hub/browser/purchases.ts).
// - `purchaseRequest`: on the checkout page, the node checks the page is on the shop's domain and opens the purchase
//   on the hub, which asks the person (or, from D310 on, records it approved). The session waits for them without
//   idling out.
// - `purchaseFill`: once approved, the node claims the purchase on the hub (once, within its window), opens the vault
//   card the claim carries sealed to this node (`sealedCard`; for one release a 1Password Credit Card item, read with
//   the session's token), seals the session as a login fill does (credentials.ts),
//   then types each detail into its field: in the shop's page, its own frames, and frames of the payment providers
//   checkouts embed (Stripe, Adyen, Braintree, ...; cross-origin, so the node attaches to them itself). Each filled
//   field shows dots and a blur. The details pass only the node's own connection to the browser.
import { ToolError } from "../../shared/errors.ts";
import { FOCUS, HIDE, pageUrl, scrubbed, seal } from "./credentials.ts";
import type { Broker } from "./index.ts";
import { type Card, hostOf } from "./onepassword.ts";
import { PAUSED, type Session } from "./session.ts";
import { openCard } from "./vault.ts";

/** The longest a session waits on a person (a purchase's approval, a takeover) before it may idle out again. */
export const WAIT_ON_PERSON_MS = 2 * 60 * 60_000;
/** How long an approved purchase or secure input may be filled (purchase.rs `FILL_WINDOW_MINUTES`). */
export const FILL_WINDOW_MINUTES = 15;

/** The payment providers whose card fields checkouts embed in frames of their own; a card fills in the shop's page,
 * its own frames, and frames on these (and their subdomains) only. */
export const PAYMENT_FRAMES = [
  "stripe.com",
  "stripe.network",
  "adyen.com",
  "adyenpayments.com",
  "braintreegateway.com",
  "braintree-api.com",
  "checkout.com",
  "squarecdn.com",
  "squareup.com",
  "paypal.com",
  "mollie.com",
  "worldpay.com",
];

/** Whether `host` is `domain` or one of its subdomains (purchase.rs `on_domain`). */
export function onDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  return h === domain || (h.endsWith(domain) && h.slice(0, h.length - domain.length).endsWith("."));
}

/** Whether a card may fill in a frame on `host`: a payment provider's, or one `extra` names (tests). */
export const paymentFrame = (host: string, extra: string[] = []) => [...PAYMENT_FRAMES, ...extra].some((p) => onDomain(host, p));

/** How a card is named to the person: its item and its vault, `Visa (Personal)` (purchase.rs `NaviCard::label`); a
 * vault card, whose label the claim doesn't carry, as the vault's card. */
export function cardLabel(reference: string): string {
  if (reference.startsWith("vault:")) return "the vault's card";
  const rest = reference.replace(/^(op:\/\/)+/, "");
  const at = rest.indexOf("/");
  return at < 0 ? rest : `${rest.slice(at + 1)} (${rest.slice(0, at)})`;
}

/** The Navi's live browser session, or why a purchase call can't use it. */
export function naviSession(broker: Broker, thread: string): Session {
  if (!broker.isNavi(thread)) throw new ToolError("forbidden", "Only a project's lead pays at a checkout.", "leave the payment to the person and say so");
  const session = broker.live(thread);
  if (!session) throw new ToolError("not_found", "No browser session is open.", "open the shop's checkout in a browser session (session_start) first");
  if (session.control() === "human") throw new ToolError("invalid", PAUSED, "try again once they hand it back");
  return session;
}

const domainOf = (call: Record<string, unknown>) => String(((call.shop ?? call.site) as { domain?: unknown } | undefined)?.domain ?? "");

/** An agent's `purchase_request`: the person is asked to approve exactly this purchase, on this checkout. */
export async function purchaseRequest(broker: Broker, thread: string, call: Record<string, unknown>): Promise<{ requestId: string; message: string }> {
  const session = naviSession(broker, thread);
  const page = (await pageUrl(session)) ?? "";
  const domain = domainOf(call);
  const host = hostOf(page) ?? "";
  if (!onDomain(host, domain)) {
    throw new ToolError("forbidden", `The page is on ${host || "no website"}, not ${domain}.`, "open the shop's checkout page, then ask with its own domain");
  }
  const total = (call.total ?? {}) as { amount?: unknown; currency?: unknown };
  const args = { shop: domain, total: `${String(total.amount)} ${String(total.currency)}` };
  const { op: _op, ...purchase } = call;
  const opened = await broker.inTurn(session, "purchase_open", { sessionId: session.id, page: [...session.scrub().text(page)].slice(0, 2000).join(""), purchase });
  session.stepAt("purchase_request", args, true, undefined, 0);
  const id = String(opened.requestId ?? "");
  // A hub from D310 on keeps it as a record, approved as it opens: the card fills now.
  if (opened.state === "approved") {
    return {
      requestId: id,
      message: `Recorded (${id}): call purchase_fill with requestId ${id} now, within ${FILL_WINDOW_MINUTES} minutes, on this page with its card fields showing; never type card details yourself.`,
    };
  }
  // The person may take a while: the checkout, and what it holds, waits for them.
  session.holdForAnswer(WAIT_ON_PERSON_MS);
  return {
    requestId: id,
    message: `Asked the person to approve it (${id}). Stay on this checkout and end your turn: you are woken with their answer. Approved, call purchase_fill with requestId ${id} within ${FILL_WINDOW_MINUTES} minutes, on this page with its card fields showing; never type card details yourself.`,
  };
}

/** Why a card fill stopped, and whether any of it reached the page. */
export class CardError extends Error {
  constructor(
    message: string,
    readonly typed: boolean,
  ) {
    super(message);
  }
}

export const notTyped = (message: string) => new CardError(message, false);

/** `text`'s first line, at most 500 characters, for a report's line. */
export function oneLine(text: string): string {
  const line = [...(text.split("\n")[0] ?? "")].slice(0, 500).join("");
  return line.trim() ? line : "no word on it";
}

/** An agent's `purchase_fill`: the approved purchase's card, typed into the checkout's card fields. */
export async function purchaseFill(broker: Broker, thread: string, call: Record<string, unknown>): Promise<{ message: string }> {
  const started = performance.now();
  const session = naviSession(broker, thread);
  const id = String(call.requestId ?? "");
  const args = { requestId: id };
  const failed = (error: ToolError) => {
    const out = scrubbed(session, error);
    session.stepAt("purchase_fill", args, false, out.message, Math.round(performance.now() - started));
    return out;
  };
  let claimed: Record<string, unknown>;
  try {
    claimed = await broker.inTurn(session, "purchase_claim", { requestId: id, sessionId: session.id });
  } catch (e) {
    throw failed(e instanceof ToolError ? e : new ToolError("failed", (e as Error).message));
  }
  // Claimed: from here the hub hears how it went, so an untyped fill may be tried again.
  let outcome: { ok: true; filled: string } | { ok: false; error: CardError };
  try {
    outcome = { ok: true, filled: await fillClaimed(broker, session, String(claimed.domain ?? ""), String(claimed.card ?? ""), claimed.sealedCard) };
  } catch (e) {
    outcome = { ok: false, error: e instanceof CardError ? e : notTyped((e as Error).message) };
  }
  const said = outcome.ok ? outcome.filled : outcome.error.message;
  try {
    await broker.inTurn(session, "purchase_filled", {
      requestId: id,
      ok: outcome.ok,
      typed: outcome.ok || outcome.error.typed,
      message: oneLine(session.scrub().text(said)),
    });
  } catch (e) {
    console.warn(`browser ${session.id}: purchase ${id}'s fill was not reported: ${(e as Error).message}`);
  }
  session.hold(undefined);
  broker.filledMeta(session);
  if (!outcome.ok) {
    throw failed(
      new ToolError(
        "invalid",
        `The card was not filled: ${outcome.error.message}.`,
        outcome.error.typed
          ? "the card may be partly in the page: tell the person, and ask again with purchase_request if they still want it"
          : "nothing was typed: open the checkout's card form and call purchase_fill again within the window",
      ),
    );
  }
  const message = `Filled ${outcome.filled} from ${cardLabel(String(claimed.card ?? ""))}; this browser session now refuses reading them back. Check the total is still what the purchase asked for, then click the checkout's Pay or Book button yourself. If the bank asks to confirm the payment (3-D Secure, a code or its app), call request_takeover with "Confirm the payment in your bank app" and wait for them to hand it back. Then say in the chat whether the order went through.`;
  // The checkout as the fill left it, in the DOM trace (scrubbed of the card).
  session.queueCapture(session.stepAt("purchase_fill", args, true, message, Math.round(performance.now() - started)));
  return { message: session.scrub().text(message) };
}

/** Reads the claimed purchase's card and types it in: a vault card as the claim carries it sealed to this node, a
 * 1Password one (for one release) read with the session's token. Its result: what it filled, in words. */
async function fillClaimed(broker: Broker, session: Session, domain: string, reference: string, sealedCard: unknown): Promise<string> {
  const page = (await pageUrl(session)) ?? "";
  const host = hostOf(page) ?? "";
  if (!onDomain(host, domain)) throw notTyped(`the page is on ${host || "no website"}, not the approved shop's ${domain}`);
  let card: Card;
  // How the card's details are masked: `***vault:card/number***`, or by the 1Password reference.
  const masked = reference.startsWith("vault:") ? "vault:card/" : `${reference} `;
  try {
    if (sealedCard !== undefined && sealedCard !== null) card = openCard(broker, sealedCard);
    else if (reference.startsWith("vault:")) throw notTyped("the hub sent no card for this vault card");
    else {
      const vault = broker.vault(session);
      if (!vault.vault.card) throw new Error(`${reference} can't be read as a card here`);
      card = await vault.vault.card(reference).catch((e: Error) => {
        throw notTyped(`${reference} was not read: ${e.message.replace(/\.+$/, "")}`);
      });
    }
  } catch (e) {
    throw e instanceof CardError ? e : notTyped((e as Error).message.replace(/\.+$/, ""));
  }
  return typeCard(broker, session, domain, card, masked);
}

/** Types a card in, sealed first. */
async function typeCard(broker: Broker, session: Session, domain: string, card: Card, masked: string): Promise<string> {
  // Sealed before any of it is near the page: from here every answer to the driver, and the agent's transcript, is
  // scrubbed of each form of it, and its reads are refused.
  for (const [name, value] of secretForms(card)) {
    const named = `${masked}${name}`;
    session.addSecret(named, value);
    broker.credentials.filled(session.threadId, named, value);
  }
  seal(broker, session, `${masked}number`, card.number);
  const allowed = (url: string) => {
    const h = hostOf(url);
    return h !== undefined && (onDomain(h, domain) || paymentFrame(h, broker.extraPaymentFrames));
  };
  try {
    return await fillCard(session, card, allowed);
  } catch (e) {
    if (e instanceof CardError && !e.typed) session.credentialsFilled -= 1;
    throw e;
  }
}

/** The card's values in every form a page shows them: scrubbed from all the driver sees. */
export function secretForms(card: Card): [string, string][] {
  const grouped = (card.number.match(/.{1,4}/g) ?? []).join(" ");
  const short = card.year.slice(-2);
  const forms: [string, string][] = [
    ["number", card.number],
    ["number", grouped],
    ["number", grouped.replaceAll(" ", "-")],
    ["expiry", `${card.month}/${short}`],
    ["expiry", `${card.month} / ${short}`],
    ["expiry", `${card.month}/${card.year}`],
    ["expiry", `${card.month}${short}`],
  ];
  if (card.cvc) forms.push(["code", card.cvc]);
  return forms;
}

/** Which detail of a card a field takes. */
type Role = "number" | "expiry" | "month" | "year" | "code" | "name";
const ROLES: Role[] = ["number", "expiry", "month", "year", "code", "name"];
const WORDS: Record<Role, string> = { number: "number", expiry: "expiry", month: "expiry", year: "expiry", code: "security code", name: "name on the card" };

/** The card fields of one document, by role: its autocomplete tokens first (cc-number, cc-exp, ...), else what its
 * name, id, placeholder, label or aria-label says. Only fields a person could type in, shown on the page. */
const FIND = `(() => {
  const skip = ["hidden", "checkbox", "radio", "submit", "button", "file", "image", "reset", "color", "range"];
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const fields = [...document.querySelectorAll("input, select")].filter(
    (el) => !el.disabled && !el.readOnly && !skip.includes((el.type || "").toLowerCase()) && shown(el),
  );
  const said = (el) =>
    [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.getAttribute("data-fieldtype"),
      ...[...(el.labels || [])].map((l) => l.textContent)]
      .filter(Boolean).join(" ").toLowerCase();
  const tokens = (el) => (el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
  const roles = [
    ["number", "cc-number", /card.?num|cc.?num|cardnumber|credit.?card.?number|encryptedcardnumber/],
    ["month", "cc-exp-month", /exp\\w*.?month|encryptedexpirymonth|^mm$/],
    ["year", "cc-exp-year", /exp\\w*.?year|encryptedexpiryyear|^yy(yy)?$/],
    ["expiry", "cc-exp", /expir|exp.?date|mm.?\\/.?yy|encryptedexpirydate/],
    ["code", "cc-csc", /cvc|cvv|csc|security.?code|verification|encryptedsecuritycode/],
    ["name", "cc-name", /name.?on.?card|card.?holder|holder.?name|cardholder/],
  ];
  const found = {};
  const used = new Set();
  for (const [role, token] of roles) {
    const el = fields.find((f) => !used.has(f) && tokens(f).includes(token));
    if (el) { found[role] = el; used.add(el); }
  }
  for (const [role, , words] of roles) {
    if (found[role]) continue;
    if (role === "expiry" && (found.month || found.year)) continue;
    const el = fields.find((f) => !used.has(f) && words.test(said(f)));
    if (el) { found[role] = el; used.add(el); }
  }
  return found;
})()`;

/** What the node reads of a field before it types: its tag, its length limit, its placeholder and its document's
 * address. */
const FIELD =
  "function() { return { tag: this.tagName.toLowerCase(), max: this.maxLength, placeholder: (this.placeholder || '').toLowerCase(), url: this.ownerDocument.location.href }; }";

/** Picks the option of a select that is one of `values`, by its value or its text, as a person's pick would. */
const PICK =
  "function(values) { const options = [...this.options]; const o = options.find(o => values.includes(o.value.trim())) || options.find(o => values.includes(o.text.trim())); if (!o) return false; this.value = o.value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return true; }";

/** One document a value may fill in: the CDP session it is reached through, the target it is in, and its frame. */
export type Doc = { session: string; target: string; frame: string };

type FrameTree = { frame?: { id?: string; url?: string }; childFrames?: FrameTree[] };

/**
 * Every frame of the followed page a value may fill in, the page's own first: frames in its process through the page's
 * session, frames in other processes (a payment provider's, cross-origin) through a session of the node's own, hidden
 * from the driver.
 */
export async function docs(session: Session, pageTarget: string, pageSession: string, allowed: (url: string) => boolean): Promise<Doc[]> {
  let out: Doc[] = [];
  const known = new Set<string>();
  const walk = (tree: FrameTree | undefined, via: string, inTarget: string) => {
    const stack = tree ? [tree] : [];
    while (stack.length) {
      const node = stack.pop()!;
      const id = node.frame?.id;
      if (typeof id === "string") {
        known.add(id);
        if (allowed(node.frame?.url ?? "")) out.push({ session: via, target: inTarget, frame: id });
      }
      stack.push(...[...(node.childFrames ?? [])].reverse());
    }
  };
  try {
    walk((await session.cdp.call(pageSession, "Page.getFrameTree")).frameTree as FrameTree, pageSession, pageTarget);
  } catch {}
  // Frames in other processes are targets of their own: attached here, their own frames added, until none is new.
  const attached = new Set<string>();
  for (;;) {
    let infos: { targetId?: string; type?: string; parentFrameId?: string }[];
    try {
      infos = ((await session.cdp.call(undefined, "Target.getTargets")).targetInfos ?? []) as typeof infos;
    } catch {
      break;
    }
    const next = infos
      .filter((t) => t.type === "iframe")
      // Its frame is in the page's tree, or its parent is (where the tree leaves other processes' frames out).
      .filter((t) => [t.targetId, t.parentFrameId].some((id) => typeof id === "string" && known.has(id)))
      .map((t) => t.targetId!)
      .filter((t) => typeof t === "string" && !attached.has(t));
    if (next.length === 0) break;
    for (const target of next) {
      attached.add(target);
      let own: string;
      try {
        own = await session.cdp.attach(target);
      } catch {
        continue;
      }
      // Its frame in the page's tree is now its own document: filled through its session.
      out = out.filter((d) => d.frame !== target);
      try {
        walk((await session.cdp.call(own, "Page.getFrameTree")).frameTree as FrameTree, own, target);
      } catch {}
    }
  }
  return out;
}

type About = { tag?: unknown; max?: unknown; placeholder?: unknown; url?: unknown };

/**
 * Types the card into the card fields of the followed page and its allowed frames, each detail once, over the node's
 * own connection. Every document is checked to be `allowed` just before its field is typed in, so a frame that moved
 * since gets nothing.
 */
export async function fillCard(session: Session, card: Card, allowed: (url: string) => boolean): Promise<string> {
  const page = session.page();
  if (!page) throw notTyped("the browser has no page");
  const [pageTarget, pageSession] = page;
  let typed = false;
  const filled: Role[] = [];
  const err = (e: unknown) => new CardError((e as Error).message, typed);
  for (const doc of await docs(session, pageTarget, pageSession, allowed)) {
    if (ROLES.every((r) => filled.includes(r))) break;
    const call = (method: string, params: Record<string, unknown>) => session.cdp.call(doc.session, method, params);
    let props: { name?: string; value?: { objectId?: string } }[];
    try {
      const world = await call("Page.createIsolatedWorld", { frameId: doc.frame, worldName: "fleetd card" });
      const context = world.executionContextId;
      if (typeof context !== "number") continue;
      const found = await call("Runtime.evaluate", { expression: FIND, contextId: context, returnByValue: false });
      const object = (found.result as { objectId?: string } | undefined)?.objectId;
      if (!object) continue;
      props = ((await call("Runtime.getProperties", { objectId: object, ownProperties: true })).result ?? []) as typeof props;
    } catch {
      continue;
    }
    for (const role of ROLES) {
      if (
        filled.includes(role) ||
        (role === "expiry" && (filled.includes("month") || filled.includes("year"))) ||
        ((role === "month" || role === "year") && filled.includes("expiry"))
      ) {
        continue;
      }
      const field = props.find((p) => p.name === role)?.value?.objectId;
      if (!field) continue;
      const on = (fn: string) => call("Runtime.callFunctionOn", { objectId: field, functionDeclaration: fn, returnByValue: true });
      let about: About;
      try {
        about = ((await on(FIELD)).result as { value?: About } | undefined)?.value ?? {};
      } catch (e) {
        throw err(e);
      }
      const url = typeof about.url === "string" ? about.url : "";
      if (!allowed(url)) throw new CardError("a card field's frame left the shop's checkout", typed);
      const value = valueFor(role, card, about);
      if (!value) continue;
      // From here the driver may not write to this field (credentials.ts, filledFieldRefusal).
      try {
        const described = await call("DOM.describeNode", { objectId: field });
        const backend = (described.node as { backendNodeId?: unknown } | undefined)?.backendNodeId;
        if (typeof backend === "number") session.filledField(doc.target, hostOf(url) ?? "", backend);
      } catch {}
      if (about.tag === "select") {
        typed = true;
        let picked: Record<string, unknown>;
        try {
          picked = await call("Runtime.callFunctionOn", {
            objectId: field,
            functionDeclaration: PICK,
            arguments: [{ value: selectValues(role, card) }],
            returnByValue: true,
          });
        } catch (e) {
          throw err(e);
        }
        if ((picked.result as { value?: unknown } | undefined)?.value === true) filled.push(role);
        continue;
      }
      try {
        await on(HIDE);
        await on(FOCUS);
      } catch (e) {
        throw err(e);
      }
      typed = true;
      // The one copy of the detail the node makes for the page. A frame in another process takes its input through its
      // own session; the page's session routes it to the focused frame otherwise.
      try {
        await call("Input.insertText", { text: value });
      } catch (e) {
        if (doc.session === pageSession) throw err(e);
        try {
          await session.cdp.call(pageSession, "Input.insertText", { text: value });
        } catch (again) {
          throw err(again);
        }
      }
      filled.push(role);
    }
  }
  if (!filled.includes("number")) {
    throw new CardError(typed ? "the checkout's card number field took nothing" : "no card number field on the checkout: open its card form first", typed);
  }
  const said: string[] = [];
  for (const role of ROLES.filter((r) => filled.includes(r))) if (!said.includes(WORDS[role])) said.push(WORDS[role]);
  return `the card's ${said.join(", ")}`;
}

/** What a field of `role` takes, shaped by what it says it holds: an expiry `MM/YY` (or `MM/YYYY` where it asks for
 * that), a year in two digits where only two fit. */
export function valueFor(role: Role, card: Card, about: About): string {
  const max = typeof about.max === "number" ? about.max : -1;
  const placeholder = typeof about.placeholder === "string" ? about.placeholder : "";
  const short = card.year.slice(-2);
  switch (role) {
    case "number":
      return card.number;
    case "expiry":
      if (placeholder.includes("yyyy") && !(max >= 0 && max < 7)) return `${card.month}/${card.year}`;
      return max === 4 ? `${card.month}${short}` : `${card.month}/${short}`;
    case "month":
      return card.month;
    case "year":
      return max === 2 || placeholder === "yy" ? short : card.year;
    case "code":
      return card.cvc;
    case "name":
      return card.name;
  }
}

/** The options a select of `role` may name the detail by. */
export function selectValues(role: Role, card: Card): string[] {
  if (role === "month") return [card.month, card.month.replace(/^0+/, "")];
  if (role === "year") return [card.year, card.year.slice(-2)];
  return [];
}
