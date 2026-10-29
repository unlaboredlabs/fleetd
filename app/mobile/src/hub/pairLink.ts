// A pairing QR code's link (D232): `fleetd://pair?hub=<url-encoded hub URL>&code=<one-time code>`, which the desktop
// app and `fleetd pair` show. The app's scanner reads it, and so does iOS's Camera, which opens the app with it. Parsed
// by hand: React Native's URL has no searchParams.
import { hubOrigin, normalizeCode, type PairFailure } from "../desktop";

export type PairLink = { readonly ok: true; readonly hub: string; readonly code: string } | { readonly ok: false; readonly failure: PairFailure };

const SCAN_AGAIN = "Show a new pairing code on the hub (`fleetd pair`, or the desktop app) and scan it again, or enter the code by hand.";

const bad = (message: string): PairLink => ({ ok: false, failure: { code: "", message, fix: SCAN_AGAIN } });

/** Whether the text is a fleetd pairing link at all, valid or not. */
export const isPairLink = (text: string): boolean => /^fleetd:\/\/pair(?:[/?#]|$)/iu.test(text.trim());

/** The link's hub (its origin) and code, or what's wrong with it; null when it isn't a fleetd pairing link. */
export const parsePairLink = (text: string): PairLink | null => {
  if (!isPairLink(text)) return null;
  const query = text.trim().split("#")[0]?.split("?").slice(1).join("?") ?? "";
  const params = new Map<string, string>();
  for (const part of query.split("&")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    try {
      params.set(decodeURIComponent(part.slice(0, at)), decodeURIComponent(part.slice(at + 1).replace(/\+/gu, " ")));
    } catch {
      return bad("This pairing QR code is damaged.");
    }
  }
  const hub = params.get("hub")?.trim() ?? "";
  const code = params.get("code")?.trim() ?? "";
  if (hub === "" || code === "") return bad("This pairing QR code has no hub address or no code.");
  const origin = hubOrigin(hub);
  if (!origin.ok) return { ok: false, failure: origin.failure };
  const normal = normalizeCode(code);
  if (normal === null) return bad("This pairing QR code's code isn't a pairing code.");
  return { ok: true, hub: origin.origin, code: normal };
};

/** What a pairing link does, by where it came from. */
export type LinkStep =
  /** Not a pairing link: nothing to do (the scanner says it isn't one). */
  | { readonly t: "ignore" }
  /** A broken one: why. */
  | { readonly t: "refuse"; readonly failure: PairFailure }
  /** This phone is paired already: how to switch hubs. */
  | { readonly t: "paired"; readonly title: string; readonly message: string }
  /** From outside the app (iOS's Camera, a page, a message): ask before pairing with a hub someone else may run. */
  | { readonly t: "confirm"; readonly hub: string; readonly code: string; readonly title: string; readonly message: string }
  /** From the app's own scanner, which the person opened to pair: pair now. */
  | { readonly t: "pair"; readonly hub: string; readonly code: string };

export const pairLinkStep = (text: string, from: "outside" | "scanner", pairedWith: string | null): LinkStep => {
  const link = parsePairLink(text);
  if (link === null) return { t: "ignore" };
  if (pairedWith !== null) return { t: "paired", title: `Connected to ${pairedWith}`, message: "To pair with another hub, disconnect under Settings first, then scan its code again." };
  if (!link.ok) return { t: "refuse", failure: link.failure };
  if (from === "scanner") return { t: "pair", hub: link.hub, code: link.code };
  return {
    t: "confirm",
    hub: link.hub,
    code: link.code,
    title: `Connect to ${link.hub.replace(/^https?:\/\//u, "")}?`,
    message: `This phone pairs with the hub at ${link.hub}, which then sees it and sends it notifications. Connect only to a hub you or your team run.`,
  };
};
