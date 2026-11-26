// A preview host's sign-in cookie: host-only on `<name>.<preview domain>` (`__Host-`: Secure, Path=/, no Domain), so
// it reaches that one link and no other preview, the app or the workspace. Its value names the link, the person and
// its end, signed with the link's own secret; whoever checks it still checks the link and the person on each visit
// (revoked, ended, removed). node:crypto only, for the cloud at its pin (`fleetd/hub/share_links/cookie`).
import { createHmac, timingSafeEqual } from "node:crypto";
import { COOKIE_MS } from "./rules.ts";

export const COOKIE = "__Host-fleetd_preview";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const mac = (secret: string, body: string) => createHmac("sha256", secret).update(`fleetd preview 1 ${body}`).digest("base64url");

/** The cookie's value for `personId` on link `name`, ending at `expMs`. */
export function sign(secret: string, name: string, personId: string, expMs: number): string {
  const body = `${name}.${b64(personId)}.${expMs}`;
  return `${body}.${mac(secret, body)}`;
}

/** The person and end a value names, when it is link `name`'s, signed with `secret`, and not ended at `now`. */
export function verify(secret: string, name: string, value: string, now: number): { personId: string; expMs: number } | undefined {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== name) return undefined;
  const body = parts.slice(0, 3).join(".");
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(parts[3]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  const expMs = Number(parts[2]);
  if (!Number.isSafeInteger(expMs) || expMs <= now) return undefined;
  return { personId: unb64(parts[1]!), expMs };
}

/** This cookie's value in a request's Cookie header. */
export function read(cookieHeader: string | null | undefined): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The Cookie header without this cookie, for the dev server; undefined when nothing is left. */
export function strip(cookieHeader: string | null | undefined): string | undefined {
  const kept = (cookieHeader ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p.slice(0, p.indexOf("=")).trim() !== COOKIE);
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/** The Set-Cookie header for `value`, lasting until `expMs`. */
export function header(value: string, expMs: number, now: number): string {
  const age = Math.max(0, Math.floor((expMs - now) / 1000));
  return `${COOKIE}=${value}; Max-Age=${age}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** A new cookie's end from `now`, never past the link's own. */
export const cookieEnd = (now: number, linkEndsMs: number) => Math.min(now + COOKIE_MS, linkEndsMs);

/** Whether a cookie ending at `expMs` is due a new one: less than half its life left, and the link lasts longer. */
export const refreshDue = (expMs: number, now: number, linkEndsMs: number) => expMs - now < COOKIE_MS / 2 && linkEndsMs > expMs;
