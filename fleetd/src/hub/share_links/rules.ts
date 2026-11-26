// Share links' rules, without a database or a socket: what the workspace and fleetd's cloud both hold a link to. A
// link is a random name under the workspace's preview address (`https://<name>.<preview domain>`), a port on one
// machine, who made it and until when. Imported by the cloud at its pin (`fleetd/hub/share_links/rules`).

/** How long a new link lasts, and a renewal's default. */
export const DEFAULT_MINUTES = 120;
/** The most a link lasts from now: a renewal sets its end to now plus at most this. */
export const MAX_MINUTES = 24 * 60;
/** Open links a workspace may hold at once. */
export const MAX_OPEN = 20;
/** How long a sign-in's one-time code takes the visitor to the preview host for. */
export const CODE_MS = 60_000;
/** How long a preview cookie lasts; a visit with less than half of it left gets a new one. */
export const COOKIE_MS = 3600_000;
/** How long the machine has to dial its side of a stream back. */
export const DIAL_WAIT = 15_000;
/** The path on a preview host the sign-in sends a visitor back to, with a one-time code (`?code=…&to=/path`). */
export const ENTER_PATH = "/.fleetd/preview";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** A link's name: 12 of a-z0-9, so one DNS label no person picks. */
export const NAME = /^[a-z0-9]{12}$/;

/** A new random link name (about 62 bits). */
export function newPreviewName(): string {
  const out: string[] = [];
  // 252 is the largest multiple of 36 under 256: bytes past it are dropped, so every character is equally likely.
  while (out.length < 12) for (const b of crypto.getRandomValues(new Uint8Array(16))) if (b < 252 && out.length < 12) out.push(ALPHABET[b % 36]!);
  return out.join("");
}

/** A link's own secret, which its cookies are signed with: 32 random bytes, hex. */
export const newLinkSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

/** A one-time code or dial token: 32 random bytes, hex. */
export const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
export const isToken = (t: string) => /^[0-9a-f]{64}$/.test(t);

/** A port a link may forward: a TCP port, not 0. */
export const isPort = (port: unknown): port is number => Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;

/** `minutes` as a link's life: the default when absent, else 1 to MAX_MINUTES; undefined when out of range. */
export function lifeMinutes(minutes: unknown): number | undefined {
  if (minutes === undefined || minutes === null) return DEFAULT_MINUTES;
  if (!Number.isInteger(minutes) || (minutes as number) < 1 || (minutes as number) > MAX_MINUTES) return undefined;
  return minutes as number;
}

/** A host header's name, lowercased, without its port. */
export function hostOnly(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  const colon = h.lastIndexOf(":");
  return colon < 0 ? h : h.slice(0, colon);
}

/** The link name a request's host names under the preview `domain` (`<name>.<domain>`, one label only), or undefined. */
export function previewHostName(host: string | null | undefined, domain: string): string | undefined {
  if (!host || !domain) return undefined;
  const h = hostOnly(host);
  const d = domain.toLowerCase();
  if (!h.endsWith(`.${d}`)) return undefined;
  const name = h.slice(0, -(d.length + 1));
  return NAME.test(name) ? name : undefined;
}

/**
 * The preview address an admin gave, checked: an https origin with no path (http only for a `localhost` name, for
 * trying it on one machine), and never the workspace's own host or a parent of it, so a preview never shares its
 * origin. The normalized origin, or why it isn't one.
 */
export function checkPreviewUrl(value: string, workspaceUrl?: string): { url: string } | { why: string } {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return { why: "it isn't a URL, like https://preview.example.com" };
  }
  const local = u.hostname === "localhost" || u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return { why: "it must start with https://" };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) {
    return { why: "it is a name only, with no path, like https://preview.example.com" };
  }
  if (!u.hostname.includes(".") && !local) return { why: "it needs a domain name, like preview.example.com" };
  if (workspaceUrl) {
    try {
      const w = new URL(workspaceUrl).hostname.toLowerCase();
      const d = u.hostname.toLowerCase();
      if (w === d || w.endsWith(`.${d}`)) return { why: "it can't be the workspace's own address or a parent of it: give previews a name of their own" };
    } catch {}
  }
  return { url: u.origin };
}

/** A link's address under the preview origin: `https://preview.example.com` and `k7f3q9…` give `https://k7f3q9….preview.example.com`. */
export function previewUrl(base: string, name: string): string {
  const u = new URL(base);
  return `${u.protocol}//${name}.${u.host}`;
}

/** Where a one-time code takes a visitor: the preview host's entry, then `to` (a path on it). */
export function enterUrl(base: string, name: string, code: string, to = "/"): string {
  return `${previewUrl(base, name)}${ENTER_PATH}?code=${code}&to=${encodeURIComponent(safePath(to))}`;
}

/** `to` as a path on the preview host: anything else (another host, `//evil`, a scheme) is `/`. */
export function safePath(to: string | null | undefined): string {
  if (!to || !to.startsWith("/") || to.startsWith("//") || to.startsWith("/\\") || /[\r\n]/.test(to)) return "/";
  return to;
}
