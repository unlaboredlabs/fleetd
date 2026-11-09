// Platform bits the DOM checks can't see: bundled fonts, the macOS app menu, and a shot of the real window with
// its native traffic lights (a page screenshot leaves them out).

import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { check, launch, pngSize, resultsDir, setNativeView, setView, type Shot, settle, show } from "./harness.ts";
import { sizes, themes } from "./registry.ts";

test.describe.configure({ mode: "parallel" });

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "system-ui", "ui-monospace", "ui-sans-serif"]);

test("every text face is a font the app bundles, never a system fallback", async () => {
  const { page, close } = await launch("typical");
  try {
    await show(page, "shell", "#/");
    const missing = await page.evaluate((generic) => {
      const loaded = new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, "")));
      const used = new Set<string>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || !n.textContent?.trim()) continue;
        const first = getComputedStyle(el).fontFamily.split(",")[0]?.trim().replace(/["']/g, "");
        if (first) used.add(first);
      }
      return [...used].filter((f) => !generic.includes(f) && !loaded.has(f));
    }, [...GENERIC_FAMILIES]);
    expect(missing, "font families used for text but not bundled and loaded").toEqual([]);
  } finally {
    await close();
  }
});

test("the macOS app menu has an Edit menu wired to the text actions", async () => {
  test.skip(process.platform !== "darwin", "macOS only");
  const { app, close } = await launch("typical");
  try {
    const roles = await app.evaluate(({ Menu }) => {
      const edit = Menu.getApplicationMenu()?.items.find((i) => i.role?.toLowerCase() === "editmenu" || i.label === "Edit");
      return (edit?.submenu?.items ?? []).map((i) => i.role?.toLowerCase() ?? "");
    });
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectall"]) expect(roles).toContain(role);
  } finally {
    await close();
  }
});

test("the macOS window, traffic lights included, for the contact sheet", async () => {
  test.skip(process.platform !== "darwin", "macOS only");
  const { app, page, close } = await launch("typical");
  try {
    await show(page, "shell", "#/");
    const dir = path.join(resultsDir, "png");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(resultsDir, "shots"), { recursive: true });
    // A size every runner's screen holds (the smallest is 1024×768), shown as the real window lays it out: no
    // viewport override, which would lay out a wider page than the window and crop it.
    const size = "window";
    for (const theme of themes) {
      await setNativeView(app, page, size, theme);
      await settle(page);
      await page.waitForFunction((t) => document.documentElement.dataset["theme"] === t, theme, { timeout: 5_000 });
      const source = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getMediaSourceId() ?? "");
      // "window:<CGWindowID>:0"
      const windowId = source.split(":")[1];
      if (!windowId) throw new Error(`no window id in "${source}"`);
      const file = path.join(resultsDir, "png", `window--typical--${size}--${theme}.png`);
      // screencapture takes what the window server last got from the window, which can be a frame from before the
      // theme switched: bring the window up, make it paint, and accept the picture only when its background
      // matches the theme.
      let luminance = -1;
      for (let attempt = 0; attempt < 3 && (luminance < 0 || luminance < 128 !== (theme === "dark")); attempt++) {
        await app.evaluate(async ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) return;
          win.moveTop();
          win.webContents.invalidate();
          await win.webContents.capturePage();
        });
        await settle(page);
        try {
          execFileSync("screencapture", ["-x", "-o", `-l${windowId}`, file]);
        } catch (error) {
          // Without the Screen Recording permission this is an extra picture lost, not a QA failure.
          test.skip(true, `screencapture failed: ${String(error)}`);
        }
        luminance = await app.evaluate(({ nativeImage }, f) => {
          // The median of a grid over the lower half: the page background, whatever panels sit on it.
          const image = nativeImage.createFromPath(f);
          const { width, height } = image.getSize();
          const bitmap = image.toBitmap();
          const samples: number[] = [];
          for (let gx = 1; gx < 10; gx++) {
            for (let gy = 5; gy < 10; gy++) {
              const i = (Math.floor((height * gy) / 10 - 1) * width + Math.floor((width * gx) / 10)) * 4;
              // BGRA
              samples.push(0.0722 * (bitmap[i] ?? 0) + 0.7152 * (bitmap[i + 1] ?? 0) + 0.2126 * (bitmap[i + 2] ?? 0));
            }
          }
          samples.sort((a, b) => a - b);
          return samples[Math.floor(samples.length / 2)] ?? -1;
        }, file);
      }
      expect(luminance < 128, `the ${theme} window shot's background has luminance ${Math.round(luminance)}`).toBe(theme === "dark");
      // screencapture writes at the display's own scale, whatever the app was told; the label says what the file is.
      const real = pngSize(file).width / sizes[size].width;
      expect(Number.isInteger(real) && pngSize(file).height === sizes[size].height * real, `window shot is ${JSON.stringify(pngSize(file))}`).toBe(true);
      const name = `window--typical--${size}--${theme}--darwin@${real}x`;
      const png = path.join("png", `${name}.png`);
      renameSync(file, path.join(resultsDir, png));
      const shot: Shot = { screen: "window", fixture: "typical", size, theme, scale: real, platform: "darwin", png, scrolled: [], findings: [] };
      writeFileSync(path.join(resultsDir, "shots", `${name}.json`), JSON.stringify(shot, null, 2));
    }
  } finally {
    await close();
  }
});

test("a window whose page dies reloads at its route and logs why; crash dumps go beside the log", async () => {
  const { app, page, close } = await launch("typical");
  try {
    await show(page, "settings.general", "#/settings/general");
    const { logs, dumps } = await app.evaluate(({ app: a }) => ({ logs: a.getPath("logs"), dumps: a.getPath("crashDumps") }));
    const log = () => (existsSync(path.join(logs, "app.log")) ? readFileSync(path.join(logs, "app.log"), "utf8") : "(no app.log)");
    // Playwright's page stays on the dead renderer, so the reloaded one is read through main. A MutationObserver,
    // not requestAnimationFrame, which a window in the background may never run. The renderer is killed rather than
    // crashed with forcefullyCrashRenderer: on the Linux runners that one logged "Crashing because hung" and then never
    // went (no render-process-gone), so the reload this checks never had a cause.
    const screen = await app
      .evaluate(async ({ BrowserWindow }) => {
        const page = BrowserWindow.getAllWindows()[0]?.webContents;
        if (!page) throw new Error("the app opened no window");
        const within = <T,>(what: string, p: Promise<T>) =>
          Promise.race([p, new Promise<never>((_, fail) => setTimeout(() => fail(new Error(`no ${what} within 20 s`)), 20_000))]);
        const gone = new Promise((done) => page.once("render-process-gone", () => done(null)));
        const reloaded = new Promise((done) => page.once("did-finish-load", () => done(null)));
        process.kill(page.getOSProcessId(), "SIGKILL");
        await within("render-process-gone", gone);
        await within("reload", reloaded);
        return within(
          "settings screen",
          page.executeJavaScript(
            `new Promise((done) => { const found = () => document.querySelector('[data-screen="settings.general"]'); if (found()) return done("settings.general"); new MutationObserver((_, o) => { if (found()) { o.disconnect(); done("settings.general"); } }).observe(document, { subtree: true, childList: true, attributes: true }); })`,
          ) as Promise<string>,
        );
      })
      .catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\napp.log:\n${log()}`);
      });
    expect(screen).toBe("settings.general");
    expect(log()).toMatch(/main v\S+ #\/settings\/general: The window's page died \((?:crashed|killed), exit code -?\d+\); reloading it/u);
    // crashReporter is on, with its database beside the log (a killed renderer leaves no dump).
    expect(dumps).toBe(path.join(logs, "crashes"));
    expect(existsSync(path.join(dumps, "settings.dat"))).toBe(true);
  } finally {
    await close();
  }
});

// The chat's pill floats in the top row, which is the macOS drag region, as is the panel's tab row beside it. A click
// there must reach the pill, or the panel never closes on a Mac: here the window takes clicks as Electron's region
// says (the DOM checks' drag rule), then the pill closes the panel and opens it again.
test("the chat's pill closes the panel and opens it again", async () => {
  const { app, page, settled, close } = await launch("chat-waiting");
  try {
    await settled();
    await setView(app, page, "medium", "light");
    await show(page, "shell", "#/");
    const panel = page.getByRole("complementary", { name: "Project panel" });
    await panel.waitFor();
    const dragged = (await check(page, [])).filter((f) => f.check === "drag");
    expect(dragged, "controls a click on drags the macOS window instead").toEqual([]);
    const pill = page.locator('[data-opens="panel"]');
    await expect(pill).toHaveAttribute("aria-pressed", "true");
    await pill.click();
    await panel.waitFor({ state: "detached" });
    await expect(pill).toHaveAttribute("aria-pressed", "false");
    await pill.click();
    await panel.waitFor();
  } finally {
    await close();
  }
});

// An HTML artifact (W367) runs its own scripts and nothing else: in the real app, a page framed as the Artifacts tab
// frames it (main's fleetd-artifact:// address, sandbox allow-scripts) tries every way out it has: fetch, XHR, an
// image, a stylesheet, a WebSocket, a beacon, a popup, WebRTC (STUN over UDP, TURN over TCP, from its own window and
// from a blank frame it makes), its own navigation, the app's page, the bridge and storage. A server on this machine
// counts what reaches it, over TCP and UDP: nothing may. The real chart artifact draws itself meanwhile.
test("an HTML artifact runs its scripts with no network and no reach into the app", async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.end("ok");
  });
  server.on("connection", () => hits.push("tcp"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const udp = createSocket("udp4");
  udp.on("message", () => hits.push("udp"));
  await new Promise<void>((done) => udp.bind(0, "127.0.0.1", done));
  const udpPort = udp.address().port;
  const { page, settled, close } = await launch("artifacts-published");
  try {
    await settled();
    await show(page, "shell", "#/project/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22/artifacts/build-times");
    const chart = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(chart.locator("rect.bar")).toHaveCount(6);

    const out = `http://127.0.0.1:${String(port)}`;
    const probe = `<!doctype html><script>
      const tried = {};
      const attempt = async (name, fn) => { try { const v = await fn(); tried[name] = v === undefined ? "ran" : String(v); } catch (e) { tried[name] = "refused"; } };
      (async () => {
        await attempt("fetch", () => fetch("${out}/fetch").then(() => "reached"));
        await attempt("xhr", () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.onload = () => ok("reached"); x.onerror = no; x.open("GET", "${out}/xhr"); x.send(); }));
        await attempt("image", () => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok("reached"); i.onerror = no; i.src = "${out}/img"; }));
        await attempt("socket", () => new Promise((ok, no) => { const w = new WebSocket("ws://127.0.0.1:${String(port)}/ws"); w.onopen = () => ok("reached"); w.onerror = no; }));
        await attempt("beacon", () => navigator.sendBeacon("${out}/beacon", "x") ? "queued" : "refused");
        const ice = { iceServers: [{ urls: "stun:127.0.0.1:${String(udpPort)}" }, { urls: "turn:127.0.0.1:${String(port)}?transport=tcp", username: "u", credential: "p" }] };
        const rtc = async (Peer) => {
          const pc = new Peer(ice);
          pc.createDataChannel("out");
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise((r) => setTimeout(r, 1500));
          return "made";
        };
        await attempt("rtc", () => rtc(RTCPeerConnection));
        await attempt("rtcFrame", () => {
          const f = document.createElement("iframe");
          document.body.appendChild(f);
          return rtc(frames[frames.length - 1].RTCPeerConnection);
        });
        await attempt("popup", () => window.open("${out}/popup") === null ? "refused" : "opened");
        await attempt("parent", () => window.parent.document.title);
        await attempt("bridge", () => typeof window.fleetd + "/" + typeof window.parent.fleetd);
        await attempt("storage", () => localStorage.length);
        await attempt("cookie", () => document.cookie = "a=1");
        const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "${out}/css"; document.head.appendChild(css);
        await new Promise((r) => setTimeout(r, 500));
        parent.postMessage({ probe: tried }, "*");
        location.href = "${out}/navigate";
      })();
    </script>`;
    const tried = await page.evaluate(async (html) => {
      // The app's own bridge, as its page uses it (the QA specs don't see the renderer's types).
      const bridge = (window as unknown as { fleetd: { artifactFrame: (page: string) => Promise<{ url: string }> } }).fleetd;
      const { url } = await bridge.artifactFrame(html);
      const got = new Promise<Record<string, string>>((done) => window.addEventListener("message", (e: MessageEvent<{ probe?: Record<string, string> }>) => e.data.probe && done(e.data.probe)));
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.src = url;
      document.body.appendChild(frame);
      return got;
    }, probe);
    // Its scripts ran, and every way out was refused (a beacon queues before the CSP drops it: the server's count says).
    expect({ ...tried, beacon: "refused" }).toEqual({
      fetch: "refused",
      xhr: "refused",
      image: "refused",
      socket: "refused",
      beacon: "refused",
      rtc: "refused",
      rtcFrame: "refused",
      popup: "refused",
      parent: "refused",
      bridge: "refused",
      storage: "refused",
      cookie: "refused",
    });
    // Its own navigation away, last, never left either.
    await page.waitForTimeout(1_000);
    expect(hits, "requests that reached the network from an artifact").toEqual([]);
  } finally {
    await close();
    server.close();
    udp.close();
  }
});

// A link in an HTML artifact opens in the browser, as a Markdown link does, and the report stays on screen; a link
// its script posts without a click opens nothing.
test("a link clicked in an HTML artifact opens in the browser and the report stays", async () => {
  const { app, page, settled, close } = await launch("artifacts-published");
  try {
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = (url: string) => (opened.push(url), Promise.resolve());
    });
    await settled();
    await show(page, "shell", "#/project/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22/artifacts/build-times");
    const chart = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(chart.locator("rect.bar")).toHaveCount(6);
    // Unprompted, a script's message or click opens nothing, and its page never holds the key.
    expect(await chart.locator("body").evaluate(() => document.documentElement.outerHTML.includes("key:"))).toBe(false);
    await chart.locator("body").evaluate(() => parent.postMessage({ fleetdArtifactLink: "https://example.com/unasked" }, "*"));
    await chart.locator("#source").evaluate((a: HTMLElement) => a.click());
    await chart.locator("#source").click();
    // The click goes frame → page → main; a hosted macOS runner has taken more than 500 ms for it.
    await expect
      .poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened))
      .toEqual(["https://github.com/acme/storefront/actions/workflows/release.yml"]);
    // The frame never left its page.
    await expect(chart.locator("rect.bar")).toHaveCount(6);
  } finally {
    await close();
  }
});
