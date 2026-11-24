// A login's verification codes (RFC 6238), as the hub makes them (fleetd/src/hub/vault/fields.ts totpParams): the
// setup key a site shows, base32 or an otpauth://totp/ link, is checked as it's saved, and once revealed behind Face
// ID the item screen shows the code it makes now, never the key. Hermes has no URL.searchParams or BigInt, so the link
// and the counter are read by hand.
import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";

/** The hub's floor: no site's key is under 80 bits, 16 base32 letters. */
export const TOTP_KEY_MIN_BYTES = 10;

export interface TotpParams {
  readonly key: Uint8Array;
  readonly digits: number;
  readonly period: number;
  readonly algorithm: "sha1" | "sha256" | "sha512";
}

type Parsed = { ok: true; value: TotpParams } | { ok: false; problem: string };

const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const base32 = (text: string): Parsed | Uint8Array => {
  const clean = text.toUpperCase().replace(/[\s=-]/gu, "");
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const c of clean) {
    const v = A.indexOf(c);
    if (v < 0) return { ok: false, problem: "A setup key has letters A to Z and digits 2 to 7 only. Copy it again from the site." };
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  if (out.length < TOTP_KEY_MIN_BYTES) return { ok: false, problem: "That setup key is too short: a site's has at least 16 letters and digits." };
  return out;
};

/** An otpauth:// link's query, its names lowercased; undefined when it won't decode. */
const query = (link: string): Record<string, string> | undefined => {
  const q = link.split("#")[0]!.split("?")[1] ?? "";
  const out: Record<string, string> = {};
  try {
    for (const pair of q.split("&")) {
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      const name = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
      out[name] = decodeURIComponent((eq < 0 ? "" : pair.slice(eq + 1)).replace(/\+/gu, " "));
    }
  } catch {
    return undefined;
  }
  return out;
};

/** A setup key or otpauth:// link as the codes' settings, or why it makes none, in the person's words. */
export const totpParse = (text: string): Parsed => {
  const s = text.trim();
  if (!/^otpauth:/iu.test(s)) {
    const key = base32(s);
    return key instanceof Uint8Array ? { ok: true, value: { key, digits: 6, period: 30, algorithm: "sha1" } } : key;
  }
  const kind = /^otpauth:\/\/([^/?#]*)/iu.exec(s)?.[1]?.toLowerCase();
  if (kind !== "totp") return { ok: false, problem: kind === "hotp" ? "That link is for counted codes, not timed ones: fleetd makes timed codes." : "That isn't an otpauth:// link." };
  const q = query(s);
  if (q === undefined) return { ok: false, problem: "That isn't an otpauth:// link." };
  const algorithm = (q.algorithm ?? "SHA1").toLowerCase();
  if (algorithm !== "sha1" && algorithm !== "sha256" && algorithm !== "sha512") return { ok: false, problem: "That link's codes use an algorithm other than SHA1, SHA256 or SHA512." };
  const digits = Number(q.digits ?? 6);
  const period = Number(q.period ?? 30);
  if (![6, 7, 8].includes(digits) || !(period >= 10 && period <= 120)) return { ok: false, problem: "That link's codes have a length or period fleetd can't make." };
  const key = base32(q.secret ?? "");
  return key instanceof Uint8Array ? { ok: true, value: { key, digits, period, algorithm } } : key;
};

/** Why a setup key typed in the form won't do; undefined when it will, or when nothing was typed. */
export const totpKeyProblem = (text: string): string | undefined => {
  if (text.trim() === "") return undefined;
  const p = totpParse(text);
  return p.ok ? undefined : p.problem;
};

const HASH = { sha1, sha256, sha512 } as const;

/** The code `setting` makes at `nowMs` and the seconds it has left; undefined when the setting makes none. */
export const totpNow = (setting: string, nowMs: number): { code: string; left: number } | undefined => {
  const p = totpParse(setting);
  if (!p.ok) return undefined;
  const { key, digits, period, algorithm } = p.value;
  const counter = Math.floor(nowMs / 1000 / period);
  // The counter as 8 big-endian bytes: its high half is 0 until the year 10889 at 30 s.
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c % 256;
    c = Math.floor(c / 256);
  }
  const mac = hmac(HASH[algorithm], key, msg);
  key.fill(0);
  const off = mac[mac.length - 1]! & 0xf;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  const code = String(bin % 10 ** digits).padStart(digits, "0");
  return { code, left: period - (Math.floor(nowMs / 1000) % period) };
};

/** A code as iOS's Passwords prints one: two halves, "287 082". */
export const groupCode = (code: string): string => {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
};
