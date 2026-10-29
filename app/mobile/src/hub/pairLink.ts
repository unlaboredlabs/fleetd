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
