// An agent's `fill_address` (vault-design §4.3): a vault address typed into the page's address form, the way a card
// fills (cards.ts). The hub decides where an address may fill (a checkout recorded in this session, the item's own
// sites, a site of one of its owner's vault logins) and sends its parts sealed to this node (vault.ts). The node finds
// the form's fields by their `autocomplete` tokens, then by what their name, id, placeholder or label says, in the
// page's own documents only, and types each part over its own connection: each field blurred, the session sealed
// first so the parts never come back to the agent.
import type { AddressSecret } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CardError, docs, notTyped } from "./cards.ts";
import { FOCUS, HIDE, pageUrl, scrubbed, seal } from "./credentials.ts";
import type { Broker } from "./index.ts";
import { hostOf } from "./onepassword.ts";
import { PAUSED, type Session } from "./session.ts";
import { ADDRESS_SECRET_PARTS, maskName, vaultFill, vaultFilled } from "./vault.ts";

/** The fill_address call's fields, as agent-mcp sends them. */
export type FillAddressCall = { item?: unknown; part?: unknown; target?: unknown };

/** Which part of an address a field takes. `given` and `family` split the name; `street` takes both lines. */
type Role = "name" | "given" | "family" | "organization" | "street" | "line1" | "line2" | "city" | "region" | "postalCode" | "country" | "phone" | "email";
const ROLES: Role[] = ["name", "given", "family", "organization", "street", "line1", "line2", "city", "region", "postalCode", "country", "phone", "email"];
const WORDS: Record<Role, string> = {
  name: "name",
  given: "name",
  family: "name",
  organization: "company",
  street: "street",
  line1: "street",
  line2: "street",
  city: "city",
  region: "region",
  postalCode: "postal code",
  country: "country",
  phone: "phone",
  email: "email",
};

/**
 * The address fields of one document, by role: its autocomplete tokens first (`shipping address-line1`, `postal-code`,
 * ...), else what its name, id, placeholder, label or aria-label says. With a `part`, fields marked for it come first,
 * and a field marked for the other part is never taken. With a `target`, only fields in its form. Never a card field.
 */
const find = (part: string | undefined, target: string | undefined) => `((part, target) => {
  const skip = ["hidden", "checkbox", "radio", "submit", "button", "file", "image", "reset", "color", "range", "password"];
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  let scope = document;
  if (target) {
    const at = document.querySelector(target);
    if (!at) return { missing: true };
    scope = at.closest("form") || at;
  }
  const tokens = (el) => (el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/).filter(Boolean);
  const pieces = (el) =>
    [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), ...[...(el.labels || [])].map((l) => l.textContent)]
      .filter(Boolean).map((p) => p.trim().toLowerCase());
  const said = (el) => pieces(el).join(" ");
  const other = part === "shipping" ? /billing/ : part === "billing" ? /shipping|delivery/ : null;
  const mine = part === "shipping" ? /shipping|delivery/ : part === "billing" ? /billing/ : null;
  const fields = [...scope.querySelectorAll("input, select, textarea")].filter((el) => {
    if (el.disabled || el.readOnly || skip.includes((el.type || "").toLowerCase()) || !shown(el)) return false;
    if (tokens(el).some((t) => t.startsWith("cc-"))) return false;
    if (/card|cvc|cvv|expir/.test(said(el))) return false;
    if (other && (tokens(el).some((t) => other.test(t)) || other.test(said(el)))) return false;
    return true;
  });
  if (mine) fields.sort((a, b) => Number(mine.test(tokens(b).join(" ") + said(b))) - Number(mine.test(tokens(a).join(" ") + said(a))));
  const roles = [
    ["email", ["email"], /e.?mail/],
    ["phone", ["tel", "tel-national"], /phone|tel|mobile/],
    ["name", ["name"], /full.?name|^name$|recipient|your.?name|^(shipping|billing).?name$/],
    ["given", ["given-name"], /first.?name|given.?name|fname/],
    ["family", ["family-name"], /last.?name|family.?name|surname|lname/],
    ["organization", ["organization"], /company|organi[sz]ation|business/],
    ["street", ["street-address"], /^$/],
    ["line1", ["address-line1"], /address.?(line)?.?1|street|addr1|^((shipping|billing|delivery|postal) )?address$/],
    ["line2", ["address-line2"], /address.?(line)?.?2|apartment|apt|suite|addr2/],
    ["city", ["address-level2"], /city|town|locality/],
    ["region", ["address-level1"], /state|province|region|county/],
    ["postalCode", ["postal-code"], /zip|postal|post.?code|plz/],
    ["country", ["country", "country-name"], /country/],
  ];
  const found = {};
  const used = new Set();
  for (const [role, names] of roles) {
    const el = fields.find((f) => !used.has(f) && tokens(f).some((t) => names.includes(t)));
    if (el) { found[role] = el; used.add(el); }
  }
  for (const [role, , words] of roles) {
    if (found[role] || role === "street") continue;
    if (role === "name" && (found.given || found.family)) continue;
    if ((role === "line1" || role === "line2") && found.street) continue;
    const el = fields.find((f) => !used.has(f) && pieces(f).some((p) => words.test(p)));
    if (el) { found[role] = el; used.add(el); }
  }
  return found;
})(${JSON.stringify(part ?? null)}, ${JSON.stringify(target ?? null)})`;

/** What the node reads of a field before it types: its tag and its document's address. */
const FIELD = "function() { return { tag: this.tagName.toLowerCase(), url: this.ownerDocument.location.href }; }";

/** Picks the option of a select that is one of `values`, by its value or its text, whatever their case. */
const PICK =
  "function(values) { const want = values.map(v => v.toLowerCase()); const options = [...this.options]; const o = options.find(o => want.includes(o.value.trim().toLowerCase())) || options.find(o => want.includes(o.text.trim().toLowerCase())); if (!o) return false; this.value = o.value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return true; }";

/** What a field of `role` takes from the address. */
export function addressValue(role: Role, a: AddressSecret): string {
  const name = (a.name ?? "").trim();
  const at = name.lastIndexOf(" ");
  switch (role) {
    case "given":
      return at < 0 ? name : name.slice(0, at);
    case "family":
      return at < 0 ? "" : name.slice(at + 1);
    case "street":
      return [a.line1, a.line2].filter(Boolean).join("\n");
    default:
      return (a[role] ?? "").trim();
  }
}

/** A country select's names for `country`: its code as kept, and its English name. */
function countryValues(country: string): string[] {
  const values = [country];
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(country.toUpperCase());
    if (name && name !== country) values.push(name);
  } catch {}
  return values;
}

/** The address the session may use when the call names none: the only one, or the one labelled Home. */
async function defaultAddress(broker: Broker, session: Session): Promise<string> {
  let items: { itemId?: unknown; label?: unknown }[];
  try {
    const listed = await broker.inTurn(session, "vault_items", { kind: "address" });
    items = Array.isArray(listed.items) ? (listed.items as typeof items) : [];
  } catch {
    // A session hosted for an agent elsewhere may not list its items here: the hub resolves the label.
    return "Home";
  }
  if (items.length === 1) return String(items[0]!.itemId);
  const home = items.filter((i) => String(i.label).toLowerCase() === "home");
  if (home.length === 1) return String(home[0]!.itemId);
  if (items.length === 0) throw new ToolError("not_found", "No vault address this session may use.", "ask your lead: a person adds one in Settings › Vault");
  throw new ToolError("invalid", `This session may use ${items.length} addresses.`, "name one with item (its label or id, from vault_items)");
}

/** An agent's `fill_address` in its live session: a vault address, typed into the page's address form. */
export async function fillAddress(broker: Broker, thread: string, call: FillAddressCall): Promise<{ message: string }> {
  const started = performance.now();
  const session = broker.live(thread);
  if (!session) throw new ToolError("not_found", "No browser session is open.", "start one with session_start, open the form, then fill");
  if (session.control() === "human") throw new ToolError("invalid", PAUSED, "fill once they hand it back");
  const part = call.part === "shipping" || call.part === "billing" ? call.part : undefined;
  const target = typeof call.target === "string" && call.target ? call.target : undefined;
  const named = typeof call.item === "string" && call.item ? call.item : undefined;
  const args = { ...(named ? { item: named } : {}), ...(part ? { part } : {}), ...(target ? { target } : {}) };
  const failed = (error: ToolError) => {
    const out = scrubbed(session, error);
    session.stepAt("fill_address", args, false, out.message, Math.round(performance.now() - started));
    return out;
  };
  if (call.part !== undefined && call.part !== null && !part) throw failed(new ToolError("invalid", "part: shipping or billing."));
  const page = (await pageUrl(session)) ?? "";
  let got: Awaited<ReturnType<typeof vaultFill>>;
  try {
    got = await vaultFill(broker, session, { item: named ?? (await defaultAddress(broker, session)), field: "address", page });
  } catch (e) {
    throw failed(e instanceof ToolError ? e : new ToolError("failed", (e as Error).message));
  }
  const address = got.plain;
  // The hub checked the page; the parts fill only in its own documents, on the page's host.
  const host = hostOf(page);
  const allowed = (url: string) => host !== undefined && hostOf(url) === host;
  const parts = ADDRESS_SECRET_PARTS.map((p) => [p, (address[p] ?? "").trim()] as const).filter(([, v]) => v !== "");
  for (const [p, value] of parts.slice(1)) {
    const name = maskName(got.label, p);
    session.addSecret(name, value);
    broker.credentials.filled(session.threadId, name, value);
  }
  if (parts[0]) seal(broker, session, maskName(got.label, parts[0][0]), parts[0][1]);
  let filled: string;
  try {
    filled = await fillAddressFields(session, address, part, target, allowed);
  } catch (e) {
    const error = e instanceof CardError ? e : notTyped((e as Error).message);
    if (!error.typed && parts[0]) session.credentialsFilled -= 1;
    await vaultFilled(broker, session, got.auditId, false, error.typed, `not filled: ${error.message}`);
    broker.filledMeta(session);
    throw failed(
      new ToolError(
        "invalid",
        `${got.label} was not filled: ${error.message}.`,
        error.typed ? "part of it may be in the form: check it with agent-browser snapshot -i" : "open the page's address form, then fill again; name its form with target when it has several",
      ),
    );
  }
  await vaultFilled(broker, session, got.auditId, true, true, `filled the ${filled}`);
  const message = `Filled the address's ${filled} from the vault's ${got.label}. This browser session now refuses reading filled values back (agent-browser eval and get value among them); check the form with agent-browser snapshot -i and fill what it still asks.`;
  session.queueCapture(session.stepAt("fill_address", args, true, message, Math.round(performance.now() - started)));
  broker.filledMeta(session);
  void broker.report(session, "live");
  return { message: session.scrub().text(message) };
}

/** Types the address's parts into the page's address fields, each once, over the node's own connection. Its result:
 * what it filled, in words. */
export async function fillAddressFields(
  session: Session,
  address: AddressSecret,
  part: string | undefined,
  target: string | undefined,
  allowed: (url: string) => boolean,
): Promise<string> {
  const page = session.page();
  if (!page) throw notTyped("the browser has no page");
  const [pageTarget, pageSession] = page;
  let typed = false;
  let missing = false;
  const filled: Role[] = [];
  const err = (e: unknown) => new CardError((e as Error).message, typed);
  for (const doc of await docs(session, pageTarget, pageSession, allowed)) {
    if (filled.length > 0) break;
    const call = (method: string, params: Record<string, unknown>) => session.cdp.call(doc.session, method, params);
    let props: { name?: string; value?: { objectId?: string } }[];
    try {
      const world = await call("Page.createIsolatedWorld", { frameId: doc.frame, worldName: "fleetd address" });
      const context = world.executionContextId;
      if (typeof context !== "number") continue;
      const found = await call("Runtime.evaluate", { expression: find(part, target), contextId: context, returnByValue: false });
      const object = (found.result as { objectId?: string } | undefined)?.objectId;
      if (!object) continue;
      props = ((await call("Runtime.getProperties", { objectId: object, ownProperties: true })).result ?? []) as typeof props;
    } catch {
      continue;
    }
    if (props.some((p) => p.name === "missing")) {
      missing = true;
      continue;
    }
    for (const role of ROLES) {
      const field = props.find((p) => p.name === role)?.value?.objectId;
      if (!field) continue;
      const value = addressValue(role, address);
      if (!value) continue;
      const on = (fn: string) => call("Runtime.callFunctionOn", { objectId: field, functionDeclaration: fn, returnByValue: true });
      let about: { tag?: unknown; url?: unknown };
      try {
        about = ((await on(FIELD)).result as { value?: typeof about } | undefined)?.value ?? {};
      } catch (e) {
        throw err(e);
      }
      const url = typeof about.url === "string" ? about.url : "";
      if (!allowed(url)) throw new CardError("an address field's frame left the page's site", typed);
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
            arguments: [{ value: role === "country" ? countryValues(value) : [value] }],
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
      // The one copy of each part the node makes for the page.
      try {
        await call("Input.insertText", { text: value });
      } catch (e) {
        throw err(e);
      }
      filled.push(role);
    }
  }
  if (filled.length === 0) {
    throw new CardError(missing ? `no field on the page matches ${target}` : "no address form on the page: open it first", typed);
  }
  const said: string[] = [];
  for (const role of ROLES.filter((r) => filled.includes(r))) if (!said.includes(WORDS[role])) said.push(WORDS[role]);
  return said.join(", ");
}
