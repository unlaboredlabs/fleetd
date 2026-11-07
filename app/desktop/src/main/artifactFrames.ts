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
import { ARTIFACT_LINK } from "../shared/artifactLink";

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
  // Every string the page makes into HTML, or a script out of, goes through the first script's policy.
  "require-trusted-types-for 'script'",
  "trusted-types default",
  "sandbox allow-scripts",
].join("; ");

/**
 * The page's first script, holding its key. It takes itself out of the document, so the page's code never reads the
 * key (and fetching its own source is refused). A person's click on a link (a trusted event; a script's click isn't)
 * goes to the app's page instead of navigating the frame.
 *
 * WebRTC's constructors go from every window the page can reach, and the page gets no frame, whose fresh window would
 * bring them back (the sandbox gives a frame's child its own origin today, but the fence doesn't count on it): making
 * one (createElement, a customized built-in, XSLT) is refused, HTML strings with one are refused by the Trusted Types
 * default policy (innerHTML, srcdoc, DOMParser, document.write; javascript: URLs too), and framedPage takes the tags out
 * of the page's own source. Should one appear anyway, its window loses WebRTC as it is made (an about:blank frame's
 * load event fires as it is inserted) or reached (contentWindow), and the frame goes at the next microtask.
 * document.open, which would erase these listeners, is refused, as is document.write once loaded. The phone's
 * artifact page (app/mobile/src/screens/artifacts/model.ts) runs the same fence.
 */
export const first = (key: string): string => `<script>(() => {
  document.currentScript.remove();
  const post = parent.postMessage.bind(parent);
  const RTC = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCSctpTransport", "RTCDtlsTransport", "RTCRtpSender", "RTCRtpReceiver", "RTCRtpTransceiver", "RTCIceCandidate", "RTCSessionDescription", "RTCCertificate"];
  const FRAME = /^(iframe|frame|frameset|object|embed)$/iu;
  const lock = (o, name, desc) => { try { Object.defineProperty(o, name, { ...desc, configurable: false }); } catch {} };
  const refuse = (w, what) => { throw new w.DOMException(what + " is off in a report", "SecurityError"); };
  const hardened = new WeakSet();
  const harden = (w) => {
    let doc;
    try { doc = w.document; } catch { return; }
    if (hardened.has(doc)) return;
    hardened.add(doc);
    for (const name of RTC) lock(w, name, { value: undefined, writable: false });
    const D = w.Document.prototype;
    for (const name of ["createElement", "createElementNS"]) {
      const real = D[name];
      lock(D, name, { writable: false, value: function (...a) {
        if (FRAME.test(String(a[name === "createElement" ? 0 : 1] ?? "").split(":").pop())) refuse(w, "A frame");
        return real.apply(this, a);
      } });
    }
    lock(D, "open", { writable: false, value: () => refuse(w, "document.open") });
    for (const name of ["write", "writeln"]) {
      const real = D[name];
      lock(D, name, { writable: false, value: function (...a) {
        if (this.readyState !== "loading") refuse(w, "document." + name + " once loaded");
        return real.apply(this, a);
      } });
    }
    const define = w.CustomElementRegistry.prototype.define;
    lock(w.CustomElementRegistry.prototype, "define", { writable: false, value: function (n, c, o) {
      if (o?.extends !== undefined && FRAME.test(String(o.extends))) refuse(w, "A frame");
      return define.call(this, n, c, o);
    } });
    lock(w, "XSLTProcessor", { value: undefined, writable: false });
    for (const Owner of [w.HTMLIFrameElement, w.HTMLFrameElement, w.HTMLObjectElement]) {
      if (Owner === undefined) continue;
      const win = Object.getOwnPropertyDescriptor(Owner.prototype, "contentWindow");
      const content = Object.getOwnPropertyDescriptor(Owner.prototype, "contentDocument");
      if (win === undefined) continue;
      lock(Owner.prototype, "contentWindow", { get() { const f = win.get.call(this); if (f) harden(f); return f; } });
      if (content !== undefined) lock(Owner.prototype, "contentDocument", { get() { const f = win.get.call(this); if (f) harden(f); return content.get.call(this); } });
    }
    doc.addEventListener("load", (e) => { const f = e.target?.contentWindow; if (f) harden(f); }, true);
    new w.MutationObserver((records) => {
      for (const r of records) for (const n of r.type === "attributes" ? [r.target] : r.addedNodes) {
        if (n.nodeType !== 1) continue;
        for (const f of [n, ...n.querySelectorAll("iframe, frame, frameset, object, embed")]) if (FRAME.test(f.localName)) f.remove();
      }
    }).observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcdoc", "data"] });
  };
  window.trustedTypes?.createPolicy("default", {
    createHTML: (s, _t, sink) => {
      if (/srcdoc/iu.test(sink) || /<(iframe|frame|object|embed)/iu.test(s)) throw new TypeError("a report has no frames");
      return s;
    },
    createScript: (s, _t, sink) => {
      if (sink !== "eval" && sink !== "Function" && !/^HTMLScriptElement /u.test(sink)) throw new TypeError("a report has no javascript: URLs");
      return s;
    },
    createScriptURL: (s) => s,
  });
  harden(window);
  window.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (a === null || a.getAttribute("href").startsWith("#")) return;
    e.preventDefault();
    if (e.isTrusted) post({ ${ARTIFACT_LINK}: a.href, key: "${key}" }, "*");
  }, true);
})();</script>`;

const DOCTYPE = /^\s*<!doctype[^>]*>/iu;

/** The page's own frame tags, made inert: the HTML parser makes a frame only of these, whatever their case. */
const FRAME_TAG = /<(iframe|frameset|frame|object|embed)(?=[\t\n\f\r />])/giu;

/**
 * The page as its frame gets it: its first script ahead of everything it says (after its doctype, so it keeps its
 * mode), and its frame tags made inert.
 */
export const framedPage = (source: string, key: string): string => {
  const html = source.replace(FRAME_TAG, "<fleetd-removed-$1");
  const doctype = DOCTYPE.exec(html)?.[0];
  return doctype === undefined ? `${first(key)}${html}` : `${doctype}${first(key)}${html.slice(doctype.length)}`;
};

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
