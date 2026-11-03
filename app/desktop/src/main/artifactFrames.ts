// HTML artifacts (W367, D292) render in a frame of their own, at fleetd-artifact://<token>/, a scheme only main
// answers: the page hands main an artifact's HTML (window.fleetd.artifactFrame) and frames the one-off address it gets
// back. The response's CSP lets the page's own inline scripts and styles run and nothing load from anywhere (no fetch,
// image, font, frame or socket; data: and blob: images and fonts aside), and sandboxes it: allow-scripts without
// allow-same-origin, so it has an opaque origin, no storage or cookies, no forms, popups or top navigation, and can't
// touch the app's page. The page session's request filter (security.ts) refuses every other origin besides, and no
// preload reaches a subframe, so window.fleetd never exists in it.
import { randomBytes } from "node:crypto";

export const ARTIFACT_SCHEME = "fleetd-artifact";

/** What an artifact's page may do: run its own scripts and styles; load nothing. */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "sandbox allow-scripts",
].join("; ");

/** The pages kept to answer their frames: the newest few, as the panel shows one at a time. */
const KEPT = 8;

const TOKEN = /^[0-9a-f]{32}$/u;

export class ArtifactFrames {
  readonly #pages = new Map<string, string>();

  /** Keeps `html` and returns the address its frame loads. */
  put(html: string): string {
    const token = randomBytes(16).toString("hex");
    this.#pages.set(token, html);
    for (const old of this.#pages.keys()) {
      if (this.#pages.size <= KEPT) break;
      this.#pages.delete(old);
    }
    return `${ARTIFACT_SCHEME}://${token}/`;
  }

  /** The answer to a frame's request: its page at `/`, with its CSP; nothing else exists. */
  response(url: string): Response {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const html = TOKEN.test(parsed.host) && parsed.pathname === "/" ? this.#pages.get(parsed.host) : undefined;
    if (parsed.protocol !== `${ARTIFACT_SCHEME}:` || html === undefined) return new Response("Not found", { status: 404 });
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": ARTIFACT_CSP,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
}

export const artifactFrames = new ArtifactFrames();
