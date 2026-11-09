// Each kind's secret fields and the readable metadata the hub works out from them (vault-design §3). The hub never
// takes a client's word for metadata it can derive: brand and last 4 come from the number, country from the address,
// fingerprint and size from the value.
import { createHash, createHmac } from "node:crypto";
import { ToolError } from "../../shared/errors.ts";
import { envNameReserved } from "../approvals/sink.ts";

export type VaultKind = "login" | "card" | "address" | "env";
export type VaultScope = "person" | "project" | "order" | "hub";
export const KINDS: readonly VaultKind[] = ["login", "card", "address", "env"];

export const FIELDS: Record<VaultKind, readonly string[]> = {
  login: ["username", "password", "totp", "notes"],
  card: ["number", "month", "year", "cvc", "name"],
  address: ["name", "organization", "line1", "line2", "city", "region", "postalCode", "country", "phone", "email"],
  env: ["value"],
};

/** An item's secret fields: only strings, only its kind's names, empty ones left out. */
export type Secret = Record<string, string>;

/** Where an item came from. */
export type Source = { kind: "typed" } | { kind: "1password"; ref: string; importedMs: number } | { kind: "adopted"; from: string };

/** A request_secret sink an env item is delivered to as well (env: and file: sinks). */
export type SinkMeta = { kind: "env" | "file"; machineId: string; path: string; envName?: string; secretKey?: string };

export type Meta = {
  sites?: string[];
  fields?: string[];
  brand?: CardBrand;
  last4?: string;
  billingAddress?: string;
  country?: string;
  secret?: boolean;
  fingerprint?: string;
  bytes?: number;
  sink?: SinkMeta;
  source: Source;
};

/** Sealed fields take at most 8 KiB; an env value at most 64 KiB. */
export const SEALED_MAX_BYTES = 8 * 1024;
export const ENV_VALUE_MAX_BYTES = 64 * 1024;
export const LABEL_MAX = 120;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The env fingerprint every node reports: 8 hex characters of SHA-256 (node/secrets/files.ts `fingerprintOf`). */
export const fingerprintOf = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);

const invalid = (message: string, fix?: string) => new ToolError("invalid", message, fix);

/** The fields of `raw` that belong to `kind`, as strings; anything else is refused by name, never by value. */
export function cleanSecret(kind: VaultKind, raw: unknown): Secret {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw invalid("The sealed value isn't a JSON object of fields.");
  const out: Secret = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!FIELDS[kind].includes(k)) throw invalid(`A ${kind} has no field ${k}.`, `Its fields are ${FIELDS[kind].join(", ")}.`);
    if (v === null || v === "") continue;
    if (typeof v !== "string") throw invalid(`The field ${k} isn't text.`);
    if (v.includes("\u0000")) throw invalid(`The field ${k} holds a NUL character.`);
    out[k] = v;
  }
  return out;
}

/** `base` with `changes` laid over it: a field set to "" or null clears it. */
export function merge(kind: VaultKind, base: Secret, changes: unknown): Secret {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) throw invalid("The sealed value isn't a JSON object of fields.");
  const out: Secret = { ...base };
  for (const [k, v] of Object.entries(changes as Record<string, unknown>)) {
    if (!FIELDS[kind].includes(k)) throw invalid(`A ${kind} has no field ${k}.`, `Its fields are ${FIELDS[kind].join(", ")}.`);
    if (v === null || v === "") delete out[k];
    else out[k] = String(v);
  }
  return cleanSecret(kind, out);
}

export const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

export type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "diners" | "jcb" | "unionpay" | "other";

export function brandOf(digits: string): CardBrand {
  if (/^4/.test(digits)) return "visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return "mastercard";
  if (/^3[47]/.test(digits)) return "amex";
  if (/^(6011|65|64[4-9])/.test(digits)) return "discover";
  if (/^35(2[89]|[3-8])/.test(digits)) return "jcb";
  if (/^3(0[0-5]|[68])/.test(digits)) return "diners";
  if (/^62/.test(digits)) return "unionpay";
  return "other";
}

export const BRAND_NAMES: Record<CardBrand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  other: "Card",
};

/** A login's or an address's site as a lowercase host; a pasted URL is cut to its host. Undefined: none. */
export function hostOf(site: string): string | undefined {
  let s = site.trim().toLowerCase();
  if (s === "") return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  try {
    const host = new URL(s).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return /^[a-z0-9.-]+$/.test(host) && host.includes(".") ? host : undefined;
  } catch {
    return undefined;
  }
}

export function cleanSites(sites: unknown): string[] {
  if (sites === undefined) return [];
  if (!Array.isArray(sites) || sites.length > 20) throw invalid("Sites are a list of at most 20 hosts.");
  const out: string[] = [];
  for (const s of sites) {
    const host = typeof s === "string" ? hostOf(s) : undefined;
    if (!host) throw invalid(`${String(s).slice(0, 80)} isn't a site with a dot in it.`, "Give a host such as amazon.com.");
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

export function checkEnvName(name: string): void {
  if (!ENV_NAME.test(name)) throw invalid(`${name.slice(0, 130)} isn't a variable name.`, "Use letters, digits and _, not starting with a digit.");
  if (envNameReserved(name)) throw invalid(`${name} is fleetd's or claude's own: it can't be set.`, "Pick another name.");
}

/**
 * Checks `secret` for `kind` and returns the metadata the hub keeps readable. `given` carries what only the person
 * can say: sites, whether a variable is secret, a card's billing address, the item's source and sink.
 */
export function metaOf(kind: VaultKind, secret: Secret, given: Partial<Meta>): Meta {
  const bytes = Buffer.byteLength(JSON.stringify(secret));
  const max = kind === "env" ? ENV_VALUE_MAX_BYTES + 64 : SEALED_MAX_BYTES;
  if (bytes > max) throw invalid(`The item's fields take ${bytes} bytes; at most ${max} fit.`);
  const source = { source: given.source ?? ({ kind: "typed" } as const) };
  switch (kind) {
    case "login": {
      const fields = FIELDS.login.filter((f) => secret[f] !== undefined);
      if (secret.totp !== undefined) totpParams(secret.totp);
      return { sites: given.sites ?? [], fields, ...source };
    }
    case "card": {
      const digits = (secret.number ?? "").replace(/[\s-]/g, "");
      if (!/^\d{12,19}$/.test(digits) || !luhn(digits)) throw invalid("That card number doesn't check out.", "Type it again from the card.");
      secret.number = digits;
      const month = Number(secret.month);
      if (secret.month !== undefined && !(Number.isInteger(month) && month >= 1 && month <= 12)) throw invalid("The expiry month is 1 to 12.");
      if (secret.month !== undefined) secret.month = String(month).padStart(2, "0");
      if (secret.year !== undefined) {
        if (!/^(\d{2}|\d{4})$/.test(secret.year)) throw invalid("The expiry year is YY or YYYY.");
        if (secret.year.length === 2) secret.year = `20${secret.year}`;
      }
      if (secret.cvc !== undefined && !/^\d{3,4}$/.test(secret.cvc)) throw invalid("The CVC is 3 or 4 digits.");
      return {
        brand: brandOf(digits),
        last4: digits.slice(-4),
        ...(given.billingAddress ? { billingAddress: given.billingAddress } : {}),
        ...source,
      };
    }
    case "address": {
      const country = (secret.country ?? "").trim();
      return { ...(country ? { country: country.slice(0, 60) } : {}), ...(given.sites?.length ? { sites: given.sites } : {}), ...source };
    }
    case "env": {
      const value = secret.value ?? "";
      const size = Buffer.byteLength(value);
      if (size > ENV_VALUE_MAX_BYTES) throw invalid("The value is over 64 KiB.", "Shorten it, or put a file on the machine and set its path instead.");
      const isSecret = given.secret !== false;
      return {
        secret: isSecret,
        ...(isSecret ? { fingerprint: fingerprintOf(value) } : {}),
        bytes: size,
        ...(given.sink ? { sink: given.sink } : {}),
        ...source,
      };
    }
  }
}

// --- TOTP (RFC 6238): made on the hub, so a login's seed never leaves it ---

type Totp = { key: Uint8Array; digits: number; period: number; algorithm: "sha1" | "sha256" | "sha512" };

function base32(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of clean) {
    const v = A.indexOf(c);
    if (v < 0) throw invalid("The one-time code seed isn't base32.");
    bits += v.toString(2).padStart(5, "0");
  }
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

export function totpParams(totp: string): Totp {
  if (totp.startsWith("otpauth://")) {
    let url: URL;
    try {
      url = new URL(totp);
    } catch {
      throw invalid("The one-time code setting isn't an otpauth:// link.");
    }
    const alg = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
    if (alg !== "sha1" && alg !== "sha256" && alg !== "sha512") throw invalid("The one-time code's algorithm isn't SHA1, SHA256 or SHA512.");
    const digits = Number(url.searchParams.get("digits") ?? 6);
    const period = Number(url.searchParams.get("period") ?? 30);
    if (![6, 7, 8].includes(digits) || !(period >= 10 && period <= 120)) throw invalid("The one-time code's digits or period are out of range.");
    return { key: base32(url.searchParams.get("secret") ?? ""), digits, period, algorithm: alg };
  }
  return { key: base32(totp), digits: 6, period: 30, algorithm: "sha1" };
}

/** The one-time code for `totp` at `nowMs`. */
export function totpCode(totp: string, nowMs: number): string {
  const p = totpParams(totp);
  const counter = Math.floor(nowMs / 1000 / p.period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = new Uint8Array(createHmac(p.algorithm, p.key).update(msg).digest());
  p.key.fill(0);
  const off = mac[mac.length - 1]! & 0xf;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** p.digits).padStart(p.digits, "0");
}
