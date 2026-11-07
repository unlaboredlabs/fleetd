// A chat's Artifacts on the phone (W367, D292), kept pure: the hub calls' shapes, a format's word, the lines under a
// row, a file and a version, an artifact link's target (`artifact:<name>`, `artifact:<name>@<version>`), and the fence an HTML
// artifact runs in. An HTML artifact is a page with its scripts on and nothing else, as on the desktop: the page gets a
// CSP ahead of everything it says (default-src 'none', its own inline scripts and styles, data: images and fonts) and
// DNS prefetching off, then a first script that takes WebRTC away (no CSP sees its STUN and TURN) and hands a person's
// click on a link to the app with the page's key, which only that script holds. The WebView keeps no storage, cookies
// or files, and loads nothing past the page itself; the only message the app takes from it is such a link, which
// opens in the browser as a Markdown link does.
import { fileSize } from "../../chatView";
import { kindOf, type ArtifactFormat, type ArtifactPublished, type ArtifactSummary, type ArtifactVersion, type ChatFile, type HubState } from "../../desktop";

export type { ArtifactFormat, ArtifactPublished, ArtifactSummary, ArtifactVersion, ChatFile };

/** The hub keeps artifacts (`artifacts`), as the desktop checks. */
export const artifactsShown = (hub: HubState): boolean => hub.phase === "live" && hub.features?.includes("artifacts") === true;

/** artifact_get's answer. */
export interface ArtifactRead {
  readonly name: string;
  readonly artifact: ArtifactVersion;
  readonly content: string;
  /** Newest first. */
  readonly versions: readonly ArtifactVersion[];
}

/** "Markdown", "HTML"; a format a newer hub adds, as it names it. */
export const formatWord = (f: ArtifactFormat): string => (f === "md" ? "Markdown" : f === "html" ? "HTML" : String(f).toUpperCase());

/** A row's line: its format, who published it, when, and its version once there is more than one. */
export const rowLine = (v: ArtifactVersion, when: string): string =>
  [formatWord(v.format), v.by, when, ...(v.version > 1 ? [`Version ${String(v.version)}`] : [])].join(" · ");

/** A file's line: its kind, size and when it was sent. */
export const fileLine = (f: ChatFile, when: string): string => [kindOf(f.mime), fileSize(f.bytes), when].join(" · ");

/** The chat card's line: its format, the version it published once past the first, and who. */
export const cardLine = (p: ArtifactPublished): string => [formatWord(p.format), ...(p.version > 1 ? [`Version ${String(p.version)}`] : []), p.by].join(" · ");

/** A link's artifact and version, or undefined for any other link. */
export const linkTarget = (url: string): { name: string; version: number | undefined } | undefined => {
  const m = /^artifact:([a-z0-9]+(?:-[a-z0-9]+)*)(?:@([1-9]\d{0,8}))?$/u.exec(url);
  if (m === null) return undefined;
  return { name: m[1] ?? "", version: m[2] === undefined ? undefined : Number(m[2]) };
};

/** What an artifact's page may do: run its own inline scripts and styles; load nothing. */
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
].join("; ");

/** The message a person's click on a link in an HTML artifact sends the app: `{ [ARTIFACT_LINK]: href, key }`. */
export const ARTIFACT_LINK = "fleetdArtifactLink";

/**
 * The page's first script, holding its key. It takes itself out of the document, so the page's code never reads the
 * key, and keeps the WebView's own message handler as it is now, so a page that swaps window.webkit or
 * window.ReactNativeWebView later can't listen in. WebRTC's constructors go, from this window and from any
 * about:blank or srcdoc frame it makes (a fresh window there would bring them back). A person's tap on a link (a
 * trusted event; a script's click isn't) goes to the app instead of navigating the page; a #fragment stays in it.
 */
export const first = (key: string): string => `<script>(() => {
  document.currentScript.remove();
  const handler = window.webkit?.messageHandlers?.ReactNativeWebView ?? window.ReactNativeWebView;
  const post = handler === undefined ? () => {} : handler.postMessage.bind(handler);
  const RTC = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCSctpTransport", "RTCDtlsTransport", "RTCRtpSender", "RTCRtpReceiver", "RTCRtpTransceiver", "RTCIceCandidate", "RTCSessionDescription", "RTCCertificate"];
  const strip = (w) => {
    for (const name of RTC) {
      try { Object.defineProperty(w, name, { value: undefined, configurable: false, writable: false }); } catch {}
    }
  };
  strip(window);
  const frameWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", { configurable: false, get() { const w = frameWindow.get.call(this); if (w) strip(w); return w; } });
  const frameDoc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentDocument");
  Object.defineProperty(HTMLIFrameElement.prototype, "contentDocument", { configurable: false, get() { const w = frameWindow.get.call(this); if (w) strip(w); return frameDoc.get.call(this); } });
  window.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (a === null || a.getAttribute("href").startsWith("#")) return;
    e.preventDefault();
    if (e.isTrusted) post(JSON.stringify({ ${ARTIFACT_LINK}: a.href, key: "${key}" }));
  }, true);
})();</script>`;

/**
 * The page as the WebView loads it: the CSP, DNS prefetching off, a viewport and its first script, ahead of anything
 * the page says (after its doctype, which must stay first or the page renders in quirks mode). A policy in force can't
 * be lifted by a later one, and prefetching once turned off stays off.
 */
export const artifactPage = (html: string, key: string): string => {
  const head = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="viewport" content="width=device-width, initial-scale=1">${first(key)}`;
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html)?.[0];
  return doctype === undefined ? `<!doctype html>${head}${html}` : `${doctype}${head}${html.slice(doctype.length)}`;
};

/** The web link a WebView message names when it carries the page's `key`; undefined for any other message. */
export const linkOf = (data: string, key: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { [ARTIFACT_LINK]: href, key: carried } = parsed as Record<string, unknown>;
  return typeof href === "string" && carried === key && /^(https?:\/\/|mailto:)/iu.test(href) ? href : undefined;
};

/** The only address the WebView loads: the page itself. A link, form, script or redirect elsewhere is refused. */
export const loadsOnly = (url: string): boolean => url === "about:blank" || url.startsWith("about:blank#");

/** The WebView's settings: scripts on; no storage, cookies, files, camera, microphone, popups or links out. */
export const FENCE = {
  javaScriptEnabled: true,
  domStorageEnabled: false,
  incognito: true,
  cacheEnabled: false,
  sharedCookiesEnabled: false,
  thirdPartyCookiesEnabled: false,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  allowsLinkPreview: false,
  allowsBackForwardNavigationGestures: false,
  allowsInlineMediaPlayback: false,
  mediaPlaybackRequiresUserAction: true,
  javaScriptCanOpenWindowsAutomatically: false,
  setSupportMultipleWindows: false,
  geolocationEnabled: false,
  mediaCapturePermissionGrantType: "deny",
  allowsAirPlayForMediaPlayback: false,
  originWhitelist: ["about:blank"] as string[],
  mixedContentMode: "never",
  textInteractionEnabled: true,
} as const;
