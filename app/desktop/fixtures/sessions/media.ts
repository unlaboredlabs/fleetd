// `node fixtures/sessions/media.ts`: renders the Sessions fixture's media once, into fixtures/sessions/media/: each
// page pages.ts draws as a 960×600 JPEG (the live sessions' frames), and the share session's video as a VP9 WebM, its
// pages shown at the times script.ts gives them. Electron draws and encodes them (canvas, MediaRecorder); the files are
// committed, so the fixture build itself needs neither. Run it again after changing a page or the share timeline.
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import * as page from "./pages.ts";
import { SHARE, SHARE_MS } from "./script.ts";

const OUT = path.join(import.meta.dirname, "media");
const WIDTH = 960;
const HEIGHT = 600;

export const PAGES: Readonly<Record<string, string>> = {
  blank: page.blank(),
  home: page.shopHome(),
  signIn: page.shopSignIn(false),
  signInFilled: page.shopSignIn(true),
  product: page.shopProduct(0),
  productShare: page.shopProduct(0, { x: 716, y: 498 }, true),
  productAdded: page.shopProduct(1, { x: 852, y: 383 }),
  notFound: page.shopNotFound(),
  checkout: page.shopCheckout({}),
  checkoutCode: page.shopCheckout({ code: "SAVE10" }, { x: 900, y: 312 }),
  checkoutApplied: page.shopCheckout({ code: "SAVE10", applied: true }, { x: 1138, y: 312 }),
  payCode: page.payCode(""),
  payDashboard: page.payDashboard({}),
  payDashboardDownloaded: page.payDashboard({ downloaded: true }, { x: 1142, y: 86 }),
};

/** The JPEG with its pixel segments only: Chromium adds an ICC profile (APP2), which the leak check refuses. */
export const pixelsOnly = (jpeg: Buffer): Buffer => {
  const keep: Buffer[] = [jpeg.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1] ?? 0;
    // From the scan on, everything is image data.
    if (marker === 0xda) {
      keep.push(jpeg.subarray(at));
      break;
    }
    const end = at + 2 + jpeg.readUInt16BE(at + 2);
    if (marker < 0xe1 || marker > 0xef) keep.push(jpeg.subarray(at, end));
    at = end;
  }
  return Buffer.concat(keep);
};

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(path.join(tmpdir(), "fleetd-media-"));
  const entry = path.join(dir, "main.cjs");
  writeFileSync(
    entry,
    `const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: ${String(WIDTH)}, height: ${String(HEIGHT)}, show: false });
  w.loadURL("data:text/html,<canvas id=c width=${String(WIDTH)} height=${String(HEIGHT)}></canvas>");
});`,
  );
  const args = [entry, "--no-sandbox", ...(process.env["DISPLAY"] === undefined ? ["--ozone-platform=headless"] : [])];
  const app = await electron.launch({ args });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector("#c");
    const jpegs = await win.evaluate(
      async ({ pages, quality }) => {
        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
        const out: Record<string, string> = {};
        for (const [name, src] of Object.entries(pages)) {
          const img = new Image();
          img.src = src;
          await img.decode();
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          out[name] = canvas.toDataURL("image/jpeg", quality).split(",")[1] ?? "";
        }
        return out;
      },
      { pages: PAGES, quality: 0.7 },
    );
    for (const [name, b64] of Object.entries(jpegs)) writeFileSync(path.join(OUT, `${name}.jpg`), pixelsOnly(Buffer.from(b64, "base64")));
    const plan = SHARE.flatMap((s) => (s.frame === undefined ? [] : [{ at: s.at, src: PAGES[s.frame] ?? "" }]));
    const webm = await win.evaluate(
      async ({ plan, total }) => {
        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
        const images = await Promise.all(
          plan.map(async ({ at, src }) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            return { at, img };
          }),
        );
        const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: 300_000 });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        const done = new Promise((resolve) => (recorder.onstop = resolve));
        recorder.start();
        const start = performance.now();
        // Draws every 100 ms, so the stream has frames to encode even where the page holds still.
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            const at = performance.now() - start;
            const shown = images.filter((x) => x.at <= at).at(-1) ?? images[0];
            if (shown !== undefined) ctx.drawImage(shown.img, 0, 0, canvas.width, canvas.height);
            if (at >= total) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
        recorder.stop();
        await done;
        const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
        let s = "";
        for (const b of bytes) s += String.fromCharCode(b);
        return btoa(s);
      },
      { plan, total: SHARE_MS },
    );
    writeFileSync(path.join(OUT, "share.webm"), Buffer.from(webm, "base64"));
  } finally {
    await app.close();
  }
};

await main();
