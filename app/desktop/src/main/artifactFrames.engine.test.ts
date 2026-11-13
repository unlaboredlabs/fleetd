// The HTML artifact fence in the app's own engine: Electron frames the page main answers (ArtifactFrames, its CSP
// header and first script) sandboxed as HtmlFrame does, with a STUN server listening, and the page tries every way to
// a window with WebRTC. The session's dead proxy and WebRTC IP policy (security.ts) are left off, and the page runs a
// second time without its sandbox, whose frames give their own children another origin: the first script holds by
// itself (without it, frames[0]'s RTCPeerConnection sends STUN). A normal report (inline scripts, a chart) still draws.
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACT_CSP, ArtifactFrames } from "./artifactFrames";

/** A report trying, every way it can, to reach a window with WebRTC and send STUN to `port`; it posts what it got. */
const attacks = (port: number): string => `<!doctype html><body><iframe></iframe><iframe src="https://example.com/"></iframe>
<iframe srcdoc="<script>parent.R.staticSrcdoc = typeof RTCPeerConnection</script>"></iframe>
<script>
window.R = { staticFrames: frames.length };
const stun = (PC) => { const pc = new PC({ iceServers: [{ urls: "stun:127.0.0.1:${String(port)}" }] }); pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o)); return "SENT"; };
const t = (k, f) => { try { R[k] = f(); } catch (e) { R[k] = "refused"; } };
const at = (w) => w === undefined ? "refused" : typeof w.RTCPeerConnection === "function" ? stun(w.RTCPeerConnection) : "refused";
const last = () => at(frames[frames.length - 1]);
const into = (html) => { const d = document.createElement("div"); document.body.appendChild(d); d.innerHTML = html; return last(); };
t("own", () => typeof RTCPeerConnection === "function" ? stun(RTCPeerConnection) : "refused");
t("webkit", () => typeof webkitRTCPeerConnection === "function" ? stun(webkitRTCPeerConnection) : "refused");
t("staticFrame", () => at(frames[0]));
t("createElement", () => { document.body.appendChild(document.createElement("IFRAME")); return last(); });
t("createElementNS", () => { document.body.appendChild(document.createElementNS("http://www.w3.org/1999/xhtml", "x:iframe")); return last(); });
t("inertDocument", () => { const d = document.implementation.createHTMLDocument(""); document.body.appendChild(document.adoptNode(d.createElement("iframe"))); return last(); });
t("innerHTML", () => into("<iframe></iframe>"));
t("innerHTMLsrc", () => into("<IFRAME src='https://example.com/'></IFRAME>"));
t("insertAdjacentHTML", () => { document.body.insertAdjacentHTML("beforeend", "<iframe></iframe>"); return last(); });
t("contextualFragment", () => { document.body.appendChild(document.createRange().createContextualFragment("<iframe></iframe>")); return last(); });
t("domParser", () => { const d = new DOMParser().parseFromString("<iframe></iframe>", "text/html"); document.body.appendChild(document.adoptNode(d.body.firstChild)); return last(); });
t("objectEmbed", () => into("<object data='about:blank'></object><embed src='about:blank'>"));
t("documentWrite", () => { document.write("<iframe></iframe>"); return last(); });
t("documentOpen", () => { document.open(); return "opened"; });
t("customBuiltIn", () => { customElements.define("x-frame", class extends HTMLIFrameElement {}, { extends: "iframe" }); return "defined"; });
t("xslt", () => typeof XSLTProcessor === "function" ? "there" : "refused");
t("execCommand", () => { const d = document.createElement("div"); d.contentEditable = "true"; document.body.appendChild(d); d.focus(); document.execCommand("insertHTML", false, "<iframe></iframe>"); return last(); });
t("javascriptUrl", () => { const a = document.createElement("a"); a.href = "javascript:void(R.jsRan = 'SENT')"; document.body.appendChild(a); a.click(); return R.jsRan ?? "refused"; });
setTimeout(() => { R.framesLeft = frames.length; parent.postMessage({ R }, "*"); }, 300);
</script></body>`;

/** A report as agents write them: styles, an inline script drawing a chart in SVG and on a canvas. */
const chart = `<!DOCTYPE html><html><head><style>body { font: 14px sans-serif } .bar { fill: #3b82f6 }</style></head><body>
<h1>Sweep</h1><div id="chart"></div><canvas id="c" width="40" height="20"></canvas>
<script>
const data = [3, 7, 5];
document.getElementById("chart").innerHTML = '<svg width="120" height="80">' + data.map((v, i) => '<rect class="bar" x="' + i * 40 + '" y="' + (80 - v * 10) + '" width="30" height="' + v * 10 + '"></rect>').join("") + "</svg>";
const g = document.getElementById("c").getContext("2d");
g.fillStyle = "#ff0000";
g.fillRect(0, 0, 40, 20);
const label = document.createElement("p");
label.textContent = "total " + eval("data.reduce((a, b) => a + b)");
document.body.appendChild(label);
setTimeout(() => parent.postMessage({ R: {
  rects: document.querySelectorAll("#chart rect").length,
  bar: getComputedStyle(document.querySelector("rect")).fill,
  canvas: Array.from(g.getImageData(0, 0, 1, 1).data).join(","),
  label: label.textContent,
} }, "*"), 100);
</script></body></html>`;

/** Electron's main for the run: the app's page frames the artifact (sandboxed as HtmlFrame does, or not) and prints what it posts. */
const MAIN = `const { app, BrowserWindow, protocol } = require("electron");
const spec = JSON.parse(require("node:fs").readFileSync(process.env.FENCE_SPEC, "utf8"));
protocol.registerSchemesAsPrivileged([
  { scheme: "fleetd-artifact", privileges: { standard: true, secure: true } },
  { scheme: "fleetd-test", privileges: { standard: true, secure: true } },
]);
app.whenReady().then(() => {
  process.stdout.write("ready\\n");
  protocol.handle("fleetd-artifact", (req) => req.url === spec.url ? new Response(spec.body, { headers: spec.headers }) : new Response("", { status: 404 }));
  protocol.handle("fleetd-test", () => new Response('<iframe ' + spec.sandbox + ' referrerpolicy="no-referrer" src="' + spec.url + '"></iframe><script>addEventListener("message", (e) => { if (e.data && e.data.R) console.log("R" + JSON.stringify(e.data.R)); });</script>', { headers: { "content-type": "text/html" } }));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  win.webContents.on("console-message", (e, _level, legacy) => {
    const m = typeof e.message === "string" ? e.message : legacy;
    if (typeof m === "string" && m.startsWith("R{")) process.stdout.write(m.slice(1) + "\\n");
  });
  void win.loadURL("fleetd-test://app/");
});
`;

const electronBinary = createRequire(import.meta.url)("electron") as unknown as string;

/** Runs `html` as the app frames it; resolves with what the page posted, `settleMs` after it posted it. */
const run = async (html: string, settleMs: number, sandboxed = true): Promise<Record<string, unknown>> => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "artifact-engine-"));
  const frames = new ArtifactFrames();
  const { url } = frames.put(html);
  const response = frames.response(url);
  const headers = Object.fromEntries(response.headers);
  if (!sandboxed) headers["content-security-policy"] = ARTIFACT_CSP.replace(/; sandbox [^;]*/u, "");
  const sandbox = sandboxed ? 'sandbox="allow-scripts"' : "";
  writeFileSync(join(dir, "spec.json"), JSON.stringify({ url, body: await response.text(), headers, sandbox }));
  writeFileSync(join(dir, "main.cjs"), MAIN);
  const child = spawn(electronBinary, ["--no-sandbox", "--ozone-platform=headless", `--user-data-dir=${join(dir, "profile")}`, join(dir, "main.cjs")], {
    env: { ...process.env, FENCE_SPEC: join(dir, "spec.json"), ELECTRON_ENABLE_LOGGING: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = Date.now();
  // When Electron reached app ready, so a late answer says whether the start or the page took the time.
  let ready: number | undefined;
  let out = "";
  let err = "";
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const start = ready === undefined ? "Electron never reached app ready" : `Electron was ready after ${String(ready)} ms`;
        reject(new Error(`no answer from the page in 20 s (${start})\n${err}`));
      }, 20_000);
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (ready === undefined && out.startsWith("ready\n")) ready = Date.now() - started;
        const line = out.split("\n").find((l) => l.startsWith("{"));
        if (line === undefined) return;
        clearTimeout(timer);
        setTimeout(() => resolve(JSON.parse(line) as Record<string, unknown>), settleMs);
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`electron exited ${String(code)}\n${err}`)));
    });
  } finally {
    // Electron writes its profile in `dir` until it has exited, and its helpers a moment longer: removing the dir
    // right after the kill failed with ENOTEMPTY when the page answered at once (the chart's 0 ms settle).
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill();
      await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
};

describe("an HTML artifact in Electron", () => {
  it.each([
    ["sandboxed, as the app frames it", true],
    ["without its sandbox", false],
  ])("reaches no window with WebRTC, and sends no STUN: %s", async (_, sandboxed) => {
    const udp = createSocket("udp4");
    const packets: Buffer[] = [];
    udp.on("message", (m) => packets.push(m));
    await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
    try {
      const { staticFrames, staticSrcdoc, framesLeft, ...tries } = await run(attacks(udp.address().port), 1000, sandboxed);
      // Every try at once, so a failure shows each way through.
      expect({ ...tries, staticFrames, staticSrcdoc, framesLeft, stunPackets: packets.length }).toEqual({
        ...Object.fromEntries(Object.keys(tries).map((k) => [k, "refused"])),
        staticFrames: 0,
        staticSrcdoc: undefined,
        framesLeft: 0,
        stunPackets: 0,
      });
    } finally {
      udp.close();
    }
  }, 30_000);

  it("still draws a report's chart with its inline scripts and styles", async () => {
    expect(await run(chart, 0)).toEqual({ rects: 3, bar: "rgb(59, 130, 246)", canvas: "255,0,0,255", label: "total 15" });
  }, 30_000);
});
