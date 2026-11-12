// The Vault in the person's words, with no UI, the same rules as the phone's (app/mobile/src/screens/vault/model.ts):
// each kind's fields and checks (a card's number by Luhn and its brand, its expiry as MM/YY, a login's site cut from a
// pasted address, a variable's name by the hub's rule), the one quiet line a row shows ("Visa ••4242", "amazon.com",
// "Germany", "Secret"), which page lists an item, the filter and search, and an audit row in words. Values never come through here
// except as the person types them into a form; the lists hold metadata alone.
import type { VaultAuditEntry, VaultImportCard, VaultItemSummary, VaultKind, VaultListInput } from "../../../shared/contracts";
import { byteLength, nameProblem } from "./projectModel";

/** The hub's app feature that serves the vault: an older hub shows no Vault rows rather than a page that fails. */
export const VAULT_FEATURE = "vault";
export const vaultServed = (features: readonly string[]): boolean => features.includes(VAULT_FEATURE);

/**
 * A hub with the team vault (D492): its "hub" items are the team's, and a "person" item is one set aside for its owner.
 * Without it (an older hub) the Vault page lists what vault_list gives as one list, and adds the same way: a new
 * login, card or address names no place, which that hub keeps as the person's own.
 */
export const TEAM_FEATURE = "vault_team";
export const teamServed = (features: readonly string[]): boolean => features.includes(TEAM_FEATURE);

export const KINDS: readonly VaultKind[] = ["login", "card", "address", "env"];

/** A kind as a filter's word, a row in the + menu, and a form's title. */
export const KIND_WORDS: Readonly<Record<string, { plural: string; one: string }>> = {
  login: { plural: "Logins", one: "Login" },
  card: { plural: "Cards", one: "Card" },
  address: { plural: "Addresses", one: "Address" },
  env: { plural: "Variables", one: "Variable" },
};

export const kindWords = (kind: VaultKind): { plural: string; one: string } => KIND_WORDS[kind] ?? { plural: "Items", one: "Item" };

/** The list's filter: every kind, or one. */
export type Filter = "all" | VaultKind;
/** The team's page filters its logins, cards and addresses; a project's holds only variables, so it has none. */
export const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [{ value: "all", label: "All" }, ...KINDS.filter((k) => k !== "env").map((k) => ({ value: k, label: kindWords(k).plural }))];

/** A Vault page: the team's logins, cards and addresses, or one project's variables (and its orders'). */
export type Whose = { readonly kind: "team" } | { readonly kind: "project"; readonly machineId: string; readonly projectId: string };

/** vault_list's input for a page: everything the person sees for the team's, the project's own for a project's. */
export const listInput = (whose: Whose, trash = false): VaultListInput => {
  const t = trash ? { trash: true } : {};
  return whose.kind === "project" ? { machineId: whose.machineId, projectId: whose.projectId, ...t } : t;
};

/**
 * An item set aside for this person: one of their own from before the team vault, never shared, on a hub with several
 * people, which the hub keeps as "person". Only they list it, nothing fills or gets it, and they move it to the team
 * vault (or a variable to a project, vault_move) or delete it.
 */
export const isSetAside = (item: Pick<VaultItemSummary, "scope">, team: boolean): boolean => team && item.scope === "person";

/** A project's variable or one of its orders'. */
const projectEnv = (item: Pick<VaultItemSummary, "kind" | "scope">): boolean => item.kind === "env" && (item.scope === "project" || item.scope === "order");

/**
 * Whether a listed item belongs on the page: a project's shows its variables and its orders'; the team's every other
 * item. On a hub from before the team vault that is every login, card and address the person sees, and their own
 * variables, so nothing they had goes missing. Items set aside have their own section (SetAsidePart).
 */
export const onPage = (whose: Whose, item: Pick<VaultItemSummary, "kind" | "scope">, team: boolean): boolean =>
  !isSetAside(item, team) && (whose.kind === "project" ? projectEnv(item) : !projectEnv(item));

/**
 * Where a page's new item goes, as vault_save and vault_import take it. A login, card or address names no place: a hub
 * with the team vault keeps it there, and one from before keeps it as the person's own, as its You › Vault did. A
 * variable is the project's.
 */
export const placeOf = (whose: Whose): { scope?: "project"; machineId?: string; projectId?: string } =>
  whose.kind === "project" ? { scope: "project", machineId: whose.machineId, projectId: whose.projectId } : {};

/** The kinds a page adds: the team's logins, cards and addresses; a project's variables. */
export const pageKinds = (whose: Whose): VaultKind[] => (whose.kind === "project" ? ["env"] : ["login", "card", "address"]);

// ——— Cards ———

/** The digits of what was typed or pasted: spaces, dashes and dots dropped. */
export const digits = (text: string): string => text.replace(/[^0-9]/gu, "");

/** The Luhn check every card number passes. */
export const luhn = (number: string): boolean => {
  if (!/^[0-9]{12,19}$/u.test(number)) return false;
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let d = number.charCodeAt(number.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

/** The hub's brand words (vault fields.ts BRAND_NAMES). */
const BRAND_NAMES: Readonly<Record<string, string>> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
};

/** The card's brand from its first digits, as the hub tells it; undefined while it can't tell. */
export const brandOf = (number: string): string | undefined => {
  const n = digits(number);
  if (n.startsWith("4")) return "visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/u.test(n)) return "mastercard";
  if (/^3[47]/u.test(n)) return "amex";
  if (/^(6011|65|64[4-9])/u.test(n)) return "discover";
  if (/^35(2[89]|[3-8])/u.test(n)) return "jcb";
  if (/^3(0[0-5]|[68])/u.test(n)) return "diners";
  if (n.startsWith("62")) return "unionpay";
  return undefined;
};

export const brandName = (brand: string | undefined): string => (brand === undefined ? "Card" : (BRAND_NAMES[brand] ?? "Card"));

/** The number in groups as it's printed on the card: 4-6-5 for Amex, fours for the rest. */
export const groupNumber = (number: string): string => {
  const n = digits(number).slice(0, 19);
  const sizes = brandOf(n) === "amex" ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const out: string[] = [];
  let at = 0;
  for (const size of sizes) {
    if (at >= n.length) break;
    out.push(n.slice(at, at + size));
    at += size;
  }
  return out.join(" ");
};

/** "0428", "04/28", "4/2028" as month and four-digit year; undefined while it isn't one. */
export const parseExpiry = (text: string): { month: string; year: string } | undefined => {
  const t = text.trim();
  const m = /^(\d{1,2})\s*[/\-. ]?\s*(\d{2}|\d{4})$/u.exec(/^\d{4}$/u.test(t) ? `${t.slice(0, 2)}/${t.slice(2)}` : t);
  if (m === null) return undefined;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return undefined;
  const year = m[2] ?? "";
  return { month: String(month).padStart(2, "0"), year: year.length === 2 ? `20${year}` : year };
};

/** Whether a card that runs out at the end of `month`/`year` is past it at `now`. */
export const expired = (month: string, year: string, now: Date): boolean => {
  const y = Number(year.length === 2 ? `20${year}` : year);
  const m = Number(month);
  return y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1);
};

export const cvcOk = (cvc: string, brand: string | undefined): boolean => (brand === "amex" ? /^[0-9]{4}$/u : /^[0-9]{3,4}$/u).test(cvc);

// ——— Logins and addresses ———

/** A site as a host: a pasted address cut to its host, lowercased, with no `www.`; undefined when it isn't one. */
export const hostOf = (text: string): string | undefined => {
  let s = text.trim().toLowerCase();
  if (s === "") return undefined;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//u, "");
  s = s.replace(/^[^@/]*@/u, "");
  s = s.split(/[/?#]/u)[0] ?? "";
  s = s.replace(/:\d+$/u, "").replace(/\.$/u, "").replace(/^www\./u, "");
  // A site with no dot is refused by the hub (vault-design §4.1), so it is here too.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u.test(s)) return undefined;
  return s;
};

/** The sites typed in one field, one per line or comma: each cut to its host, each once. */
export const sitesOf = (text: string): { sites: string[]; bad: string[] } => {
  const sites: string[] = [];
  const bad: string[] = [];
  for (const part of text.split(/[\n,]/u)) {
    if (part.trim() === "") continue;
    const host = hostOf(part);
    if (host === undefined) bad.push(part.trim());
    else if (!sites.includes(host)) sites.push(host);
  }
  return { sites, bad };
};

// ——— Rows ———

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** A region's name for a two-letter country code, or the code when Intl can't name it. */
export const countryName = (code: string): string => {
  if (!/^[A-Za-z]{2}$/u.test(code)) return code;
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

/** An item's sites, from its metadata. */
export const sitesMeta = (item: Pick<VaultItemSummary, "meta">): string[] => item.meta.sites?.filter((x) => typeof x === "string") ?? [];

/** Whether a variable is a secret one (masked, revealed behind Touch ID) or plain (shown as it is). */
export const isSecretEnv = (item: Pick<VaultItemSummary, "kind" | "meta">): boolean => item.kind === "env" && item.meta.secret !== false;

/** The one quiet line under a row's title, from its readable metadata alone. */
export const rowLine = (item: Pick<VaultItemSummary, "kind" | "meta" | "value">): string => {
  switch (item.kind) {
    case "login": {
      const sites = sitesMeta(item);
      return sites.length === 0 ? "No site" : sites.length === 1 ? (sites[0] ?? "") : `${sites[0] ?? ""} +${String(sites.length - 1)}`;
    }
    case "card": {
      const last4 = str(item.meta.last4);
      return [brandName(str(item.meta.brand)), last4 === undefined ? undefined : `••${last4}`].filter((x) => x !== undefined).join(" ");
    }
    case "address": {
      const country = str(item.meta.country);
      return country === undefined ? "Address" : countryName(country);
    }
    case "env":
      return isSecretEnv(item) ? "Secret" : (item.value ?? "");
    default:
      return "";
  }
};

/** An order's variable on its project's page: its order, beside the name. */
export const orderTag = (item: Pick<VaultItemSummary, "scope" | "workstreamId">): string | undefined => (item.scope === "order" ? item.workstreamId : undefined);

/**
 * The title a row shows: a variable by its name, everything else by its label. A `request_secret` sink's variable is
 * named in the hub's own namespace (`sink:<kind>:<key>:<path>`), never shown: its label says it.
 */
export const titleOf = (item: Pick<VaultItemSummary, "kind" | "label" | "envName" | "meta">): string =>
  item.kind === "env" && item.meta.sink === undefined ? (item.envName ?? item.label) : item.label;

/** Whether an item matches what was typed in the search field: its title, its line, its sites. */
export const matches = (item: VaultItemSummary, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return `${titleOf(item)} ${rowLine(item)} ${sitesMeta(item).join(" ")}`.toLowerCase().includes(q);
};

/** The rows a page lists: those of the filter's kind matching the search, by kind, then by title. */
export const shownItems = (items: readonly VaultItemSummary[], filter: Filter, query: string): VaultItemSummary[] =>
  items
    .filter((i) => (filter === "all" || i.kind === filter) && matches(i, query))
    .slice()
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || titleOf(a).localeCompare(titleOf(b)));

// ——— Forms ———

/** Each kind's fields, in the order the item panel shows them, with their words and how they're shown. */
export interface FieldSpec {
  readonly key: string;
  readonly label: string;
  /** Shown as dots until revealed; the rest of a card's or address's fields are sealed too, but show once revealed. */
  readonly masked: boolean;
  /** Typed in a field of several lines. */
  readonly multiline?: boolean;
}

export const FIELDS: Readonly<Record<string, readonly FieldSpec[]>> = {
  login: [
    { key: "username", label: "User name", masked: false },
    { key: "password", label: "Password", masked: true },
    { key: "totp", label: "One-time code seed", masked: true },
    { key: "notes", label: "Notes", masked: true, multiline: true },
  ],
  card: [
    { key: "name", label: "Name on card", masked: false },
    { key: "number", label: "Number", masked: true },
    { key: "expiry", label: "Expires", masked: false },
    { key: "cvc", label: "Security code", masked: true },
  ],
  address: [
    { key: "name", label: "Full name", masked: false },
    { key: "organization", label: "Company", masked: false },
    { key: "line1", label: "Street", masked: false },
    { key: "line2", label: "Apartment, suite", masked: false },
    { key: "postalCode", label: "Postal code", masked: false },
    { key: "city", label: "City", masked: false },
    { key: "region", label: "State or region", masked: false },
    { key: "country", label: "Country", masked: false },
    { key: "phone", label: "Phone", masked: false },
    { key: "email", label: "Email", masked: false },
  ],
  env: [{ key: "value", label: "Value", masked: true, multiline: true }],
};

export const fieldsOf = (kind: VaultKind): readonly FieldSpec[] => FIELDS[kind] ?? [];

/** The fields the hub keeps sealed for a kind: a card's expiry is its month and year. */
export const sealedFields = (kind: VaultKind): string[] => (kind === "card" ? ["name", "number", "month", "year", "cvc"] : fieldsOf(kind).map((f) => f.key));

/** Which sealed fields a shown field opens: a card's expiry is two. */
export const fieldsFor = (kind: VaultKind, key: string): string[] => (kind === "card" && key === "expiry" ? ["month", "year"] : [key]);

/** Which fields the item has, from its metadata (`fields`), when the hub says; else all of its kind's. */
export const presentFields = (item: Pick<VaultItemSummary, "kind" | "meta">): FieldSpec[] => {
  const listed = item.meta.fields;
  if (!Array.isArray(listed)) return [...fieldsOf(item.kind)];
  return fieldsOf(item.kind).filter((f) => fieldsFor(item.kind, f.key).some((k) => (listed as readonly string[]).includes(k)));
};

/** A revealed card's fields as the panel shows them: the number grouped, the expiry as MM/YY. */
export const shownFields = (kind: VaultKind, revealed: Readonly<Record<string, string>>): Record<string, string> => {
  if (kind !== "card") return { ...revealed };
  const { month, year, number, ...rest } = revealed;
  return {
    ...rest,
    ...(number === undefined ? {} : { number: groupNumber(number) }),
    ...(month === undefined || year === undefined ? {} : { expiry: `${month}/${year.slice(-2)}` }),
  };
};

/** A form as the person left it: every field as typed, plus the label, sites and (a variable's) name and secrecy. */
export interface Draft {
  readonly kind: VaultKind;
  readonly label: string;
  readonly sites: string;
  readonly envName: string;
  readonly secret: boolean;
  readonly fields: Readonly<Record<string, string>>;
  /** Sealed fields an edit clears: sent as "", which the hub drops, apart from a field left empty, which stays. */
  readonly cleared: readonly string[];
  /** An edited variable was plain: its form holds its value, so an emptied one is a value. A secret's form doesn't. */
  readonly plainBefore: boolean;
}

export const emptyDraft = (kind: VaultKind): Draft => ({ kind, label: "", sites: "", envName: "", secret: true, fields: {}, cleared: [], plainBefore: false });

/**
 * The fields an edit may clear, each a form field's key: the optional ones. A card's number and expiry, and an
 * address's street, city and country, are only ever replaced; a variable's value is typed again.
 */
export const CLEARABLE: Readonly<Record<string, readonly string[]>> = {
  login: ["username", "password", "totp", "notes"],
  card: ["name", "cvc"],
  address: ["name", "organization", "line2", "postalCode", "region", "phone", "email"],
  env: [],
};

export const clearable = (kind: VaultKind, key: string): boolean => (CLEARABLE[kind] ?? []).includes(key);

/** An item's form to edit: its label, sites and name as they are; its sealed fields empty, as they stay unless typed. */
export const draftOf = (item: VaultItemSummary): Draft => ({
  kind: item.kind,
  label: item.label,
  sites: sitesMeta(item).join("\n"),
  envName: item.kind === "env" ? titleOf(item) : "",
  secret: isSecretEnv(item),
  fields: item.kind === "env" && !isSecretEnv(item) && item.value !== undefined ? { value: item.value } : {},
  cleared: [],
  plainBefore: item.kind === "env" && !isSecretEnv(item),
});

export interface Checked {
  /** What goes to the hub sealed: only the fields typed (an edit merges them into the stored ones). */
  readonly fields: Record<string, string>;
  readonly label: string;
  readonly sites: readonly string[];
  readonly envName?: string;
  readonly secret?: boolean;
}

export type CheckResult = { readonly ok: true; readonly value: Checked } | { readonly ok: false; readonly problem: string };

/**
 * The draft checked: what to send, or the first problem in the person's words. `editing`: an item that has its fields
 * already, so a field left empty stays as it is rather than being required.
 */
export const check = (d: Draft, editing: boolean, now: Date): CheckResult => {
  const f = (k: string) => (d.fields[k] ?? "").trim();
  const fields: Record<string, string> = {};
  const put = (k: string, v: string) => {
    if (v !== "") fields[k] = v;
  };
  let label = d.label.trim();
  const { sites, bad } = sitesOf(d.sites);
  switch (d.kind) {
    case "login": {
      if (bad[0] !== undefined) return { ok: false, problem: `${bad[0]} isn't a website.` };
      if (!editing && sites.length === 0) return { ok: false, problem: "Add the website it signs in to." };
      if (!editing && f("password") === "" && f("username") === "") return { ok: false, problem: "Add a user name or a password." };
      put("username", f("username"));
      // A password is kept exactly as typed: spaces may be part of it.
      const password = d.fields["password"] ?? "";
      if (password !== "") fields["password"] = password;
      put("totp", f("totp").replace(/\s/gu, ""));
      put("notes", f("notes"));
      if (label === "") label = sites[0] ?? "";
      break;
    }
    case "card": {
      const number = digits(f("number"));
      if (number !== "" || !editing) {
        if (!luhn(number)) return { ok: false, problem: "That card number doesn't look right." };
        fields["number"] = number;
      }
      const exp = f("expiry");
      if (exp !== "" || !editing) {
        const e = parseExpiry(exp);
        if (e === undefined) return { ok: false, problem: "Type the expiry as MM/YY." };
        if (expired(e.month, e.year, now)) return { ok: false, problem: "That card has expired." };
        fields["month"] = e.month;
        fields["year"] = e.year;
      }
      const cvc = f("cvc");
      if (cvc !== "" || !editing) {
        if (!cvcOk(cvc, number === "" ? undefined : brandOf(number))) return { ok: false, problem: "The security code is the 3 or 4 digits on the card." };
        fields["cvc"] = cvc;
      }
      put("name", f("name"));
      if (label === "" && !editing) label = `${brandName(brandOf(number))} ••${number.slice(-4)}`;
      break;
    }
    case "address": {
      for (const k of sealedFields("address")) if (k !== "country") put(k, f(k));
      if (f("country") !== "") {
        if (!/^[A-Za-z]{2}$/u.test(f("country"))) return { ok: false, problem: "Type the country as its two-letter code, like DE or US." };
        fields["country"] = f("country").toUpperCase();
      }
      if (!editing && (f("line1") === "" || f("city") === "" || f("country") === "")) return { ok: false, problem: "Add the street, city and country." };
      if (bad[0] !== undefined) return { ok: false, problem: `${bad[0]} isn't a website.` };
      if (label === "" && !editing) label = "Home";
      break;
    }
    case "env": {
      const name = d.envName.trim();
      if (!editing) {
        const why = nameProblem(name);
        if (why !== null) return { ok: false, problem: why };
        if (name.length > VAULT_LABEL_MAX) return { ok: false, problem: `A variable's name is up to ${String(VAULT_LABEL_MAX)} characters here.` };
      }
      // A value is kept exactly as typed, but the empty one means "unchanged" on an edit of a secret.
      const value = d.fields["value"] ?? "";
      if (!editing && d.secret && value === "") return { ok: false, problem: "Type or paste the value." };
      if (byteLength(value) > 64 * 1024) return { ok: false, problem: "A value is at most 64 KiB." };
      if (value.includes("\u0000")) return { ok: false, problem: "A value can't hold a NUL character." };
      // A value typed is sent. Empty: a new plain variable's, or an emptied plain one's, is its value. An edited secret's
      // form never held its value, so empty there keeps it, even when the edit makes it plain: "" would clear it.
      if (value !== "" || (!d.secret && (!editing || d.plainBefore))) fields["value"] = value;
      return { ok: true, value: { fields, label: name || label, sites: [], ...(editing ? {} : { envName: name }), secret: d.secret } };
    }
  }
  if (label === "") return { ok: false, problem: "Give it a name." };
  if (label.length > VAULT_LABEL_MAX) return { ok: false, problem: `A name is up to ${String(VAULT_LABEL_MAX)} characters.` };
  // Cleared on an edit: "" tells the hub to drop the field, where a field left out stays as it is.
  if (editing) for (const k of d.cleared) if (clearable(d.kind, k)) fields[k] = "";
  return { ok: true, value: { fields, label, sites } };
};

/** The hub's longest label (vault fields.ts LABEL_MAX). */
export const VAULT_LABEL_MAX = 120;

/** How long a revealed value stays on screen, and the clipboard keeps a copied one (main/vault.ts empties it). */
export const REVEAL_MS = 30_000;
export const CLIPBOARD_MS = 60_000;

// ——— Activity ———

const ACTION_WORDS: Readonly<Record<string, string>> = {
  fill: "Filled",
  fill_refused: "Fill refused",
  inject: "Given to an agent",
  deliver: "Sent to a machine",
  reveal: "Shown",
  create: "Added",
  update: "Changed",
  delete: "Deleted",
  restore: "Restored",
  share: "Sharing changed",
  import: "Imported from 1Password",
  purchase: "Paid",
  rotate: "Key rotated",
  unlock: "Vault unlocked",
  adopt: "Moved into the vault",
};

const sentence = (s: string): string => (s === "" ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`);

/** One audit row in words: what happened, then where and by whom. Never a value. */
export const auditLine = (e: VaultAuditEntry, projectName: (machineId: string, projectId: string) => string | undefined): { title: string; detail: string | undefined } => {
  const data = e.data;
  const what = ACTION_WORDS[e.action] ?? sentence(e.action.replace(/_/gu, " "));
  const title = e.outcome === "failed" ? `${what}: failed` : e.outcome === "pending" ? `${what}…` : what;
  const project = e.machineId === undefined || e.projectId === undefined ? undefined : projectName(e.machineId, e.projectId);
  const by = str(data.by)?.replace(/^human:/u, "");
  const field = data.fields?.length === 1 ? data.fields[0] : undefined;
  const why = e.outcome === "refused" || e.outcome === "failed" ? str(data.message) : undefined;
  const parts = [str(data.site), field, project, e.taskId ?? by, why];
  const detail = parts.filter((x) => x !== undefined && x !== "").join(" · ");
  return { title, detail: detail === "" ? undefined : detail };
};

/** How a lead's import proposal went, as the line its card leaves in the chat; undefined while it's open. */
export const importOutcome = (card: Pick<VaultImportCard, "state" | "imported">): string | undefined => {
  if (card.state === "open") return undefined;
  if (card.state === "dismissed") return "Not imported";
  const n = card.imported;
  return n === undefined ? "Imported into the vault" : `Imported ${String(n)} ${n === 1 ? "item" : "items"} into the vault`;
};

/** The hub's reasons a vault call failed, in the person's words; undefined for any other. */
export const vaultErrorWords = (e: { readonly reason?: string | undefined }): string | undefined => {
  if (e.reason === "vault_locked") return "The vault is locked. Unlock it under Settings › You › Vault.";
  if (e.reason === "vault_rate_limited") return "Too many reveals in the last hour. Try again later.";
  if (e.reason === "vault_key_missing") return "The vault's key is missing on the hub. An owner restores it with the recovery code (fleetd vault restore-key).";
  return undefined;
};
