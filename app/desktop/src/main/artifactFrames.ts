// HTML artifacts (W367, D292) render in a frame of their own, at fleetd-artifact://<token>/, a scheme only main
// answers: the page hands main an artifact's HTML (window.fleetd.artifactFrame) and frames the one-off address it gets
// back. The response's CSP lets the page's own inline scripts and styles run and nothing load from anywhere (no fetch,
// image, font, frame or socket; data: and blob: images and fonts aside), and sandboxes it: allow-scripts without
// allow-same-origin, so it has an opaque origin, no storage or cookies, no forms, popups or top navigation, and can't
// touch the app's page. The page session's request filter (security.ts) refuses every other origin besides, and no
// preload reaches a subframe, so window.fleetd never exists in it. Main puts FIRST ahead of the page's own code: it
// takes away WebRTC, whose STUN and TURN traffic no CSP or request filter sees (security.ts also sets the WebRTC IP
// policy), and every frame, whose fresh window would bring WebRTC back; and it turns a person's click on a link into a
// message to the app's page with the page's key, which only it holds: the app's page opens http(s) links that carry it
// in the browser (HtmlFrame), so the page's own scripts can't open anything. The frame itself never navigates away
// (security.ts).
import { randomBytes } from "node:crypto";
import { ARTIFACT_CSP, framedPage } from "../shared/artifactPage";

export { ARTIFACT_CSP, first, framedPage } from "../shared/artifactPage";

export const ARTIFACT_SCHEME = "fleetd-artifact";

/** A framed page: the address its frame loads, and the key its link messages carry. */
export interface Framed {
  readonly url: string;
  readonly key: string;
}

/** The pages kept to answer their frames: the newest few, as the panel shows one at a time. */
const KEPT = 8;

const TOKEN = /^[0-9a-f]{32}$/u;

export class ArtifactFrames {
  readonly #pages = new Map<string, { html: string; key: string }>();

  /** Keeps `html` and returns the address its frame loads, with its key. */
  put(html: string): Framed {
    const token = randomBytes(16).toString("hex");
    const key = randomBytes(16).toString("hex");
    this.#pages.set(token, { html, key });
    for (const old of this.#pages.keys()) {
      if (this.#pages.size <= KEPT) break;
      this.#pages.delete(old);
    }
    return { url: `${ARTIFACT_SCHEME}://${token}/`, key };
  }

  /** The answer to a frame's request: its page at `/`, with its CSP; nothing else exists. */
  response(url: string): Response {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const page = TOKEN.test(parsed.host) && parsed.pathname === "/" ? this.#pages.get(parsed.host) : undefined;
    if (parsed.protocol !== `${ARTIFACT_SCHEME}:` || page === undefined) return new Response("Not found", { status: 404 });
    return new Response(framedPage(page.html, page.key), {
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
