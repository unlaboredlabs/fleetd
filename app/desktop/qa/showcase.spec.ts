// fleetd.sh's showcase: the app on fixtures/showcase, recorded while it plays one request from the message to the
// merge, in the light and the dark theme. `pnpm fixtures && pnpm qa:build && pnpm site:showcase` writes
// site/showcase-<theme>.webm and its poster, site/showcase-<theme>.jpg (the end: the merge landed), each with a
// half-size -small twin for small screens, over the files in the repo, and each step's start in the video, in seconds, to
// site/showcase.json: the page marks the step that is playing.
//
// The frames are the window's own (CDP's screencast), with motion on: the app's beat, its entrances and the typing.
// They are spaced out to a steady 25 fps, then encoded as VP9 by the ffmpeg Playwright installs for its own videos
// (`pnpm exec playwright install ffmpeg`; FFMPEG=<path> to use another).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type Page, test } from "@playwright/test";
import { REQUEST, STEPS } from "../fixtures/showcase/index.ts";
import { appMain, desktopDir, fixtureMeta, fixturesDir, launch, settle, setView, show } from "./harness.ts";

const repo = path.resolve(desktopDir, "../..");
const CHAT = "#/project/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22";
const FPS = 25;
// When QA moves the panel along, in ms after the send: to the PRs once the first one is up, to the merge line once its
// review passed.
const TO_PRS = STEPS.opened + 1400;
const TO_LINE = STEPS.ci + 300;

/** A person's pace, as the app's own demo typing (src/main/instrument/recordConfig.ts): about 50 ms a key, uneven. */
const keyDelayMs = (index: number, ch: string): number => 30 + ((index * 7919) % 40) + (ch === " " ? 40 : ch === "." || ch === "," ? 180 : 0);

const ffmpeg = (): string => {
  if (process.env["FFMPEG"]) return process.env["FFMPEG"];
  const cache =
    process.env["PLAYWRIGHT_BROWSERS_PATH"] ??
    (process.platform === "darwin" ? path.join(homedir(), "Library/Caches/ms-playwright") : path.join(homedir(), ".cache/ms-playwright"));
  const dir = existsSync(cache) ? readdirSync(cache).find((d) => d.startsWith("ffmpeg-")) : undefined;
  const bin = dir === undefined ? undefined : path.join(cache, dir, process.platform === "darwin" ? "ffmpeg-mac" : "ffmpeg-linux");
  if (bin === undefined || !existsSync(bin)) throw new Error("no ffmpeg: run `pnpm exec playwright install ffmpeg` in app/desktop, or set FFMPEG");
  return bin;
};

const hideByClass = async (page: Page, selector: string, text: string, how: "display: none" | "visibility: hidden") => {
  const target = page.locator(selector, { hasText: text }).first();
  await target.waitFor({ state: "attached", timeout: 10_000 });
  const rule = await target.evaluate((el) => [...el.classList].map((c) => `.${CSS.escape(c)}`).join(""));
  if (rule === "") throw new Error(`"${text}" has no class to hide it by`);
  await page.addStyleTag({ content: `${rule} { ${how} !important; }` });
};

const sleepUntil = (at: number) => new Promise((done) => setTimeout(done, Math.max(0, at - Date.now())));

for (const theme of ["light", "dark"] as const) {
  test(`showcase ${theme}`, async () => {
    test.setTimeout(90_000);
    // A running clock from the fixture's "now": QA's fixed one never moves, and the merge line redraws only when a
    // read's answer is newer than the last (TrainPane's dataUpdatedAt stamp).
    const { app, page, settled, close } = await launch("showcase-order", appMain, { realClock: true });
    try {
      const { now } = fixtureMeta(path.join(fixturesDir, "showcase-order.json"));
      await page.clock.install({ time: new Date(now ?? Date.now()) });
      await page.reload();
      await setView(app, page, "medium", theme);
      await show(page, "chat", CHAT);
      await settled();
      // As on the site's shots (site.spec.ts): no sample-data banner or chip.
      await hideByClass(page, '[role="status"]', "Sample data, not connected", "display: none");
      await hideByClass(page, "[data-hub-status]", "Sample data", "visibility: hidden");
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
      await settle(page);

      const frames: Array<{ at: number; jpeg: Buffer }> = [];
      const cdp = await page.context().newCDPSession(page);
      cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
        frames.push({ at: Date.now(), jpeg: Buffer.from(data, "base64") });
        void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
      const start = Date.now();
      await sleepUntil(start + 900);

      const typing = Date.now();
      const composer = page.locator("[data-composer] textarea");
      await composer.focus();
      let i = 0;
      for (const ch of REQUEST) {
        await page.keyboard.type(ch);
        await sleepUntil(Date.now() + keyDelayMs(i++, ch));
      }
      await sleepUntil(Date.now() + 500);
      await page.keyboard.press("Enter");
      const sent = Date.now();

      await sleepUntil(sent + TO_PRS);
      await page.getByRole("tab", { name: /^Shipping/u }).click();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await sleepUntil(sent + TO_LINE);
      await page.getByRole("tab", { name: /^Merge line/u }).or(page.getByRole("radio", { name: /^Merge line/u })).first().click();
      // Off the button and out of focus, so no ring is left in the last frames.
      await page.mouse.move(2, 2);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await sleepUntil(sent + STEPS.end);
      const out = path.join(repo, "site", `showcase-${theme}`);
      // The poster, lighter than a screencast frame: the page shows it until the video plays, and instead of it with
      // reduced motion.
      await page.screenshot({ path: `${out}.jpg`, type: "jpeg", quality: 78, caret: "hide" });
      await page.screenshot({ path: `${out}-small.jpg`, type: "jpeg", quality: 80, caret: "hide", scale: "css" });
      await cdp.send("Page.stopScreencast");
      const end = Date.now();
      if (frames.length < 10) throw new Error(`the screencast sent ${frames.length} frames`);

      // A steady rate: each tick shows the newest frame by then. The screencast sends one only when something drew.
      const ticks: Buffer[] = [];
      for (let t = start; t <= end; t += 1000 / FPS) {
        const frame = frames.findLast((x) => x.at <= t) ?? frames[0];
        if (frame) ticks.push(frame.jpeg);
      }
      const at = (ms: number) => Math.round((ms - start) / 100) / 10;
      const chapters = path.join(repo, "site", "showcase.json");
      const all = existsSync(chapters) ? (JSON.parse(readFileSync(chapters, "utf8")) as Record<string, unknown>) : {};
      all[theme] = { ask: at(typing), plan: at(sent), build: at(sent + STEPS.writers), review: at(sent + STEPS.opened), merge: at(sent + STEPS.ci), end: at(end) };
      writeFileSync(chapters, `${JSON.stringify(all, null, 2)}\n`);
      // Two sizes: 1440 px tall for a wide screen at 2x, 720 for a small screen's (the page picks by the frame's pixels).
      for (const [height, file] of [[1440, `${out}.webm`], [720, `${out}-small.webm`]] as const) {
        const run = spawnSync(
          ffmpeg(),
          ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "pipe:0", "-vf", `scale=-2:${String(height)}:flags=lanczos`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-crf", height === 720 ? "34" : "38", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-an", file],
          { input: Buffer.concat(ticks), maxBuffer: 1 << 30 },
        );
        if (run.status !== 0) throw new Error(`ffmpeg failed: ${String(run.stderr)}`);
      }
    } finally {
      await close();
    }
  });
}
