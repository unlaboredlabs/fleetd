// The landing page's foldable unfolding, rendered offline: site/hero/unfold-{wide,phone}-{dark,light}.{webm,mp4}.
//
//   FOOTAGE=<dir> FFMPEG=<ffmpeg with libvpx-vp9 and libx264> node scripts/hero-unfold.mjs
//
// A turn in CSS perspective is rastered soft while it moves (Chrome draws it at a lower scale until it stops), so the
// page plays this video of it instead, sharp at 2x in every browser. Each frame is site/home.html itself in headless
// Chrome at 2x (?unfold-render: the page's window.heroUnfold sets the phone to a moment of its unfold, its animations
// paused there), held still until it is drawn sharp, and captured over the video's place (.unfold); the first frame is
// the phone shut and the last the phone open, as the page draws them, so the page hands over with nothing to see.
// FOOTAGE is the phone app on the iPhone Duo simulator unfolding, the system's own transition, its inner display as
// f001.png… at 60 fps, 1376x968 (site/README.md says how to record it); it plays on the inner display from the moment
// the leaf stands up, then fades into the still the page shows. Run it again when the page's phone, its pictures or
// the footage change.
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "..");
// Playwright from app/desktop (its QA runs on it): `pnpm install` there first.
const { chromium } = createRequire(path.join(repo, "app/desktop/package.json"))("@playwright/test");
const site = path.join(repo, "site");
const footage = process.env.FOOTAGE;
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
if (!footage || !fs.existsSync(path.join(footage, "f001.png"))) throw new Error("FOOTAGE: a folder of the recording's frames, f001.png…");
// From the frame where iOS's own blur has cleared (FROM, the recording's 20th frame by default): its clear frames only.
const feet = fs.readdirSync(footage).filter((f) => /^f\d+\.png$/.test(f)).sort().slice(Number(process.env.FROM ?? 20) - 1);
const FPS = 60;
/** After the footage ends, it fades into the page's still over this many frames. */
const FADE = 8;

// site/ and the footage, as Vercel serves the site.
const types = { ".html": "text/html", ".js": "text/javascript", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".jpg": "image/jpeg" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = p.startsWith("/__footage/") ? path.join(footage, path.basename(p)) : path.join(site, p === "/" ? "home.html" : p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// Chrome itself ($CHROME, else google-chrome or chromium on PATH), as the page's readers have it.
const chrome = process.env.CHROME ?? ["google-chrome", "chromium"].map((n) => spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }).stdout.trim()).find(Boolean);
const browser = await chromium.launch({ executablePath: chrome, args: ["--hide-scrollbars"] });
const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "hero-unfold-"));
try {
  // The wide stage at the page's measure (1152 px, from 1512 px wide up: a laptop's Chrome and wider, where the frames
  // then lie on the page's own pixels), and a phone's.
  // ONLY=wide-dark (or phone-light, …) renders just that one.
  for (const [layout, width, height] of [["wide", 1512, 1400], ["phone", 390, 1100]]) {
    for (const theme of ["dark", "light"]) {
      if (process.env.ONLY && process.env.ONLY !== `${layout}-${theme}`) continue;
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: "no-preference" });
      await page.addInitScript((t) => localStorage.setItem("starlight-theme", t), theme);
      await page.goto(`${base}/home.html?unfold-render`, { waitUntil: "load" });
      // The stage's pictures (the page's lazy ones below it never load here).
      await page.evaluate(() => Promise.all([...document.querySelectorAll(".stage img")].map((i) => i.decode().catch(() => {}))));
      const { TOTAL, STAND } = await page.evaluate(() => ({ TOTAL: window.heroUnfold.TOTAL, STAND: window.heroUnfold.STAND }));
      // The video's place, snapped to device pixels as the page snaps it (home.html's `snap`), so its frames line up
      // with the page's own pixels.
      const clip = await page.evaluate(() => {
        const r = document.querySelector(".unfold").getBoundingClientRect();
        const d = (v) => Math.round(v * 2) / 2;
        return { x: d(r.left + scrollX), y: d(r.top + scrollY), width: d(r.width), height: d(r.height) };
      });
      const dir = path.join(work, `${layout}-${theme}`);
      fs.mkdirSync(dir);
      // Held until the browser has drawn it at rest, sharp: two frames and a little more.
      const still = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250)))));
      // How far the drawings of the displays lie off the page's own phone, as Chrome shows each (it rounds where it
      // puts each picture its own way): measured here, the phone drawn flat against the phone as the page shows it,
      // open and shut, and set as the page's nudges, so the video's first and last frames give way to the drawing
      // with nothing to see.
      // (`half`: only the box's left or right half, where the leaf lies.)
      const offset = async (selector, drawn, page_, half) => {
        const box = await page.evaluate(([selector, half]) => {
          const u = document.querySelector(".unfold").getBoundingClientRect(), r = document.querySelector(selector).getBoundingClientRect();
          const left = half === "right" ? r.left + r.width / 2 : r.left, right = half === "left" ? r.left + r.width / 2 : r.right;
          // In the shot's device pixels, a margin in from the display's rounded edge (and the hinge).
          return { x0: Math.ceil((left - u.left) * 2) + 12, y0: Math.ceil((r.top - u.top) * 2) + 12, x1: Math.floor((right - u.left) * 2) - 12, y1: Math.floor((r.bottom - u.top) * 2) - 12 };
        }, [selector, half]);
        await drawn();
        await still();
        const a = await page.screenshot({ clip });
        await page_();
        await still();
        const b = await page.screenshot({ clip });
        return page.evaluate(async ([a, b, box]) => {
          const load = async (png) => {
            const i = new Image();
            i.src = `data:image/png;base64,${png}`;
            await i.decode();
            const g = new OffscreenCanvas(i.width, i.height).getContext("2d");
            g.drawImage(i, 0, 0);
            const d = g.getImageData(0, 0, i.width, i.height).data;
            return [Float32Array.from({ length: i.width * i.height }, (_, k) => d[4 * k] * 0.3 + d[4 * k + 1] * 0.59 + d[4 * k + 2] * 0.11), i.width];
          };
          const [A, w] = await load(a), [B] = await load(b);
          const at = (x, y) => {
            const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, k = y0 * w + x0;
            return (A[k] * (1 - fx) + A[k + 1] * fx) * (1 - fy) + (A[k + w] * (1 - fx) + A[k + w + 1] * fx) * fy;
          };
          let best = [Infinity, 0, 0];
          for (let sy = -2; sy <= 2; sy += 0.125) for (let sx = -2; sx <= 2; sx += 0.125) {
            let e = 0;
            for (let y = box.y0; y < box.y1; y += 2) for (let x = box.x0; x < box.x1; x += 2) e += Math.abs(at(x - sx, y - sy) - B[y * w + x]);
            if (e < best[0]) best = [e, sx, sy];
          }
          return [best[1], best[2]];
        }, [a.toString("base64"), b.toString("base64"), box]);
      };
      // The leaf is drawn from the phone as the page shows it still, open and shut (2x shots, the hinge's barrels off,
      // as the right half carries them while the leaf turns), so it is as crisp as the phone at rest and the same.
      const faceClip = await page.evaluate(() => {
        const r = document.querySelector("#duo").getBoundingClientRect(), d = (v) => Math.floor(v * 2) / 2;
        const x = d(r.left + scrollX - 4), y = d(r.top + scrollY - 4);
        return { x, y, width: Math.ceil((r.right + scrollX + 4 - x) * 2) / 2, height: Math.ceil((r.bottom + scrollY + 4 - y) * 2) / 2 };
      });
      await page.evaluate(() => { window.heroUnfold.open(); for (const h of document.querySelectorAll("#duo .whole .hinge")) h.style.visibility = "hidden"; });
      await still();
      const openShot = await page.screenshot({ clip: faceClip });
      await page.evaluate(() => { for (const h of document.querySelectorAll("#duo .whole .hinge")) h.style.visibility = ""; window.heroUnfold.shut(); });
      await still();
      const shutShot = await page.screenshot({ clip: faceClip });
      await page.evaluate(([o, s, x, y]) => {
        const at = { x: x - scrollX, y: y - scrollY };
        window.heroUnfold.faces = { open: { src: `data:image/png;base64,${o}`, ...at }, shut: { src: `data:image/png;base64,${s}`, ...at } };
      }, [openShot.toString("base64"), shutShot.toString("base64"), faceClip.x, faceClip.y]);
      const faceOpen = await offset(
        "#duo",
        () => page.evaluate(async (t) => { window.heroUnfold.only = "face"; await window.heroUnfold.frame(t, null, 0); document.querySelector("#duo .whole").style.visibility = "hidden"; }, TOTAL),
        () => page.evaluate(() => { document.querySelector("#duo .whole").style.visibility = ""; window.heroUnfold.open(); }),
        "left",
      );
      await page.evaluate(() => window.heroUnfold.shut());
      const faceShut = await offset(
        "#duo",
        () => page.evaluate(() => window.heroUnfold.frame(0, null, 0)),
        () => page.evaluate(() => { window.heroUnfold.open(); window.heroUnfold.shut(); }),
        "right",
      );
      // The shots lie on the page's device pixels as the drawing does, so the leaf moves by whole pixels (a part of one
      // would blur the shot in it).
      const whole = (v) => v.map(Math.round);
      await page.evaluate(([o, s]) => { window.heroUnfold.nudgeFace = o; window.heroUnfold.nudgeFaceShut = s; window.heroUnfold.only = null; }, [whole(faceOpen), whole(faceShut)]);
      await page.evaluate(() => window.heroUnfold.open());
      const open = await offset(
        "#duo .whole .scr",
        () => page.evaluate(async (t) => { await window.heroUnfold.frame(t, null, 0); document.querySelector("#duo .whole").style.visibility = "hidden"; }, TOTAL),
        () => page.evaluate(() => { document.querySelector("#duo .whole").style.visibility = ""; window.heroUnfold.open(); }),
      );
      await page.evaluate(() => window.heroUnfold.shut());
      const shut = await offset(
        "#duo .o .scr",
        () => page.evaluate(() => window.heroUnfold.frame(0, null, 0)),
        () => page.evaluate(() => { window.heroUnfold.open(); window.heroUnfold.shut(); }),
      );
      if (process.env.VERBOSE) console.log(`${layout}-${theme}: the drawings lie ${open} (open) and ${shut} (shut) device pixels off the page's phone, the leaf ${faceOpen} and ${faceShut}`);
      await page.evaluate(([open, shut]) => { window.heroUnfold.nudge = open; window.heroUnfold.nudgeShut = shut; }, [open, shut]);
      // The unfold, and long enough after it for the footage to have faded into the still before the last frame.
      const frames = Math.max(Math.round(TOTAL * FPS), Math.ceil(STAND * FPS) + feet.length + FADE + 2);
      let n = 0;
      const shot = async () => page.screenshot({ path: path.join(dir, `${String(n++).padStart(4, "0")}.png`), clip });
      await page.evaluate(() => window.heroUnfold.shut());
      await still();
      await shot();
      for (let i = 1; i < frames; i++) {
        const t = i / FPS;
        const k = Math.floor((t - STAND) * FPS);
        const foot = k < 0 ? null : `/__footage/${feet[Math.min(feet.length - 1, k)]}`;
        const fade = k < feet.length ? 1 : Math.max(0, 1 - (k - feet.length + 1) / FADE);
        await page.evaluate(([t, foot, fade]) => window.heroUnfold.frame(t, foot, fade), [t, foot, fade]);
        await still();
        await shot();
        if (process.env.VERBOSE && i % 10 === 0) console.log(`${layout}-${theme}: frame ${i} of ${frames}`);
      }
      await page.evaluate(() => window.heroUnfold.open());
      await still();
      await shot();
      await page.close();
      // VP9 and H.264, near lossless so the screens' type stays sharp; the H.264 for Safari.
      const out = path.join(site, "hero", `unfold-${layout}-${theme}`);
      const input = ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(dir, "%04d.png")];
      for (const args of [
        [...input, "-c:v", "libvpx-vp9", "-crf", "16", "-b:v", "0", "-pix_fmt", "yuv420p", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-an", `${out}.webm`],
        [...input, "-c:v", "libx264", "-crf", "14", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", `${out}.mp4`],
      ]) {
        const r = spawnSync(ffmpeg, args, { stdio: "inherit" });
        if (r.status !== 0) throw new Error(`ffmpeg failed for ${out}`);
      }
      console.log(`${path.relative(repo, out)}.{webm,mp4}: ${n} frames, ${clip.width * 2}x${clip.height * 2}`);
    }
  }
} finally {
  await browser.close();
  server.close();
  if (!process.env.KEEP) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`frames kept in ${work}`);
}
