// Credential sessions: everything about filling logins lives here,
// behind the seams the rest of the broker calls.
// - `fillCredential`: the broker's entry point for an agent's `fill_credential`.
// - `outgoing`: the proxy passes each message for the driver through it (by way of the session's `outgoing`).
// - `filledFieldRefusal`: the proxy asks it, for each of the driver's DOM writes, whether it is to a field filled here.
// What a sealed session refuses outright is guard.ts's: an allowlist of what agent-browser sends, narrower once sealed.
//
// A fill reads the reference with the session's vault (onepassword.ts: the project's OP_SERVICE_ACCOUNT_TOKEN, else its
// person's, a cache per session, backoff on rate limits), checks that the page and the field's form are on the item's
// own website, seals the session (its scrubber learns the value, agent-browser's policy file denies its reads, and the
// proxy runs only agent-browser's own script shapes), then types the value over the node's own connection and submits,
// in one step (`fill`). The value never passes the proxy, and every answer to the driver is scrubbed of it.
import { ToolError } from "../../shared/errors.ts";
import { writePolicy } from "./agent_browser.ts";
import type { Broker } from "./index.ts";
import { Cache, CredError, type Credential, hostOf, isOtp, originAllowed, TOKEN_ENV, type Vault, type VaultFor, vaultFor } from "./onepassword.ts";
import { PAUSED, type Session } from "./session.ts";

/** A session's vault, made with the token at its first fill, and what it resolved. */
export type SessionVault = { vault: Vault; cache: Cache };

/** The broker's side of 1Password: how a session's vault is made, and each live session's vault and cache. */
export class Credentials {
  vaultFor: VaultFor;
  /** By browser session id (or `remote:<thread>`): its vault and cache. */
  private readonly sessions = new Map<string, SessionVault>();
  /** By agent session: every value filled into its browsers, until its claude exits. */
  private readonly filledBy = new Map<string, [string, string][]>();

  constructor(home: string) {
    this.vaultFor = vaultFor(home);
  }

  filled(thread: string, reference: string, value: string): void {
    let values = this.filledBy.get(thread);
    if (!values) this.filledBy.set(thread, (values = []));
    if (!values.some(([, v]) => v === value)) values.push([reference, value]);
  }

  /** The values filled into the agent session's browsers, when there are more than `known`: masked in what it reports. */
  filledSince(thread: string, known: number): [string, string][] | undefined {
    const values = this.filledBy.get(thread);
    return values && values.length > known ? [...values] : undefined;
  }

  /** The agent session's claude exited: what it filled is let go. */
  ended(thread: string): void {
    this.filledBy.delete(thread);
  }

  /** A session ended: its vault (the helper process with the token) and cache go. */
  forget(id: string): void {
    this.sessions.get(id)?.vault.close?.();
    this.sessions.delete(id);
  }

  /** A vault kept under `id`, with the token from `secrets` (agent session's). */
  vaultBy(id: string, secrets: () => [string, string][]): SessionVault {
    const kept = this.sessions.get(id);
    if (kept) return kept;
    let all: [string, string][];
    try {
      all = secrets();
    } catch (e) {
      throw new ToolError(
        "failed",
        `The node could not read this session's secrets for its 1Password token (${(e as Error).message}).`,
        "try again; if it keeps failing, check the node's log",
      );
    }
    const token = all.find(([name]) => name === TOKEN_ENV)?.[1];
    if (!token?.trim()) {
      throw new ToolError(
        "failed",
        `There is no 1Password service account token for this work (${TOKEN_ENV}).`,
        "ask your lead: the person whose order this is saves a service account token that can read the item's vault in the app's Settings › Your accounts › 1Password, or a person enters one with request_secret as a project or order variable",
      );
    }
    const vault = { vault: this.vaultFor(token), cache: new Cache() };
    this.sessions.set(id, vault);
    return vault;
  }
}

/** The vault key of an agent session whose browser runs on another machine. */
export const remoteVault = (thread: string) => `remote:${thread}`;

export function unread(reference: string, e: unknown): ToolError {
  const error = e instanceof CredError ? e : new CredError((e as Error).message);
  const fix = error.rateLimited
    ? "try again in a few minutes, once; don't retry in a loop: every machine shares the token's quota"
    : "check the reference (1Password's Copy Secret Reference gives it) and that the service account can read its vault; else ask your lead";
  return new ToolError("failed", `${reference} was not read: ${error.message.replace(/\.+$/, "")}.`, fix);
}

/** An error with every value the session knows scrubbed from it. */
export function scrubbed(session: Session, error: ToolError): ToolError {
  const scrub = session.scrub();
  return new ToolError(error.code, scrub.text(error.message), error.fix === undefined ? undefined : scrub.text(error.fix));
}

/** The fill_credential call's fields, as agent-mcp sends them. */
export type FillCredentialCall = { ref?: unknown; target?: unknown; submit?: unknown };

/**
 * An agent's `fill_credential` in its live session, with the value the agent's machine read from its 1Password
 * (`given`) for a session hosted here, or else read here; either way only into the item's own sites, and sealed from
 * the driver's reads after it.
 */
export async function fillCredential(broker: Broker, thread: string, call: FillCredentialCall, given?: Credential): Promise<{ message: string }> {
  const started = performance.now();
  const reference = String(call.ref ?? "");
  const target = String(call.target ?? "");
  const submit = call.submit !== false;
  const session = broker.live(thread);
  if (!session) throw new ToolError("not_found", "No browser session is open.", "start one with session_start, open the site's login page, then fill");
  if (session.control() === "human") throw new ToolError("invalid", PAUSED, "fill once they hand it back");
  const args = { ref: reference, target, submit };
  const failed = (error: ToolError) => {
    const out = scrubbed(session, error);
    session.stepAt("fill_credential", args, false, out.message, Math.round(performance.now() - started));
    return out;
  };
  let credential: Credential;
  if (given) credential = given;
  else {
    let vault: SessionVault;
    try {
      vault = broker.vault(session);
    } catch (e) {
      throw failed(e as ToolError);
    }
    try {
      credential = await vault.cache.get(vault.vault, reference);
    } catch (e) {
      throw failed(unread(reference, e));
    }
  }
  const sites = credential.urls.map(hostOf).filter((h): h is string => h !== undefined);
  if (sites.length === 0) {
    throw failed(
      new ToolError(
        "forbidden",
        `The 1Password item of ${reference} has no website, so it fills nowhere.`,
        "ask your lead: a person must add the login page's address to the item in 1Password",
      ),
    );
  }
  const allowed = (url: string) => originAllowed(url, credential.urls);
  const page = (await pageUrl(session)) ?? "";
  if (!allowed(page)) {
    throw failed(
      new ToolError(
        "forbidden",
        `${reference} is for ${sites.join(", ")}; this page is on ${hostOf(page) ?? "no website"}.`,
        "open the item's own login page first, then fill",
      ),
    );
  }
  // Sealed before the value is anywhere near the page: from here every answer to the driver is scrubbed of it, and its
  // reads are refused.
  seal(broker, session, reference, credential.value);
  const otp = isOtp(reference);
  try {
    await fill(session, target, credential.value, submit, allowed);
  } catch (e) {
    const error = e as FillError;
    if (!error.typed) session.credentialsFilled -= 1;
    throw failed(
      new ToolError(
        "invalid",
        `${target} was not filled: ${error.message}.`,
        "check the selector with agent-browser snapshot -i; fill a text or password field of the item's own login form",
      ),
    );
  }
  const message = `Filled ${target} from ${reference}${otp ? " (a one-time code)" : ""}${submit ? " and submitted its form" : ""}. This browser session now refuses reading filled values back (agent-browser eval and get value among them) and runs only agent-browser's own scripts; snapshots, clicks, typing and scrolling work as before.`;
  // The page as the fill left it, in the DOM trace; the agent's next command records the one its submit loads.
  session.queueCapture(session.stepAt("fill_credential", args, true, message, Math.round(performance.now() - started)));
  broker.filledMeta(session);
  void broker.report(session, "live");
  return { message: session.scrub().text(message) };
}

/** Seals the session against reading `value` back: scrubbed from all the driver and the agent's transcript see, its
 * reads refused (guard.ts's sealed list, agent-browser's policy). */
export function seal(broker: Broker, session: Session, name: string, value: string): void {
  session.addSecret(name, value);
  broker.credentials.filled(session.threadId, name, value);
  session.credentialsFilled += 1;
  try {
    writePolicy(broker.home, session.threadId, true);
  } catch (e) {
    console.warn(`browser ${session.id}: agent-browser's sealed policy not written: ${(e as Error).message}`);
  }
}

/** The page the session follows, as its target says. */
export async function pageUrl(session: Session): Promise<string | undefined> {
  const page = session.page();
  if (!page) return undefined;
  try {
    const info = await session.cdp.call(undefined, "Target.getTargetInfo", { targetId: page[0] });
    const url = (info.targetInfo as { url?: unknown } | undefined)?.url;
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Why a fill failed, and whether any of the value may have reached the page by then. */
export class FillError extends Error {
  constructor(
    message: string,
    readonly typed: boolean,
  ) {
    super(message);
  }
}

/** What the node reads of the field before it types: whether it takes text, its type, its document's address and its
 * form's. */
const FIELD =
  "function() { const tag = this.tagName.toLowerCase(); const type = (this.type || '').toLowerCase(); const field = tag === 'textarea' || (tag === 'input' && !['hidden','checkbox','radio','submit','button','file','image','reset','color','range'].includes(type)); return { field, type, url: this.ownerDocument.location.href, action: this.form ? this.form.action : '' }; }";

/** Hides what is typed in a field that isn't a password field (a one-time code, a username) from the video and the
 * live view: dots, as a password field shows, and blurred. */
export const HIDE =
  "function() { this.style.setProperty('-webkit-text-security', 'disc', 'important'); this.style.setProperty('filter', 'blur(6px)', 'important'); }";

export const FOCUS = "function() { this.focus(); try { this.select(); } catch (e) {} }";

const SUBMIT = "function() { const f = this.form; if (!f) return false; if (f.requestSubmit) f.requestSubmit(); else f.submit(); return true; }";

const message = (e: unknown) => (e as Error).message;

/**
 * Types `value` into the field `target` (a CSS selector) of the followed page over the node's own connection, then
 * submits its form (or presses Enter in it) when `submit`, so the value sits in the page as briefly as it can. The
 * field's document, and its form's address when it submits, must be `allowed`: checked here, just before typing, so a
 * page that moved since the caller looked gets nothing. The value never passes the proxy.
 */
export async function fill(session: Session, target: string, value: string, submit: boolean, allowed: (url: string) => boolean): Promise<void> {
  let typed = false;
  const fail = (m: string, t: boolean) => new FillError(m, t);
  const page = session.page();
  if (!page) throw fail("the browser has no page", false);
  const [pageTarget, pageSession] = page;
  const call = (method: string, params: Record<string, unknown>) => session.cdp.call(pageSession, method, params);
  let object: unknown;
  let backend: number | undefined;
  try {
    const doc = await call("DOM.getDocument", { depth: 0 });
    const root = (doc.root as { nodeId?: unknown } | undefined)?.nodeId;
    const found = await call("DOM.querySelector", { nodeId: root, selector: target });
    const node = typeof found.nodeId === "number" ? found.nodeId : 0;
    if (node === 0) throw fail(`no field on the page matches ${target}`, false);
    const described = await call("DOM.describeNode", { nodeId: node });
    const b = (described.node as { backendNodeId?: unknown } | undefined)?.backendNodeId;
    backend = typeof b === "number" ? b : undefined;
    const resolved = await call("DOM.resolveNode", { nodeId: node });
    object = (resolved.object as { objectId?: unknown } | undefined)?.objectId;
  } catch (e) {
    throw e instanceof FillError ? e : fail(message(e), false);
  }
  const on = (fn: string) => call("Runtime.callFunctionOn", { objectId: object, functionDeclaration: fn, returnByValue: true });
  let field: { field?: unknown; type?: unknown; url?: unknown; action?: unknown };
  try {
    field = ((await on(FIELD)).result as { value?: typeof field } | undefined)?.value ?? {};
  } catch (e) {
    throw fail(message(e), false);
  }
  if (field.field !== true) throw fail(`${target} is not a text or password field`, false);
  const url = typeof field.url === "string" ? field.url : "";
  if (!allowed(url)) throw fail("the page left the item's website", false);
  const action = typeof field.action === "string" ? field.action : "";
  if (submit && action && !allowed(action)) throw fail(`its form sends to ${hostOf(action) ?? "another address"}, not to the item's website`, false);
  if (field.type !== "password") {
    try {
      await on(HIDE);
    } catch (e) {
      throw fail(message(e), false);
    }
  }
  // From here the driver may not write to this field (filledFieldRefusal).
  if (backend !== undefined) session.filledField(pageTarget, hostOf(url) ?? "", backend);
  try {
    await on(FOCUS);
    typed = true;
    // The one copy of the value the node makes for the page.
    await call("Input.insertText", { text: value });
    if (submit) {
      const submitted = await on(SUBMIT);
      if ((submitted.result as { value?: unknown } | undefined)?.value !== true) {
        for (const type of ["keyDown", "keyUp"]) {
          await call("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
        }
      }
    }
  } catch (e) {
    throw fail(message(e), typed);
  }
}

/** DOM writes to one node, which a sealed session refuses on a field it filled (of these, agent-browser sends only
 * DOM.setFileInputFiles; guard.ts refuses the rest before they get here). */
const NODE_WRITES = ["DOM.setAttributeValue", "DOM.removeAttribute", "DOM.setNodeValue", "DOM.setFileInputFiles"];

/** Whether the driver's `method` writes to one node, which `filledFieldRefusal` checks once the session is sealed. */
export const writesNode = (method: unknown) => typeof method === "string" && NODE_WRITES.includes(method);

/** Why a sealed session refused a write it couldn't place: the node couldn't tell which element it is for. */
export const unplacedWrite = (method: unknown) =>
  `${String(method)} was refused: this browser session filled a login from 1Password, and the node couldn't tell which element this write is for, so it didn't make it. Try again; if it keeps failing, look the element up again (agent-browser snapshot -i).`;

/**
 * Why a session that filled a credential refuses the driver's `command`, if it writes to a field it filled: whatever
 * the attribute, a write there could change how the field validates or shows. The node asks the browser, in the
 * driver's own session, which node the command names; when it can't tell, the write is refused too.
 */
export async function filledFieldRefusal(session: Session, command: { method?: unknown; params?: Record<string, unknown>; sessionId?: unknown }): Promise<string | undefined> {
  const method = typeof command.method === "string" ? command.method : "";
  if (!session.sealed() || !writesNode(method)) return undefined;
  const unknown = unplacedWrite(method);
  const params = command.params ?? {};
  const key = ["nodeId", "backendNodeId", "objectId"].find((k) => params[k] !== undefined && params[k] !== null);
  if (!key) return unknown;
  const driver = typeof command.sessionId === "string" ? command.sessionId : undefined;
  let backend: unknown;
  try {
    const described = await session.cdp.call(driver, "DOM.describeNode", { [key]: params[key] });
    backend = (described.node as { backendNodeId?: unknown } | undefined)?.backendNodeId;
  } catch {
    return unknown;
  }
  if (typeof backend !== "number") return unknown;
  const target = driver === undefined ? undefined : session.driverTarget(driver);
  return session.isFilledField(target, backend)
    ? `${method} is off on this field: this browser session filled it from 1Password, and nothing may change it until the session ends.`
    : undefined;
}

/** A message from the browser on its way to the driver: once the session filled a credential, every form of it
 * (literal, escaped, encoded) is scrubbed first, and a snapshot says nothing of a filled field's value. */
export function outgoing(session: Session, message: Record<string, unknown>): Record<string, unknown> {
  if (!session.sealed()) return message;
  const out = session.scrub().value(message);
  // By the target the answer comes from: a node id names a field only within its own process.
  const target = typeof out.sessionId === "string" ? session.driverTarget(out.sessionId) : undefined;
  for (const holder of [out.result, out.params] as (Record<string, unknown> | undefined)[]) {
    if (holder && Array.isArray(holder.nodes)) redactFilled(session, target, holder.nodes as Record<string, unknown>[]);
  }
  return out;
}

/** What an accessibility tree (agent-browser's snapshots) says of a field the session filled: never its value, nor the
 * text inside it, whatever the value's length. */
function redactFilled(session: Session, target: string | undefined, nodes: Record<string, unknown>[]): void {
  const id = (n: Record<string, unknown>) => (typeof n.nodeId === "string" ? n.nodeId : undefined);
  const fields = new Set(
    nodes.filter((n) => typeof n.backendDOMNodeId === "number" && session.isFilledField(target, n.backendDOMNodeId)).map(id).filter((i) => i !== undefined),
  );
  if (fields.size === 0) return;
  // Everything under a filled field: its text, however deep.
  const inside = new Set<string>();
  for (let before = -1; inside.size !== before; ) {
    before = inside.size;
    for (const n of nodes) {
      const parent = n.parentId;
      const own = id(n);
      if (typeof parent === "string" && own !== undefined && (fields.has(parent) || inside.has(parent))) inside.add(own);
    }
  }
  for (const n of nodes) {
    const own = id(n) ?? "";
    const keys = fields.has(own) ? ["value"] : inside.has(own) ? ["value", "name"] : [];
    for (const key of keys) {
      const v = n[key];
      if (v && typeof v === "object" && !Array.isArray(v)) (v as Record<string, unknown>).value = "***filled***";
    }
  }
}
