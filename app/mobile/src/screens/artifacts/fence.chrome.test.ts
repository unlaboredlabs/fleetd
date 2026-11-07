// The HTML artifact fence in a real engine: the page artifactPage builds, in Chrome (the engine of Android's WebView,
// and of the reviewer's bypass), every way to a frame's fresh window tried for WebRTC, with a STUN server listening. CI's
// Linux runners have Chrome; elsewhere CHROME_PATH names one, or the test is skipped. iOS's WebKit is checked in its
// simulator.
import { createSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { artifactPage } from "./model";

const chrome = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const missing = !existsSync(chrome);
if (missing && process.env.CI === "true") throw new Error(`No Chrome at ${chrome}: the fence's engine test needs one (CHROME_PATH)`);

/** A report trying, every way it can, to reach a window with WebRTC and send STUN to `port`. */
const attacks = (port: number): string => `<body><iframe></iframe><iframe src="https://example.com/"></iframe>
<iframe srcdoc="<script>parent.R.staticSrcdoc = typeof RTCPeerConnection</script>"></iframe>
<script>
window.R = { staticFrames: frames.length };
const stun = (PC) => { const pc = new PC({ iceServers: [{ urls: "stun:127.0.0.1:${String(port)}" }] }); pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o)); return "SENT"; };
const t = (k, f) => { try { R[k] = f(); } catch (e) { R[k] = "refused"; } };
const last = () => { const w = frames[frames.length - 1]; return w === undefined ? "refused" : typeof w.RTCPeerConnection === "function" ? stun(w.RTCPeerConnection) : "refused"; };
const into = (html) => { const d = document.createElement("div"); document.body.appendChild(d); d.innerHTML = html; return last(); };
t("own", () => typeof RTCPeerConnection === "function" ? stun(RTCPeerConnection) : "refused");
t("webkit", () => typeof webkitRTCPeerConnection === "function" ? stun(webkitRTCPeerConnection) : "refused");
t("createElement", () => { document.body.appendChild(document.createElement("IFRAME")); return last(); });
t("createElementNS", () => { document.body.appendChild(document.createElementNS("http://www.w3.org/1999/xhtml", "x:iframe")); return last(); });
t("inertDocument", () => { const d = document.implementation.createHTMLDocument(""); document.body.appendChild(document.adoptNode(d.createElement("iframe"))); return last(); });
t("innerHTML", () => into("<iframe></iframe>"));
t("innerHTMLsrc", () => into("<IFRAME src='https://example.com/'></IFRAME>"));
t("insertAdjacentHTML", () => { document.body.insertAdjacentHTML("beforeend", "<iframe></iframe>"); return last(); });
t("contextualFragment", () => { document.body.appendChild(document.createRange().createContextualFragment("<iframe></iframe>")); return last(); });
t("domParser", () => { const d = new DOMParser().parseFromString("<iframe></iframe>", "text/html"); document.body.appendChild(document.adoptNode(d.body.firstChild)); return last(); });
t("documentWrite", () => { document.write("<iframe></iframe>"); return last(); });
t("documentOpen", () => { document.open(); return "opened"; });
t("customBuiltIn", () => { customElements.define("x-frame", class extends HTMLIFrameElement {}, { extends: "iframe" }); return "defined"; });
t("xslt", () => typeof XSLTProcessor === "function" ? "there" : "refused");
t("execCommand", () => { const d = document.createElement("div"); d.contentEditable = "true"; document.body.appendChild(d); d.focus(); document.execCommand("insertHTML", false, "<iframe></iframe>"); return last(); });
t("javascriptUrl", () => { const a = document.createElement("a"); a.href = "javascript:void(R.jsRan = 'SENT')"; document.body.appendChild(a); a.click(); return R.jsRan ?? "refused"; });
// What a report does need still works.
t("innerHTMLWorks", () => { const d = document.createElement("div"); d.innerHTML = "<b>ok</b><svg><rect/></svg>"; return d.textContent + d.querySelectorAll("rect").length; });
t("evalWorks", () => eval("1 + 1"));
setTimeout(() => { R.framesLeft = frames.length; R.done = true; }, 300);
</script></body>`;

describe.skipIf(missing)("an HTML artifact in a real engine", () => {
  it("reaches no window with WebRTC, and sends no STUN", async () => {
    const udp = createSocket("udp4");
    const packets: Buffer[] = [];
    udp.on("message", (m) => packets.push(m));
    await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(artifactPage(attacks(udp.address().port), "k1"));
      await page.waitForFunction(() => (window as unknown as { R?: { done?: boolean } }).R?.done === true, null, { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const r = await page.evaluate(() => (window as unknown as { R: Record<string, unknown> }).R);
      const { innerHTMLWorks, evalWorks, staticFrames, staticSrcdoc, framesLeft, ...tries } = r;
      for (const [k, v] of Object.entries(tries)) if (k !== "done") expect(v, k).toBe("refused");
      expect(staticFrames, "the page's own frames").toBe(0);
      expect(staticSrcdoc, "a srcdoc frame's script").toBeUndefined();
      expect(framesLeft).toBe(0);
      expect(innerHTMLWorks).toBe("ok1");
      expect(evalWorks).toBe(2);
      expect(packets).toHaveLength(0);
    } finally {
      await browser.close();
      udp.close();
    }
  }, 30_000);
});
