// fleetd.sh's pages fit every width. Run by CI's `site` job from the repo root:
//   node .github/site-layout-check.mjs
// Renders each of PAGES (site/home.html, site/pricing.html, site/404.html, the legal and support pages and the drafts) in headless Chrome ($CHROME, else google-chrome or chromium on PATH) at each width below and
// fails, one line per page and width, when the page scrolls sideways: something on it is wider than the viewport.
// It also checks the landing page's device stage once its foldable has opened (STAGE_WIDTHS, at 2x): nothing drawn
// beside the two devices (no hairline from the folding half, the line a person found on Nov 23), no line on the
// stage's floor, and neither device past the stage's edge (stray(), below).
// It talks to Chrome over the DevTools protocol on node's own WebSocket, so it needs no npm install. The page names its
// fonts and images from the site root (/fonts/...), which a file:// page would look for at the filesystem root, so
// those requests are answered from site/: the text wraps as it does on fleetd.sh.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";

const WIDTHS = [320, 390, 768, 1001, 1180, 1280, 1366, 1440, 1600, 1920];
const HEIGHT = 900;
const SITE = path.resolve("site");
/** The widths the stage is checked at, at 2x in a window 800 px tall, scrolled to as a reader does: laptops' and
 * wider screens', and a phone's (the phone alone). At the first, the window is also resized while the phone unfolds. */
const STAGE_WIDTHS = [1280, 1440, 1512, 1728, 390];
const PAGES = ["home.html", "pricing.html", "404.html", "terms.html", "privacy.html", "refunds.html", "imprint.html", "support.html", "security.html", "subprocessors.html", "dpa.html"];
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webm": "video/webm", ".json": "application/json" };

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

/** A PNG Chrome captured (8-bit RGB or RGBA, not interlaced) as rows of RGB. */
function decodePng(buf) {
  let at = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString("ascii", at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : 3; if (data[8] !== 8 || data[12] !== 0) throw new Error("unexpected PNG format"); }
    if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * channels, out = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      cur[i] = (line[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
    for (let x = 0; x < width; x++) for (let k = 0; k < 3; k++) out[(y * width + x) * 3 + k] = cur[x * channels + k];
    prev = cur;
  }
  return { width, height, px: out };
}

/** The stage once the foldable has opened (or straight away with no animation): its geometry, in CSS px. */
const STAGE = `(async () => {
  const duo = document.getElementById("duo");
  const until = performance.now() + 25000;
  while (duo.dataset.fold !== undefined && duo.dataset.fold !== "open" && performance.now() < until) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const lap = document.querySelector(".lap .lid");
  // In the page's own coordinates, as a screenshot's clip takes them.
  const floor = box(document.querySelector(".floor"));
  return { fold: duo.dataset.fold ?? "still", floor: { ...floor, x: floor.x + scrollX, y: floor.y + scrollY }, at: [scrollX, scrollY], body: box(duo.querySelector(".whole")), lap: lap.offsetWidth ? box(lap) : null };
})()`;

/**
 * Stray pixels on the stage at `width`, with the foldable open: what the phone draws besides its body and its soft
 * shadow (must be nothing), what the body draws past its rim, thin lines on the floor outside both devices, and either
 * device past the stage's edge. Pictures with parts hidden are compared, at 2x.
 */
async function stray(width, resize = width === STAGE_WIDTHS[0]) {
  const S = 2;
  const metrics = (w) => send("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: S, mobile: false });
  await metrics(width);
  const loaded = new Promise((resolve) => listeners.set("Page.loadEventFired", resolve));
  await send("Page.navigate", { url: `file://${SITE}/home.html` });
  await loaded;
  // Scrolled to, in two steps as a wheel does; resized while it unfolds, at one width.
  const scroll = (y) => send("Runtime.evaluate", { expression: `scrollBy(0, ${y})` });
  await new Promise((r) => setTimeout(r, 300));
  await scroll(250);
  await new Promise((r) => setTimeout(r, 200));
  await send("Runtime.evaluate", { expression: `document.querySelector(".stage").scrollIntoView({ block: "center" })` });
  if (resize) {
    await new Promise((r) => setTimeout(r, 900));
    await metrics(width - 120);
    await new Promise((r) => setTimeout(r, 250));
    await metrics(width);
  }
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression: STAGE, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(`the stage at ${width}px: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  const g = result.value;
  if (g.fold !== "open" && g.fold !== "still") return [`the foldable never opened (${g.fold})`];
  const shot = async (css) => {
    await send("Runtime.evaluate", { expression: `(() => { let s = document.getElementById("stray-check"); if (!s) { s = document.createElement("style"); s.id = "stray-check"; document.head.append(s); } s.textContent = ${JSON.stringify(css)}; })()` });
    await new Promise((r) => setTimeout(r, 150));
    const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: g.floor.x, y: g.floor.y, width: g.floor.w, height: g.floor.h, scale: 1 } });
    return decodePng(Buffer.from(data, "base64"));
  };
  // Its shadows (the soft cast one and the contact one under its edge) are meant to be beside it.
  const NO_SHADE = "#duo :is(.shade,.contact){visibility:hidden!important}";
  const all = await shot(NO_SHADE);
  const body = await shot(`${NO_SHADE} #duo > :not(.whole){visibility:hidden!important}`);
  const none = await shot(`${NO_SHADE} #duo > *{visibility:hidden!important}`);
  const full = await shot("");
  await shot("");
  const { width: W, height: H } = full;
  // The devices' boxes are the window's coordinates, the floor's the page's.
  const fx = g.floor.x - g.at[0], fy = g.floor.y - g.at[1];
  const box = (r, m) => [Math.round((r.x - fx) * S) - m, Math.round((r.y - fy) * S) - m, Math.round((r.x - fx + r.w) * S) + m, Math.round((r.y - fy + r.h) * S) + m];
  const inside = ([x0, y0, x1, y1], x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
  const differ = (a, b, i) => Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2])) > 6;
  const found = [];
  // A stray mark is a line: 20 or more of the points in one column or row. A few scattered points are a re-raster of
  // an antialiased edge as layers are hidden, which headless Chrome without a GPU does a hair differently.
  const report = (what, pts) => {
    const per = (k) => { const m = new Map(); for (const p of pts) m.set(p[k], (m.get(p[k]) ?? 0) + 1); return Math.max(0, ...m.values()); };
    if (per(0) < 20 && per(1) < 20) return;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    found.push(`${what}: ${pts.length} px at x ${Math.min(...xs)}-${Math.max(...xs)}, y ${Math.min(...ys)}-${Math.max(...ys)} (2x, from the stage's corner)`);
  };
  // Beside the body, near it: all its other parts can reach (hiding layers re-rasters far corners and the body's own
  // screen a hair), from 1 device px past its box (a hairline beside it sits that close); the body's own rim takes up
  // to 3 device px past its box.
  const near = box(g.body, 80), rim = box(g.body, 3), edge = box(g.body, 1);
  const extra = [], past = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    if (inside(near, x, y) && !inside(edge, x, y) && differ(all, body, i)) extra.push([x, y]);
    if (inside(near, x, y) && !inside(rim, x, y) && differ(body, none, i)) past.push([x, y]);
  }
  report("the foldable draws beside its body", extra);
  report("the foldable's body draws past its rim", past);
  // Thin lines on the floor: a pixel unlike both neighbours 3 px away, 30 or more of them in one column or row.
  const lum = (x, y) => { const i = (y * W + x) * 3; return (full.px[i] + full.px[i + 1] + full.px[i + 2]) / 3; };
  // (Each device's box and a little more: the phone's side keys stand up to 6 device px above its top edge.)
  const devices = [box(g.body, 8), ...(g.lap ? [box(g.lap, 5)] : [])];
  const floor = (x, y) => x >= 8 && y >= 8 && x < W - 8 && y < H - 8 && !devices.some((d) => inside(d, x, y));
  const cols = new Map(), rows = new Map();
  for (let y = 3; y < H - 3; y++) for (let x = 3; x < W - 3; x++) {
    if (!floor(x, y)) continue;
    const l = lum(x, y);
    if (Math.abs(l - (lum(x - 3, y) + lum(x + 3, y)) / 2) > 12) cols.set(x, (cols.get(x) ?? 0) + 1);
    if (Math.abs(l - (lum(x, y - 3) + lum(x, y + 3)) / 2) > 12) rows.set(y, (rows.get(y) ?? 0) + 1);
  }
  const lines = (m) => [...m].filter(([, n]) => n >= 30).map(([k]) => k);
  if (lines(cols).length) found.push(`a vertical line on the stage's floor at x ${lines(cols).slice(0, 4).join(", ")} (2x)`);
  if (lines(rows).length) found.push(`a horizontal line on the stage's floor at y ${lines(rows).slice(0, 4).join(", ")} (2x)`);
  for (const [name, r] of [["the phone", g.body], ["the laptop", g.lap]]) {
    if (r && (r.x < fx - 0.5 || r.y < fy - 0.5 || r.x + r.w > fx + g.floor.w + 0.5 || r.y + r.h > fy + g.floor.h + 0.5)) found.push(`${name} runs past the stage's edge`);
  }
  return found;
}

const problems = [];
try {
  for (const page of PAGES) for (const width of WIDTHS) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => listeners.set("Page.loadEventFired", resolve));
    await send("Page.navigate", { url: `file://${SITE}/${page}` });
    await loaded;
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression: MEASURE, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(`measuring ${page} at ${width}px: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    const { viewport, scroll, fonts, wide } = result.value;
    if (!fonts.some((f) => f.startsWith("Plex"))) throw new Error(`at ${width}px ${page}'s Plex font didn't load, so its text wouldn't wrap as on fleetd.sh`);
    if (scroll > viewport) problems.push(`${page} at ${width}px: the page is ${scroll}px wide, wider than the ${viewport}px viewport; first past the edge: ${wide.join(", ")}`);
  }
  for (const width of STAGE_WIDTHS) problems.push(...(await stray(width)).map((p) => `home.html at ${width}px: ${p}`));
} finally {
  ws.close();
  await stop();
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`site: ${problems.length} layout problem${problems.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`site/${PAGES.join(", site/")}: nothing is wider than the viewport at ${WIDTHS.join(", ")}px`);
console.log(`site/home.html: nothing stray on the device stage at ${STAGE_WIDTHS.join(", ")}px`);
