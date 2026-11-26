// A login page the vault can't fill (request_sign_in, W915), for a lead's session or a task's: the person gets a secure
// sign-in form in the chat instead of a takeover.
// - `requestSignIn`: on the page, the node checks it is on the site and each field is there, then opens the form on
//   the hub (`sign_in_open`). A vault login for the site answers instead: it fills here at once, field by field, the
//   way fill_credential does (credentials.ts), and nobody is asked. Else the session waits for the person.
// - `deliverSignIn`: the person's fields, sealed by the hub to this node: each typed into its field on that site (the
//   page or its frames), hidden, the session sealed against reading them back first; the last one submits its form.
import { ToolError } from "../../shared/errors.ts";
import { fingerprintOf, parseSecretSink } from "../secrets/sink.ts";
import { CardError, notTyped, WAIT_ON_PERSON_MS } from "./cards.ts";
import { fillCredential, pageUrl, seal } from "./credentials.ts";
import type { BrowserBroker as Broker } from "./broker.ts";
import { hostOf } from "./logins.ts";
import { locate, onSite, type SecretDeliver, type SignInTargets, typeInto, type Waiting, waitingKey } from "./secure_input.ts";
import { PAUSED, type Session } from "./session.ts";
import type { SecretResult } from "../../shared/node_link.ts";

type Field = keyof SignInTargets;
const FIELDS: Field[] = ["username", "password", "otp"];
const SAID: Record<Field, string> = { username: "username", password: "password", otp: "one-time code" };

/** An agent's `request_sign_in`, a lead's or a task's. */
export async function requestSignIn(broker: Broker, thread: string, call: Record<string, unknown>): Promise<{ requestId?: string; message: string }> {
  const session = broker.live(thread);
  if (!session) throw broker.noSession(thread);
  if (session.control() === "human") throw new ToolError("invalid", PAUSED, "ask once they hand it back");
  const site = (call.site ?? {}) as { domain?: unknown; name?: unknown };
  const domain = String(site.domain ?? "").toLowerCase();
  const targets: SignInTargets = {};
  for (const f of FIELDS) if (typeof call[f] === "string" && call[f] !== "") targets[f] = call[f] as string;
  const fields = FIELDS.filter((f) => targets[f] !== undefined);
  if (fields.length === 0) {
    throw new ToolError("invalid", "Give the selector of at least one field: username, password or otp.", "check them with agent-browser snapshot -i");
  }
  const off = await onSite(session, domain);
  if (off) throw new ToolError("forbidden", `Not asked: ${off}.`, "open the sign-in page first, then ask with its own domain");
  for (const f of fields) {
    if (!(await locate(session, targets[f]!, domain))) {
      throw new ToolError("invalid", `No field on the page matches ${targets[f]} (the ${SAID[f]}).`, "check the selector with agent-browser snapshot -i, then ask again");
    }
  }
  const args = { site: domain, fields: fields.join(",") };
  const { op: _op, ...input } = call;
  const opened = await broker.inTurn(session, "sign_in_open", { sessionId: session.id, input });
  const hit = opened.vault as { itemId?: unknown; label?: unknown } | undefined;
  if (hit && typeof hit.itemId === "string") {
    // The vault has it: filled here, field by field, the last one submitting its form; nobody is asked.
    for (const [i, f] of fields.entries()) {
      await fillCredential(broker, thread, { item: hit.itemId, field: f, target: targets[f], submit: i === fields.length - 1 });
    }
    const message = `Filled the ${fields.map((f) => SAID[f]).join(" and ")} from the vault's ${String(hit.label ?? "login")} and submitted the form; nobody was asked. This browser session now refuses reading filled values back. Look at the page: if it asks for a one-time code next, call request_sign_in with otp.`;
    return { message: session.scrub().text(message) };
  }
  const id = String(opened.requestId ?? "");
  const label = `the sign-in for ${domain}`;
  broker.waiting.set(waitingKey(session.id, id), { requestId: id, domain, target: targets[fields[0]!]!, label, signIn: targets });
  session.holdForAnswer(WAIT_ON_PERSON_MS);
  session.stepAt("request_sign_in", args, true, undefined, 0);
  return {
    requestId: id,
    message: `${fields.length === 1 && fields[0] === "otp" ? `Asked the person for the code ${domain} sent them` : `Asked the person to sign in to ${domain}`}, in a secure form (${id}). Stay on this page and end your turn: once they submit it, fleetd fills the ${fields.map((f) => SAID[f]).join(" and ")} and submits the form, and you are woken. You never see what they type; don't ask for it in the chat.`,
  };
}

/** The person's fields from the hub, typed into the waiting form, once; the last field typed submits it. */
export async function deliverSignIn(
  broker: Broker,
  frame: SecretDeliver,
  boxKey: { open(sealed: Uint8Array): Uint8Array | null },
  session: Session,
  key: string,
  waiting: Waiting,
): Promise<SecretResult> {
  const fail = (error: string): SecretResult => ({ id: frame.id, error: [...error].slice(0, 500).join("") });
  broker.waiting.delete(key);
  const giveBack = () => broker.waiting.set(key, waiting);
  if (!parseSecretSink(frame.sink)) {
    giveBack();
    return fail("the sink does not parse");
  }
  const plain = boxKey.open(Buffer.from(frame.sealed, "base64"));
  if (!plain) {
    giveBack();
    return fail("the sign-in was not sealed to this machine's current box key: submit it again");
  }
  let values: Partial<Record<Field, string>>;
  try {
    values = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as Partial<Record<Field, string>>;
  } catch {
    plain.fill(0);
    giveBack();
    return fail("the sign-in is not what the workspace seals");
  }
  const fingerprint = fingerprintOf(plain);
  plain.fill(0);
  const targets = waiting.signIn ?? {};
  const fill = FIELDS.filter((f) => targets[f] !== undefined && typeof values[f] === "string" && values[f] !== "");
  if (fill.length === 0) {
    giveBack();
    return fail("the form gave none of the fields the page asks for");
  }
  const off = await onSite(session, waiting.domain);
  if (off) {
    giveBack();
    return fail(`not filled: ${off}; submit it again once the agent is back on that page`);
  }
  // Sealed before any of it is near the page: every answer to the driver is scrubbed of each value from here.
  for (const f of fill) seal(broker, session, `${waiting.requestId} ${f}`, values[f]!);
  const started = performance.now();
  let typed = false;
  try {
    for (const [i, f] of fill.entries()) {
      await typeInto(session, targets[f]!, waiting.domain, values[f]!, i === fill.length - 1);
      typed = true;
    }
  } catch (e) {
    const error = e instanceof CardError ? e : notTyped((e as Error).message);
    if (!typed && !error.typed) {
      session.credentialsFilled -= fill.length;
      giveBack();
    }
    session.hold(undefined);
    broker.filledMeta(session);
    return fail(`not filled: ${session.scrub().text(error.message)}`);
  }
  session.hold(undefined);
  broker.filledMeta(session);
  void broker.report(session, "live");
  const host = hostOf((await pageUrl(session)) ?? "") ?? waiting.domain;
  // The page as the person's sign-in left it, in the DOM trace (scrubbed of it).
  session.queueCapture(
    session.stepAt("sign_in", { requestId: waiting.requestId, fields: fill.join(",") }, true, `Filled the ${fill.map((f) => SAID[f]).join(" and ")} from the person and submitted the form on ${host}`, Math.round(performance.now() - started)),
  );
  return { id: frame.id, fingerprint };
}
