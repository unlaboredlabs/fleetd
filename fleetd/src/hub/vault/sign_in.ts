// A sign-in form (request_sign_in, W915): a login page the vault can't fill becomes a secure form in the chat instead of
// a browser takeover.
// - `sign_in_open`, from the node hosting the session (a lead's or a task's): a team vault login on the site holding
//   every asked field answers `vault`, and the node fills it the usual way (vault_fill), with no ask; else the form
//   opens as a secret request with a `fill:` sink, sealed to the hub's own key.
// - the person's box (`secret_submit`, approvals): opened here, checked, sealed again to the node for its fill; once
//   it filled, "Save to Vault" keeps the login in the team vault for that site, as the person's, through saveItem (its
//   audit row and event), so the next sign-in there fills with no ask.
// - settled, a task's form tells the task at once; a lead's wakes it as any request does.
import type { HumanRequest, ProjectRef, SignInField } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { seal } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { approvals } from "../approvals/index.ts";
import { requestOutcome } from "../approvals/outcome.ts";
import type { SignInBy, SignInRelay } from "../approvals/ports.ts";
import {
  fieldsOf,
  loginSpec,
  loginTarget,
  type SaveCandidate,
  saves,
  SIGN_IN_KEY,
  signInCallerRefusal,
  signInCallRefusal,
  type SignInInput,
  signInLabel,
  signInText,
  signInValues,
  vaultLogin,
  vaultTried,
} from "../approvals/sign_in_rules.ts";
import { clip } from "../approvals/text.ts";
import { get as browserSession } from "../browser/store.ts";
import { leadCalls } from "../lead_calls/index.ts";
import type { LeadCall, LeadCaller } from "../lead_calls/types.ts";
import { isProject } from "../project_lead/bridge.ts";
import { steerTasks } from "../steer/index.ts";
import { isoMs } from "../store/time.ts";
import { TaskRecords } from "../tasks/records.ts";
import { hubSealTo } from "./aliases.ts";
import { sessionContext } from "./calls.ts";
import { onSite } from "./fill.ts";
import { vault } from "./index.ts";
import { openToHub, saveItem } from "./items.ts";

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/** `sign_in_open`: the vault's login for the site, or the form opened as a request. */
export function openSignIn(hub: Hub, caller: LeadCaller, call: LeadCall): Record<string, unknown> {
  const r = caller.projectRef;
  const who = signInCallerRefusal(caller.agent.kind, isProject(hub.db.conn, r, false));
  if (who) throw who;
  const { ctx, host, sessionId } = sessionContext(hub, caller, call.sessionId);
  const input = (call.input ?? {}) as SignInInput;
  const bad = signInCallRefusal(input);
  if (bad) throw bad;
  const fields = fieldsOf(input);
  const site = { domain: String(input.site?.domain ?? "").toLowerCase(), name: String(input.site?.name ?? "") };
  const v = vault(hub);
  const a = approvals(hub);
  if (!v.keys.locked && v.problem === undefined) {
    const hit = vaultLogin(v.usable(), site.domain, fields);
    if (hit && !vaultTried(fields, loginGivenIn(hub, r, sessionId, site.domain))) return { vault: { itemId: hit.itemId, label: hit.label } };
  }
  // Asked again for the same fields while the form is still open: the same card.
  const open = a
    .list({ projectRef: r, states: ["open"], limit: 100 })
    .find((q) => q.secureInput?.signIn && q.secureInput.sessionId === sessionId && q.secureInput.site.domain === site.domain && q.secureInput.signIn.fields.join() === fields.join());
  if (open) return { requestId: open.requestId, state: open.state };
  const now = hub.clock.now();
  const opened = a.create({
    projectRef: r,
    ...(ctx.workstreamId !== undefined ? { workstreamId: ctx.workstreamId } : {}),
    kind: "secret",
    text: clip(signInText({ site, why: input.why }, fields), 500),
    secret: { key: SIGN_IN_KEY, sink: `fill:${host}:${sessionId}`, sealTo: hubSealTo(hub) },
    secureInput: {
      site,
      target: input[fields[0]!]!,
      label: signInLabel(site, fields),
      why: input.why,
      sessionId,
      signIn: { fields },
    },
    at: isoMs(now),
    atMs: now,
  });
  return { requestId: opened.requestId, state: opened.state };
}

/** The login fields browser session `sessionId` was given for `domain` already: filled from the vault there, or from a
 * sign-in form the person filled for it (the fields its page showed). */
function loginGivenIn(hub: Hub, r: ProjectRef, sessionId: string, domain: string): Set<SignInField> {
  const given = new Set<SignInField>();
  for (const f of vault(hub).audit.loginFillsIn(sessionId)) if (onSite(f.site, domain)) given.add(f.field as SignInField);
  for (const q of approvals(hub).list({ projectRef: r, states: ["stored"], limit: 100 })) {
    const input = q.secureInput;
    if (input?.signIn === undefined || input.sessionId !== sessionId || input.site.domain !== domain) continue;
    for (const f of input.signIn.fields) if (f !== "otp") given.add(f);
  }
  return given;
}

/** The person's device, as `secret_submit` checked it: operate on the sink's and the project's machines, there only. */
function personCaller(by: SignInBy): Caller {
  return {
    keyId: "secret-submit",
    name: by.name,
    prefix: "",
    kind: "human",
    grants: [{ role: "operate", machines: by.machines }],
    createdAt: new Date(0).toISOString(),
    ...(by.person ? { person: by.person } : {}),
  } as unknown as Caller;
}

/** The person's box: checked, sealed again to the node, and the vault save for once it filled. */
export function relaySignIn(hub: Hub, r: HumanRequest, sealed: string, nodeBox: string, by: SignInBy): SignInRelay {
  const input = r.secureInput;
  if (!input?.signIn) throw new ToolError("invalid", `${r.requestId} is no sign-in form.`);
  const values = signInValues(openToHub(hub, sealed), input.signIn.fields);
  const plain = Buffer.from(JSON.stringify(values), "utf8");
  let forNode: string;
  try {
    forNode = Buffer.from(seal(new Uint8Array(Buffer.from(nodeBox, "base64")), plain)).toString("base64");
  } finally {
    plain.fill(0);
  }
  const site = input.site;
  return {
    forNode,
    save: () => {
      if (!saves(by.save, values)) return {};
      try {
        const vt = vault(hub);
        vt.requireOpen();
        const viewer = vt.viewer(personCaller(by));
        const candidates: SaveCandidate[] = vt
          .usable()
          .filter((row) => row.kind === "login" && (row.meta.sites ?? []).some((s) => s.toLowerCase() === site.domain))
          .map((row) => ({ row, username: vt.store.open(row).username, canEdit: vt.canEdit(viewer, row) }));
        const target = loginTarget(candidates, site.domain, values.username);
        const spec = loginSpec(site, values);
        const row = target !== undefined ? saveItem(hub, viewer, { itemId: target, fields: spec.fields }) : saveItem(hub, viewer, spec);
        return { saved: { itemId: row.itemId, label: row.label } };
      } catch (e) {
        const why = (e as Error).message.replace(/\.+$/, "");
        console.warn(`sign-in ${r.requestId}: not saved to the vault: ${why}`);
        return { notSaved: why };
      }
    },
  };
}

/** A settled form of a task's browser session: the task is told at once (a lead's is woken as any request's). */
export async function signInSettled(hub: Hub, r: HumanRequest): Promise<boolean> {
  const sessionId = r.secureInput?.sessionId;
  const s = sessionId !== undefined ? browserSession(hub, sessionId) : undefined;
  if (!s || s.taskId === undefined || !sameProject(s.projectRef, r.projectRef)) return false;
  const state = TaskRecords.get(hub.db.conn, s.taskId)?.task.state;
  if (state !== "running" && state !== "idle" && state !== "done") return true;
  const { outcome } = requestOutcome(r);
  try {
    await steerTasks(hub).message({ projectRef: r.projectRef, by: r.answeredBy ?? "fleetd" }, s.taskId, `${r.requestId}: ${outcome}`);
  } catch (e) {
    console.warn(`sign-in ${r.requestId}: ${s.taskId} not told: ${(e as Error).message}`);
  }
  return true;
}

export function start(hub: Hub): void {
  leadCalls(hub).register("sign_in_open", (caller, call) => openSignIn(hub, caller, call));
  const hooks = approvals(hub).deps.hooks;
  hooks.signIn = (r, sealed, nodeBox, by) => relaySignIn(hub, r, sealed, nodeBox, by);
  hooks.signInSettled = (r) => signInSettled(hub, r);
}
