// An HTML artifact's page as its frame gets it (W367, D292): the CSP it is served with, the first script that fences
// it, and the page with that script put first. Shared by the desktop's fleetd-artifact:// pages (main/artifactFrames.ts),
// the web app's (src/web/shell.ts, served by fleetd cloud on the team's own address, never the web app's) and the
// cloud's frames route (the fleetd package's `apps/artifact_page`), so every one runs the same fence. No Node or DOM here.
import { ARTIFACT_LINK } from "./artifactLink";

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
