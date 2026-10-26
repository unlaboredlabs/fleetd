// fleetd.sh's landing page fits every width. Run by CI's `site` job from the repo root:
//   node .github/site-layout-check.mjs
// Renders site/home.html in headless Chrome ($CHROME, else google-chrome or chromium on PATH) at each width below and
// fails, one line per width, when the page scrolls sideways: something on it is wider than the viewport.
// It talks to Chrome over the DevTools protocol on node's own WebSocket, so it needs no npm install. The page names its
// fonts and images from the site root (/fonts/...), which a file:// page would look for at the filesystem root, so
// those requests are answered from site/: the text wraps as it does on fleetd.sh.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WIDTHS = [320, 390, 768, 1001, 1180, 1280, 1366, 1440, 1600, 1920];
const HEIGHT = 900;
const SITE = path.resolve("site");
const PAGE = `file://${SITE}/home.html`;
const TYPES = { ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" };

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    if (spawnSync("sh", ["-c", `command -v ${name}`]).status === 0) return name;
  }
  throw new Error("no Chrome: set $CHROME or put google-chrome or chromium on PATH");
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "site-layout-"));
const chrome = spawn(
  chromePath(),
  ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "about:blank"],
  // Its own process group, so that killing it takes its renderer and GPU processes along.
  { stdio: ["ignore", "ignore", "pipe"], detached: true },
);
const kill = () => {
  try {
    process.kill(-chrome.pid, "SIGKILL");
  } catch {}
};
const exited = new Promise((resolve) => chrome.on("exit", resolve));
/** Kills Chrome and, once it is gone (it writes its profile until then), removes the profile. */
async function stop() {
  kill();
  await exited;
  fs.rmSync(profile, { recursive: true, force: true });
}
// On an error the finally below hasn't run: kill Chrome at least, and remove what's there.
process.on("exit", () => (kill(), fs.rmSync(profile, { recursive: true, force: true })));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

/** Chrome prints its DevTools endpoint on stderr once it listens. */
const endpoint = await new Promise((resolve, reject) => {
  let err = "";
  // GitHub runners sometimes take well over 30 s to start Chrome (it waits on a session bus that isn't there).
  const timer = setTimeout(() => reject(new Error(`Chrome didn't start in 120 s:\n${err}`)), 120_000);
  chrome.stderr.on("data", (d) => {
    err += d;
    const m = err.match(/DevTools listening on (ws:\/\/\S+)/u);
    if (m) clearTimeout(timer), resolve(m[1]);
  });
  chrome.on("exit", (code) => reject(new Error(`Chrome exited (${code}):\n${err}`)));
  chrome.on("error", (e) => reject(new Error(`can't start Chrome: ${e.message}`)));
});

const ws = new WebSocket(endpoint);
await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = () => reject(new Error(`can't reach ${endpoint}`)))));
let nextId = 0;
const pending = new Map();
const listeners = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
    else p.resolve(m.result);
  } else listeners.get(m.method)?.(m.params);
};
// Chrome gone mid-run: fail what's waiting on it rather than leave the check hanging.
ws.onclose = () => {
  for (const p of pending.values()) p.reject(new Error(`${p.method}: Chrome closed the DevTools connection`));
  pending.clear();
};
let session;
function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params, sessionId: session }));
  return new Promise((resolve, reject) => pending.set(id, { method, resolve, reject }));
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
({ sessionId: session } = await send("Target.attachToTarget", { targetId, flatten: true }));

// file:///fonts/x.woff2 is site/fonts/x.woff2; the page itself and anything inside site/ load as they are.
listeners.set("Fetch.requestPaused", ({ requestId, request }) => {
  const p = decodeURIComponent(new URL(request.url).pathname);
  const file = path.join(SITE, p);
  if (p.startsWith(SITE) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    send("Fetch.continueRequest", { requestId }).catch(() => {});
    return;
  }
  const headers = [{ name: "Content-Type", value: TYPES[path.extname(file)] ?? "application/octet-stream" }, { name: "Access-Control-Allow-Origin", value: "*" }];
  send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: headers, body: fs.readFileSync(file).toString("base64") }).catch(() => {});
});
await send("Fetch.enable", { patterns: [{ urlPattern: "file://*" }] });
await send("Page.enable");

/** The page's width against the viewport's, and what sticks out past it, once the page's fonts and images are in. */
const MEASURE = `(async () => {
  for (const img of document.images) img.loading = "eager";
  await Promise.all([...document.images].map((img) => img.complete || new Promise((r) => (img.onload = img.onerror = r))));
  await document.fonts.ready;
  const fonts = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family + " " + f.weight);
  const viewport = document.documentElement.clientWidth;
  const wide = [...document.body.querySelectorAll("*")]
    .filter((el) => el.getBoundingClientRect().right > viewport + 0.5)
    .slice(0, 3)
    .map((el) => el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ").join(".") : "") + " (" + Math.round(el.getBoundingClientRect().right) + "px)");
  return { viewport, scroll: document.documentElement.scrollWidth, fonts, wide };
})()`;

const problems = [];
try {
  for (const width of WIDTHS) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => listeners.set("Page.loadEventFired", resolve));
    await send("Page.navigate", { url: PAGE });
    await loaded;
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression: MEASURE, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(`measuring at ${width}px: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    const { viewport, scroll, fonts, wide } = result.value;
    if (!fonts.some((f) => f.startsWith("Plex"))) throw new Error(`at ${width}px the page's Plex font didn't load, so its text wouldn't wrap as on fleetd.sh`);
    if (scroll > viewport) problems.push(`${width}px: the page is ${scroll}px wide, wider than the ${viewport}px viewport; first past the edge: ${wide.join(", ")}`);
  }
} finally {
  ws.close();
  await stop();
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`site/home.html: ${problems.length} layout problem${problems.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`site/home.html: nothing is wider than the viewport at ${WIDTHS.join(", ")}px`);
