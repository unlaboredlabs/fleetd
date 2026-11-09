// The phone's Vault in the person's words, with no UI: each kind's fields and checks (a card's number by Luhn and its
// brand, its expiry as MM/YY, a login's site cut from a pasted address, a variable's name by the hub's rule), the one
// quiet line a row shows ("Visa ••4242", "amazon.com", "Berlin, DE", "STRIPE_KEY · secret"), the scope tag, and the
// list's sections and search. Values never come through here except as the person types them into a form; the lists
// hold metadata alone.
import type { HubState } from "../../desktop";
import type { VaultAuditEntry, VaultImportCard, VaultItemSummary, VaultKind, VaultScope } from "./types";

/** Whether the hub has a vault: an older one shows no Vault rows rather than a screen that fails. */
export const vaultShown = (hub: HubState): boolean => hub.phase === "live" && hub.features?.includes("vault") === true;

export const KINDS: readonly VaultKind[] = ["login", "card", "address", "env"];

/** A kind as a section's header, a row in the + menu, and a screen's title. */
export const KIND_WORDS: Readonly<Record<VaultKind, { plural: string; one: string }>> = {
  login: { plural: "Logins", one: "Login" },
  card: { plural: "Cards", one: "Card" },
  address: { plural: "Addresses", one: "Address" },
  env: { plural: "Variables", one: "Variable" },
};

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

export type Brand = "Visa" | "Mastercard" | "Amex" | "Discover" | "Diners" | "JCB" | "UnionPay" | "Maestro";

/** The card's brand from its first digits, as far as they go; undefined while it can't tell. */
export const brandOf = (number: string): Brand | undefined => {
  const n = digits(number);
  const head = (k: number) => Number(n.slice(0, k));
  if (n.startsWith("4")) return "Visa";
  if (/^3[47]/u.test(n)) return "Amex";
  if ((head(2) >= 51 && head(2) <= 55) || (n.length >= 4 && head(4) >= 2221 && head(4) <= 2720)) return "Mastercard";
  if (/^(6011|65|64[4-9])/u.test(n)) return "Discover";
  if (/^(36|38|30[0-5])/u.test(n)) return "Diners";
  if (/^35(2[89]|[3-8])/u.test(n)) return "JCB";
  if (n.startsWith("62")) return "UnionPay";
  if (/^(5[06-9]|6[0-9])/u.test(n)) return "Maestro";
  return undefined;
};

/** The number in groups as it's printed on the card: 4-6-5 for Amex, fours for the rest. */
export const groupNumber = (number: string): string => {
  const n = digits(number).slice(0, 19);
  const sizes = brandOf(n) === "Amex" ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const out: string[] = [];
  let at = 0;
  for (const size of sizes) {
    if (at >= n.length) break;
    out.push(n.slice(at, at + size));
    at += size;
  }
  return out.join(" ");
};

/** "0428", "04/28", "4/2028" as month and two-digit year; undefined while it isn't one. */
export const parseExpiry = (text: string): { month: string; year: string } | undefined => {
  const m = /^\s*(\d{1,2})\s*[/\-. ]?\s*(\d{2}|\d{4})\s*$/u.exec(text.length === 4 && /^\d{4}$/u.test(text) ? `${text.slice(0, 2)}/${text.slice(2)}` : text);
  if (m === null) return undefined;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return undefined;
  return { month: String(month).padStart(2, "0"), year: m[2]!.slice(-2) };
};

/** What the expiry field shows while it's typed: the slash put in after the month. */
export const typeExpiry = (text: string, before: string): string => {
  const d = digits(text).slice(0, 4);
  // A backspace over the slash takes the month's last digit with it.
  if (text.length < before.length && before.endsWith("/") && !text.includes("/")) return d.slice(0, 1);
  if (d.length === 1 && Number(d) > 1) return `0${d}/`;
  return d.length >= 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
};

/** Whether a card that runs out at the end of `month`/`year` (YY) is still good at `now`. */
export const expired = (month: string, year: string, now: Date): boolean => {
  const y = 2000 + Number(year);
  const m = Number(month);
  return y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1);
};

export const cvcOk = (cvc: string, brand: Brand | undefined): boolean => (brand === "Amex" ? /^[0-9]{4}$/u : /^[0-9]{3,4}$/u).test(cvc);

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

// ——— Variables ———

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
/** What the node and claude set themselves: the hub refuses them (envNameReserved). */
const RESERVED = ["HOME", "PATH", "USER", "TMPDIR", "TMP", "TEMP"];
const RESERVED_PREFIX = ["FLEETD_", "ANTHROPIC_", "CLAUDE"];
export const ENV_VALUE_MAX_BYTES = 64 * 1024;

/** Why a variable's name won't do, in the person's words; undefined when it will. */
export const envNameProblem = (name: string): string | undefined => {
  if (name === "") return undefined;
  if (!ENV_NAME.test(name)) return "Letters, digits and _ only, not starting with a digit.";
  if (RESERVED.includes(name) || RESERVED_PREFIX.some((p) => name.startsWith(p))) return `fleetd sets ${name} itself.`;
  return undefined;
};

/** UTF-8 bytes of a string, without TextEncoder (Hermes may lack it). */
export const utf8Bytes = (text: string): number => {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
};

/** `KEY=value` lines of a pasted .env: comments and blanks skipped, `export ` and one pair of quotes taken off. */
export const parseDotenv = (text: string): { vars: Array<{ name: string; value: string }>; bad: number } => {
  const vars: Array<{ name: string; value: string }> = [];
  let bad = 0;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/u.exec(line);
    if (m === null || envNameProblem(m[1]!) !== undefined) {
      bad++;
      continue;
    }
    let value = m[2]!;
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
    const at = vars.findIndex((v) => v.name === m[1]);
    if (at >= 0) vars.splice(at, 1);
    vars.push({ name: m[1]!, value });
  }
  return { vars, bad };
};

// ——— Rows ———

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** A region's name for a two-letter country code, or the code when Intl can't name it. */
const countryName = (code: string): string => {
  try {
    const names = new Intl.DisplayNames(undefined, { type: "region" });
    return names.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

/** The one quiet line under a row's label, from its readable metadata alone. */
export const rowLine = (item: Pick<VaultItemSummary, "kind" | "meta" | "envName">): string => {
  const meta = item.meta as Record<string, unknown>;
  switch (item.kind) {
    case "login": {
      const sites = Array.isArray(meta.sites) ? meta.sites.filter((s): s is string => typeof s === "string") : [];
      return sites.length === 0 ? "No site" : sites.length === 1 ? sites[0]! : `${sites[0]!} +${String(sites.length - 1)}`;
    }
    case "card": {
      const last4 = str(meta.last4);
      return [str(meta.brand) ?? "Card", last4 === undefined ? undefined : `••${last4}`].filter((x) => x !== undefined).join(" ");
    }
    case "address": {
      const city = str(meta.city);
      const country = str(meta.country);
      if (country === undefined) return city ?? "Address";
      return city === undefined ? countryName(country) : `${city}, ${country}`;
    }
    case "env":
      return meta.secret === true ? "Secret" : "Plain";
  }
};

/** Where an item may be used, when it isn't only its owner's work: a project's name, or Everyone for the hub's. */
export const scopeTag = (item: Pick<VaultItemSummary, "scope" | "machineId" | "projectId" | "sharedWith">, projectName: (machineId: string, projectId: string) => string | undefined): string | undefined => {
  const shared = item.sharedWith?.length ?? 0;
  switch (item.scope) {
    case "hub":
      return "Everyone";
    case "project":
    case "order":
      return item.machineId === undefined || item.projectId === undefined ? "Project" : (projectName(item.machineId, item.projectId) ?? "Project");
    case "person":
      if (shared === 0) return undefined;
      if (shared === 1) {
        const p = item.sharedWith![0]!;
        return projectName(p.machineId, p.projectId) ?? "1 project";
      }
      return `${String(shared)} projects`;
  }
};

export const SCOPE_WORDS: Readonly<Record<VaultScope, string>> = {
  person: "Only your work",
  project: "This project",
  order: "This order",
  hub: "Every project",
};

/** The title a row shows: a variable by its name, everything else by its label. */
export const titleOf = (item: Pick<VaultItemSummary, "kind" | "label" | "envName">): string => (item.kind === "env" ? (item.envName ?? item.label) : item.label);

/** Whether an item matches what was typed in the search bar: its title, its line, its sites. */
export const matches = (item: VaultItemSummary, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const meta = item.meta as Record<string, unknown>;
  const sites = Array.isArray(meta.sites) ? meta.sites.join(" ") : "";
  return `${titleOf(item)} ${rowLine(item)} ${sites}`.toLowerCase().includes(q);
};

export interface Section {
  readonly kind: VaultKind;
  readonly header: string;
  readonly items: readonly VaultItemSummary[];
}

/** The list's sections, one per kind that has items matching the search, each sorted by title. */
export const sections = (items: readonly VaultItemSummary[], query: string): Section[] =>
  KINDS.map((kind) => ({
    kind,
    header: KIND_WORDS[kind].plural,
    items: items
      .filter((i) => i.kind === kind && i.deletedMs === undefined && matches(i, query))
      .slice()
      .sort((a, b) => titleOf(a).localeCompare(titleOf(b))),
  })).filter((s) => s.items.length > 0);

// ——— Forms ———

/** Each kind's secret fields, in the order the item screen shows them, with their words and how they're shown. */
export interface FieldSpec {
  readonly key: string;
  readonly label: string;
  /** Shown as dots until revealed. Plain fields of a card or address are still sealed, so revealed too. */
  readonly masked: boolean;
}

export const FIELDS: Readonly<Record<VaultKind, readonly FieldSpec[]>> = {
  login: [
    { key: "username", label: "User name", masked: false },
    { key: "password", label: "Password", masked: true },
    { key: "totp", label: "Verification code", masked: true },
    { key: "notes", label: "Notes", masked: true },
  ],
  card: [
    { key: "name", label: "Name on card", masked: false },
    { key: "number", label: "Number", masked: true },
    { key: "expiry", label: "Expires", masked: false },
    { key: "cvc", label: "Security code", masked: true },
  ],
  address: [
    { key: "name", label: "Name", masked: false },
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
  env: [{ key: "value", label: "Value", masked: true }],
};

/** The fields the hub keeps sealed for a kind: a card's expiry is its month and year. */
export const sealedFields = (kind: VaultKind): string[] => (kind === "card" ? ["name", "number", "month", "year", "cvc"] : FIELDS[kind].map((f) => f.key));

/** A form as the person left it: every field as typed, plus the label, sites and (a variable's) name and secrecy. */
export interface Draft {
  readonly kind: VaultKind;
  readonly label: string;
  readonly sites: string;
  readonly envName: string;
  readonly secret: boolean;
  readonly fields: Readonly<Record<string, string>>;
}

export const emptyDraft = (kind: VaultKind): Draft => ({ kind, label: "", sites: "", envName: "", secret: true, fields: {} });

export interface Checked {
  /** What goes to the hub sealed: only the fields typed (an edit merges them into the stored ones). */
  readonly secret: Record<string, string>;
  /** The readable part. */
  readonly label: string;
  readonly sites: readonly string[];
  readonly envName?: string;
  readonly secretEnv?: boolean;
}

/**
 * The draft checked: what to send, or the first problem in the person's words. `editing`: an item that has its fields
 * already, so a field left empty stays as it is rather than being required.
 */
export const check = (d: Draft, editing: boolean, now: Date): { ok: true; value: Checked } | { ok: false; problem: string } => {
  const f = (k: string) => (d.fields[k] ?? "").trim();
  const secret: Record<string, string> = {};
  const put = (k: string, v: string) => {
    if (v !== "") secret[k] = v;
  };
  let label = d.label.trim();
  const { sites, bad } = sitesOf(d.sites);
  switch (d.kind) {
    case "login": {
      if (bad.length > 0) return { ok: false, problem: `${bad[0]!} isn't a website.` };
      if (!editing && sites.length === 0) return { ok: false, problem: "Add the website it signs in to." };
      if (!editing && f("password") === "" && f("username") === "") return { ok: false, problem: "Add a user name or a password." };
      put("username", f("username"));
      // A password is kept exactly as typed: spaces may be part of it.
      if ((d.fields.password ?? "") !== "") secret.password = d.fields.password!;
      put("totp", f("totp").replace(/\s/gu, ""));
      put("notes", f("notes"));
      if (label === "") label = sites[0] ?? "";
      break;
    }
    case "card": {
      const number = digits(f("number"));
      if (number !== "" || !editing) {
        if (!luhn(number)) return { ok: false, problem: "That card number doesn't look right." };
        secret.number = number;
      }
      const exp = f("expiry");
      if (exp !== "" || !editing) {
        const e = parseExpiry(exp);
        if (e === undefined) return { ok: false, problem: "Type the expiry as MM/YY." };
        if (expired(e.month, e.year, now)) return { ok: false, problem: "That card has expired." };
        secret.month = e.month;
        secret.year = e.year;
      }
      const cvc = f("cvc");
      if (cvc !== "" || !editing) {
        if (!cvcOk(cvc, number === "" ? undefined : brandOf(number))) return { ok: false, problem: "The security code is the 3 or 4 digits on the card." };
        secret.cvc = cvc;
      }
      put("name", f("name"));
      if (label === "" && !editing) label = `${brandOf(number) ?? "Card"} ••${number.slice(-4)}`;
      break;
    }
    case "address": {
      for (const k of sealedFields("address")) put(k, f(k));
      if (f("country") !== "") {
        if (!/^[A-Za-z]{2}$/u.test(f("country"))) return { ok: false, problem: "Type the country as its two-letter code, like DE or US." };
        secret.country = f("country").toUpperCase();
      }
      if (!editing && (f("line1") === "" || f("city") === "" || f("country") === "")) return { ok: false, problem: "Add the street, city and country." };
      if (bad.length > 0) return { ok: false, problem: `${bad[0]!} isn't a website.` };
      if (label === "" && !editing) label = "Home";
      break;
    }
    case "env": {
      const name = d.envName.trim();
      if (!editing) {
        if (name === "") return { ok: false, problem: "Give it a name." };
        const why = envNameProblem(name);
        if (why !== undefined) return { ok: false, problem: why };
      }
      // A value is kept exactly as typed, but the empty one means "unchanged" on an edit.
      const value = d.fields.value ?? "";
      if (!editing && value === "") return { ok: false, problem: "Give it a value." };
      if (utf8Bytes(value) > ENV_VALUE_MAX_BYTES) return { ok: false, problem: "Values are up to 64 KB." };
      if (value.includes("\u0000")) return { ok: false, problem: "A value can't hold a NUL character." };
      if (value !== "") secret.value = value;
      return { ok: true, value: { secret, label: name || label, sites: [], envName: name, secretEnv: d.secret } };
    }
  }
  if (label === "") return { ok: false, problem: "Give it a name." };
  return { ok: true, value: { secret, label, sites } };
};

/** A revealed card's fields as the item screen shows them: the number grouped, the expiry as MM/YY. */
export const shownFields = (kind: VaultKind, revealed: Readonly<Record<string, string>>): Record<string, string> => {
  if (kind !== "card") return { ...revealed };
  const { month, year, number, ...rest } = revealed;
  return { ...rest, ...(number === undefined ? {} : { number: groupNumber(number) }), ...(month === undefined || year === undefined ? {} : { expiry: `${month}/${year}` }) };
};

/** Which sealed fields a shown field opens: a card's expiry is two. */
export const fieldsFor = (kind: VaultKind, key: string): string[] => (kind === "card" && key === "expiry" ? ["month", "year"] : [key]);

/** What Copy puts on the clipboard for a shown field: a card number without its spaces. */
export const copyText = (key: string, shown: string): string => (key === "number" ? digits(shown) : shown);

/** Which fields the item has, from its metadata (`fields`), when the hub says; else all of its kind's. */
export const presentFields = (item: Pick<VaultItemSummary, "kind" | "meta">): FieldSpec[] => {
  const listed = (item.meta as Record<string, unknown>).fields;
  if (!Array.isArray(listed)) return [...FIELDS[item.kind]];
  return FIELDS[item.kind].filter((f) => fieldsFor(item.kind, f.key).some((k) => listed.includes(k)));
};

/** An item's sites, from its metadata. */
export const sitesMeta = (item: Pick<VaultItemSummary, "meta">): string[] => {
  const s = (item.meta as Record<string, unknown>).sites;
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === "string") : [];
};

/** Whether a variable is a secret one (masked, revealed behind Face ID) or plain (shown as it is). */
export const isSecretEnv = (item: Pick<VaultItemSummary, "kind" | "meta">): boolean => item.kind === "env" && (item.meta as Record<string, unknown>).secret !== false;

/** How long a revealed value stays on screen, and the clipboard keeps a copied one. */
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
};

/** One audit row as the item screen's Activity shows it: what happened, then where and by whom. Never a value. */
export const auditLine = (e: VaultAuditEntry, projectName: (machineId: string, projectId: string) => string | undefined): { title: string; detail: string | undefined } => {
  const data = e.data as Record<string, unknown>;
  const title = ACTION_WORDS[e.action] ?? sentence(e.action.replace(/_/gu, " "));
  const where = str(data.site) ?? str(data.host);
  const project = e.machineId === undefined || e.projectId === undefined ? undefined : projectName(e.machineId, e.projectId);
  // A refusal or failure says why, in the hub's words.
  const why = e.outcome === "ok" || e.outcome === "" ? undefined : (str(data.reason) ?? e.outcome).replace(/_/gu, " ");
  const parts = [where, project, e.taskId, why === undefined ? undefined : sentence(why)];
  const detail = parts.filter((x) => x !== undefined && x !== "").join(" · ");
  return { title, detail: detail === "" ? undefined : detail };
};

const sentence = (s: string): string => (s === "" ? s : s[0]!.toUpperCase() + s.slice(1));

/** How a lead's import proposal went, as the line its card leaves in the chat; undefined while it's open. */
export const importOutcome = (card: Pick<VaultImportCard, "state" | "imported">): string | undefined => {
  if (card.state === "open") return undefined;
  if (card.state === "dismissed") return "Not imported";
  const n = card.imported;
  return n === undefined ? "Imported into your vault" : `Imported ${String(n)} ${n === 1 ? "item" : "items"} into your vault`;
};
