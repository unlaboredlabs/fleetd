// A sign-in form's rules and words (request_sign_in), with no store behind them, so the hosted cloud uses the same:
// which fields a call asks for, the card's line, what the opened box must hold, which vault login fills with no ask,
// which one a "Save to Vault" updates, and what the agent hears. sign_in.ts keeps the form as a request.
import type { SecureInputSite, SignInField } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { onAny } from "../vault/fill.ts";
import type { ItemRow } from "../vault/item.ts";
import { clip } from "./text.ts";

/** The key a sign-in form's secret request goes by: never a variable, only a name for the request. */
export const SIGN_IN_KEY = "browser.sign_in";

/** The fields in the order they fill: a two-step page asks for them one call at a time. */
export const SIGN_IN_FIELDS: readonly SignInField[] = ["username", "password", "otp"];

/** A field's longest value: no login or code is longer. */
export const SIGN_IN_VALUE_MAX = 1000;

/** A `request_sign_in` as the node sends it: the site, each field's selector, and why. */
export type SignInInput = { site: SecureInputSite; why: string } & Partial<Record<SignInField, string>>;

/** The fields `input` gives a selector for, in fill order. */
export const fieldsOf = (input: Partial<Record<SignInField, unknown>>): SignInField[] =>
  SIGN_IN_FIELDS.filter((f) => typeof input[f] === "string" && input[f] !== "");

/** Whether the form asks only for a one-time code: the step after a password. */
export const codeOnly = (fields: readonly SignInField[]) => fields.length === 1 && fields[0] === "otp";

/** The card's title: "Sign in to Example", or "Code for Example" for a code alone. */
export const signInLabel = (site: SecureInputSite, fields: readonly SignInField[]) =>
  clip(codeOnly(fields) ? `Code for ${site.name}` : `Sign in to ${site.name}`, 120);

/** The request's line. */
export const signInText = (input: { site: SecureInputSite; why: string }, fields: readonly SignInField[]) =>
  codeOnly(fields)
    ? `Enter the code ${input.site.name} sent you (${input.site.domain}): ${input.why}`
    : `Sign in to ${input.site.name} (${input.site.domain}): ${input.why}`;

/** Why a call opens no form: no field, or not a lead's or task's. */
export function signInCallRefusal(input: Partial<Record<SignInField, unknown>>): ToolError | undefined {
  if (fieldsOf(input).length === 0) {
    return new ToolError("invalid", "Give the selector of at least one field: username, password or otp.", "check them with agent-browser snapshot -i");
  }
  return undefined;
}

/** Who opens a sign-in form: a live bot's lead or one of its tasks. */
export function signInCallerRefusal(kind: string, liveProject: boolean): ToolError | undefined {
  if ((kind !== "lead" && kind !== "task") || !liveProject) {
    return new ToolError("forbidden", "Only a bot's lead or its agents ask for a sign-in, and this session is none.", "tell the person what you wanted to sign in to");
  }
  return undefined;
}

/** What the person's box held, checked: each asked field given, nothing but the three fields, text within bounds. */
export function signInValues(raw: unknown, fields: readonly SignInField[]): Partial<Record<SignInField, string>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError("invalid", "The sign-in form's box isn't a JSON object of fields.");
  const out: Partial<Record<SignInField, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!SIGN_IN_FIELDS.includes(k as SignInField)) throw new ToolError("invalid", `A sign-in form has no field ${k}.`, "Send username, password and otp only.");
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || [...v].length > SIGN_IN_VALUE_MAX || v.includes("\u0000")) {
      throw new ToolError("invalid", `The field ${k} isn't text of at most ${SIGN_IN_VALUE_MAX} characters.`);
    }
    out[k as SignInField] = k === "otp" ? v.trim() : v;
  }
  for (const f of fields) {
    if (out[f] === undefined) throw new ToolError("invalid", `The sign-in form needs the ${f === "otp" ? "code" : f}.`, "Fill it in, then submit again.");
  }
  return out;
}

/** A vault field a sign-in field fills from: a one-time code comes from the login's TOTP secret. */
const vaultField = (f: SignInField) => (f === "otp" ? "totp" : f);

/**
 * The team vault login that fills the form with no ask: on the site, holding every asked field; the most recently
 * changed of several. `rows` are the usable items (any kind).
 */
export function vaultLogin(rows: readonly ItemRow[], domain: string, fields: readonly SignInField[]): ItemRow | undefined {
  return rows
    .filter((r) => r.kind === "login" && r.deletedMs === undefined && onAny(domain, r.meta.sites) && fields.every((f) => r.meta.fields?.includes(vaultField(f))))
    .sort((a, b) => b.updatedMs - a.updatedMs)[0];
}

/**
 * Whether the vault's login is passed over for the person's form: asked again for a login in a browser session that
 * was already given one for the site (filled from the vault, or from a form), the site refused it, so the person is
 * asked, and their "Save to Vault" replaces what was saved. A code alone still fills from the vault.
 */
export const vaultTried = (fields: readonly SignInField[], filledInSession: boolean) => !codeOnly(fields) && filledInSession;

/** A login a "Save to Vault" may update: its username (opened) and whether the person may change it. */
export type SaveCandidate = { row: ItemRow; username: string | undefined; canEdit: boolean };

/**
 * The login "Save to Vault" updates rather than adding another: one the person may change, for exactly this site,
 * with the same username (or none yet). Undefined: save a new one.
 */
export function loginTarget(candidates: readonly SaveCandidate[], domain: string, username: string | undefined): string | undefined {
  const same = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  const mine = candidates.filter((c) => c.canEdit && c.row.kind === "login" && (c.row.meta.sites ?? []).some((s) => s.toLowerCase() === domain));
  return (mine.find((c) => same(c.username, username)) ?? mine.find((c) => c.username === undefined))?.row.itemId;
}

/** The new login a "Save to Vault" makes: the site's name, its host, and what the person gave (never a code). */
export const loginSpec = (site: SecureInputSite, values: Partial<Record<SignInField, string>>) => ({
  kind: "login" as const,
  label: clip(site.name, 120),
  sites: [site.domain],
  fields: { ...(values.username !== undefined ? { username: values.username } : {}), ...(values.password !== undefined ? { password: values.password } : {}) },
});

/** Whether a submit saves: asked to, and it gave a password (a code alone is never kept). */
export const saves = (save: boolean, values: Partial<Record<SignInField, string>>) => save && values.password !== undefined;

/** What the agent hears once the form filled: never a value. */
export function signInFilledLine(fields: readonly SignInField[], site: SecureInputSite, saved: { label: string } | undefined, notSaved: string | undefined): string {
  const what = codeOnly(fields) ? "the code" : "the sign-in";
  const kept = saved ? ` and saved it to the vault as ${saved.label}: the next sign-in there fills by itself` : notSaved ? `; not saved to the vault: ${notSaved}` : "";
  return `The person entered ${what} for ${site.domain}; fleetd filled it and submitted the form${kept}. You never see it. Look at the page: if it now asks for a one-time code, call request_sign_in with otp.`;
}
