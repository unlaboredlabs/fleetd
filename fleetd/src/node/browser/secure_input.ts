// A Navi's secure input in its browser (crates/fleetd/src/node/browser/secure_input.rs): something only the person
// may give.
// - `request`: on the page, the node checks it is on the site and the field is there (in the page or one of the
//   site's own frames), then opens the request on the hub. Typed by the person, the session waits for it.
// - `deliver`: the sealed value for a `fill:` sink, from the link: opened here, the session sealed as a login fill
//   seals it (credentials.ts), and typed into the field on that site, once.
// - `fillApproved`: a 1Password field (an Identity, Passport, Driver License or Social Security item's), once the
//   person approved it: claimed on the hub, read with the session's token and typed in the same way.
import { ToolError } from "../../shared/errors.ts";
import type { SecretDeliver, SecretResult } from "../wire.ts";
import { fingerprintOf } from "../secrets/files.ts";
import { parseSecretSink } from "../secrets/index.ts";
import { CardError, docs, FILL_WINDOW_MINUTES, naviSession, notTyped, onDomain, oneLine, WAIT_ON_PERSON_MS } from "./cards.ts";
import { FOCUS, HIDE, pageUrl, scrubbed, seal } from "./credentials.ts";
import type { Broker } from "./index.ts";
import { hostOf } from "./onepassword.ts";
import type { Session } from "./session.ts";

/** A typed secure input its session waits for: where it fills. */
export type Waiting = { requestId: string; domain: string; target: string; label: string };

/** Where a typed secure input waits: by its browser session and its request, as a session may wait for several. */
export const waitingKey = (session: string, request: string) => `${session}/${request}`;

/** The session's page, or why the value can't go there. */
async function onSite(session: Session, domain: string): Promise<string | undefined> {
  const host = hostOf((await pageUrl(session)) ?? "") ?? "";
  return onDomain(host, domain) ? undefined : `the page is on ${host || "no website"}, not ${domain}`;
}

/** The field `target` matches in the page or one of its frames on `domain`: its document's CDP session, its browser
 * target and the field's object. */
async function locate(session: Session, target: string, domain: string): Promise<{ via: string; inTarget: string; object: string } | undefined> {
  const page = session.page();
  if (!page) return undefined;
  const allowed = (url: string) => {
    const h = hostOf(url);
    return h !== undefined && onDomain(h, domain);
  };
  for (const doc of await docs(session, page[0], page[1], allowed)) {
    try {
      const world = await session.cdp.call(doc.session, "Page.createIsolatedWorld", { frameId: doc.frame, worldName: "fleetd input" });
      const context = world.executionContextId;
      if (typeof context !== "number") continue;
      const found = await session.cdp.call(doc.session, "Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(target)})`,
        contextId: context,
        returnByValue: false,
      });
      const object = (found.result as { objectId?: unknown } | undefined)?.objectId;
      if (typeof object === "string") return { via: doc.session, inTarget: doc.target, object };
    } catch {}
  }
  return undefined;
}

/** What the node reads of the field before it types: whether it takes text and its document's address. */
const FIELD =
  "function() { const tag = this.tagName.toLowerCase(); const type = (this.type || '').toLowerCase(); const field = tag === 'textarea' || (tag === 'input' && !['hidden','checkbox','radio','submit','button','file','image','reset','color','range'].includes(type)); return { field, url: this.ownerDocument.location.href }; }";

/** Types `value` into the field `target` matches on `domain` (the page or one of its frames), over the node's own
 * connection, hidden as it is typed. The session must be sealed first. */
async function typeInto(session: Session, target: string, domain: string, value: string): Promise<void> {
  const found = await locate(session, target, domain);
  if (!found) throw notTyped(`no field on the page matches ${target}`);
  const { via, inTarget, object } = found;
  const on = (fn: string) => session.cdp.call(via, "Runtime.callFunctionOn", { objectId: object, functionDeclaration: fn, returnByValue: true });
  let about: { field?: unknown; url?: unknown };
  try {
    about = ((await on(FIELD)).result as { value?: typeof about } | undefined)?.value ?? {};
  } catch (e) {
    throw notTyped((e as Error).message);
  }
  if (about.field !== true) throw notTyped(`${target} is not a text field`);
  const url = typeof about.url === "string" ? about.url : "";
  const host = hostOf(url);
  if (host === undefined || !onDomain(host, domain)) throw notTyped(`${target} is in a frame off ${domain}`);
  try {
    const described = await session.cdp.call(via, "DOM.describeNode", { objectId: object });
    const backend = (described.node as { backendNodeId?: unknown } | undefined)?.backendNodeId;
    if (typeof backend === "number") session.filledField(inTarget, host, backend);
  } catch {}
  try {
    await on(HIDE);
    await on(FOCUS);
  } catch (e) {
    throw notTyped((e as Error).message);
  }
  // The one copy of the value the node makes for the page.
  try {
    await session.cdp.call(via, "Input.insertText", { text: value });
  } catch (e) {
    const page = session.page()?.[1];
    if (page === undefined || page === via) throw new CardError((e as Error).message, true);
    try {
      await session.cdp.call(page, "Input.insertText", { text: value });
    } catch (again) {
      throw new CardError((again as Error).message, true);
    }
  }
}

/** An agent's `request_secure_input`. */
export async function request(broker: Broker, thread: string, call: Record<string, unknown>): Promise<{ requestId: string; message: string }> {
  const session = naviSession(broker, thread);
  const domain = String((call.site as { domain?: unknown } | undefined)?.domain ?? "");
  const off = await onSite(session, domain);
  if (off) throw new ToolError("forbidden", `Not asked: ${off}.`, "open the page with the field first, then ask with its own domain");
  const target = String(call.target ?? "");
  if (!(await locate(session, target, domain))) {
    throw new ToolError("invalid", `No field on the page matches ${target}.`, "check the selector with agent-browser snapshot -i, then ask again");
  }
  const typed = call.ref === undefined || call.ref === null;
  const label = String(call.label ?? "");
  const args = { site: domain, label, target };
  const { op: _op, ...input } = call;
  const opened = await broker.inTurn(session, "secure_input_open", { sessionId: session.id, input });
  const id = String(opened.requestId ?? "");
  if (typed) broker.waiting.set(waitingKey(session.id, id), { requestId: id, domain, target, label });
  const filledNow = opened.state === "approved";
  if (!filledNow) session.holdForAnswer(WAIT_ON_PERSON_MS);
  session.stepAt("request_secure_input", args, true, undefined, 0);
  const message = filledNow
    ? // A hub from D310 on fills a 1Password field with no ask.
      `Ready to fill ${label} from 1Password (${id}): call secure_input_fill with requestId ${id} now, within ${FILL_WINDOW_MINUTES} minutes.`
    : typed
      ? `Asked the person to type ${label} (${id}) in a sealed field. Stay on this page and end your turn: once they do, fleetd types it into ${target} and you are woken. You never see it; don't ask for it in the chat.`
      : `Asked the person to approve filling ${label} from 1Password (${id}). Stay on this page and end your turn. Approved, call secure_input_fill with requestId ${id} within ${FILL_WINDOW_MINUTES} minutes.`;
  return { requestId: id, message };
}

/** The sealed value of a `fill:` sink, from the hub: typed into its session's waiting field, once. */
export async function deliver(
  broker: Broker,
  frame: SecretDeliver,
  boxKey: { open(sealed: Uint8Array): Uint8Array | null } | undefined,
  machine: string,
): Promise<SecretResult> {
  const fail = (error: string): SecretResult => ({ id: frame.id, error: [...error].slice(0, 500).join("") });
  const sink = parseSecretSink(frame.sink);
  if (!sink || sink.kind !== "fill") return fail("the sink does not parse");
  if (sink.machineId !== machine) return fail(`the sink is on ${sink.machineId}, not on ${machine}`);
  if (!boxKey) return fail("this node takes no secrets: it has no box key");
  const session = broker.byId(sink.path);
  if (!session) return fail("that browser session has ended: ask the lead to open the page and ask again");
  const requestId = (frame as { requestId?: unknown }).requestId;
  if (typeof requestId !== "string") return fail("the hub didn't say which secure input this is: update fleetd on the hub");
  const key = waitingKey(sink.path, requestId);
  const waiting = broker.waiting.get(key);
  if (!waiting) return fail(`nothing waits for ${requestId} in that browser session: it was filled already`);
  broker.waiting.delete(key);
  const giveBack = () => broker.waiting.set(key, waiting);
  const plain = boxKey.open(Buffer.from(frame.sealed, "base64"));
  if (!plain) {
    giveBack();
    return fail("the value was not sealed to this machine's current box key: seal it again");
  }
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    plain.fill(0);
    giveBack();
    return fail("the value is not text");
  }
  const fingerprint = fingerprintOf(plain);
  plain.fill(0);
  const off = await onSite(session, waiting.domain);
  if (off) {
    giveBack();
    return fail(`not filled: ${off}; enter it again once the lead is back on that page`);
  }
  seal(broker, session, `${waiting.requestId} ${waiting.label}`, value);
  const started = performance.now();
  try {
    await typeInto(session, waiting.target, waiting.domain, value);
  } catch (e) {
    const error = e instanceof CardError ? e : notTyped((e as Error).message);
    if (!error.typed) {
      session.credentialsFilled -= 1;
      giveBack();
    }
    session.hold(undefined);
    broker.filledMeta(session);
    return fail(`not filled: ${session.scrub().text(error.message)}`);
  }
  session.hold(undefined);
  broker.filledMeta(session);
  // The page as the person's value left it, in the DOM trace (scrubbed of it).
  session.queueCapture(
    session.stepAt(
      "secure_input",
      { requestId: waiting.requestId, target: waiting.target },
      true,
      `Filled ${waiting.label} from the person`,
      Math.round(performance.now() - started),
    ),
  );
  return { id: frame.id, fingerprint };
}

/** An agent's `secure_input_fill`: an approved 1Password field, typed into the page. */
export async function fillApproved(broker: Broker, thread: string, call: Record<string, unknown>): Promise<{ message: string }> {
  const started = performance.now();
  const session = naviSession(broker, thread);
  const id = String(call.requestId ?? "");
  const args = { requestId: id };
  const failed = (error: ToolError) => {
    const out = scrubbed(session, error);
    session.stepAt("secure_input_fill", args, false, out.message, Math.round(performance.now() - started));
    return out;
  };
  let claimed: Record<string, unknown>;
  try {
    claimed = await broker.inTurn(session, "secure_input_claim", { requestId: id, sessionId: session.id });
  } catch (e) {
    throw failed(e instanceof ToolError ? e : new ToolError("failed", (e as Error).message));
  }
  const domain = String(claimed.domain ?? "");
  const target = String(claimed.target ?? "");
  const reference = String(claimed.ref ?? "");
  let error: CardError | undefined;
  try {
    const off = await onSite(session, domain);
    if (off) throw notTyped(off);
    let vault;
    try {
      vault = broker.vault(session);
    } catch (e) {
      throw notTyped((e as Error).message.replace(/\.+$/, ""));
    }
    if (!vault.vault.identity) throw notTyped(`${reference} was not read: ${reference} can't be read as an identity here`);
    const read = await vault.vault.identity(reference).catch((e: Error) => {
      throw notTyped(`${reference} was not read: ${e.message.replace(/\.+$/, "")}`);
    });
    seal(broker, session, reference, read.value);
    try {
      await typeInto(session, target, domain, read.value);
    } catch (e) {
      if (e instanceof CardError && !e.typed) session.credentialsFilled -= 1;
      throw e;
    }
  } catch (e) {
    error = e instanceof CardError ? e : notTyped((e as Error).message);
  }
  try {
    await broker.inTurn(session, "secure_input_filled", {
      requestId: id,
      ok: !error,
      typed: !error || error.typed,
      message: oneLine(session.scrub().text(error ? error.message : `filled ${target}`)),
    });
  } catch (e) {
    console.warn(`browser ${session.id}: secure input ${id}'s fill was not reported: ${(e as Error).message}`);
  }
  session.hold(undefined);
  broker.filledMeta(session);
  if (error) {
    throw failed(
      new ToolError(
        "invalid",
        `${target} was not filled: ${error.message}.`,
        error.typed ? "part of it may be in the page: tell the person" : "nothing was typed: open that page and call secure_input_fill again within the window",
      ),
    );
  }
  const message = `Filled ${target} from 1Password; this browser session now refuses reading it back. Carry on with the page.`;
  // The page as the fill left it, in the DOM trace (scrubbed of the value).
  session.queueCapture(session.stepAt("secure_input_fill", args, true, message, Math.round(performance.now() - started)));
  return { message: session.scrub().text(message) };
}
