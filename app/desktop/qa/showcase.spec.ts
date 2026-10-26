// fleetd.sh's showcase: the app on fixtures/showcase, recorded while it plays one request from the message to the
// merge, in the light and the dark theme. `pnpm fixtures && pnpm qa:build && pnpm site:showcase` writes
// site/showcase-<theme>.webm, its H.264 twin site/showcase-<theme>.mp4 and its poster, site/showcase-<theme>.jpg (the
// end: the merge landed), each with a -small twin for small screens, over the files in the repo, and each
// step's start in the video, in seconds, to site/showcase.json: the page marks the step that is playing.
//
// The frames are the window's own (CDP's screencast), with motion on: the app's beat, its entrances and the typing.
// They are spaced out to a steady 25 fps, then encoded as VP9 by the ffmpeg Playwright installs for its own videos
// (`pnpm exec playwright install ffmpeg`; FFMPEG=<path> to use another), and as H.264 by the app's WebCodecs encoder.
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

/**
 * The same ticks as H.264 MP4, for the browsers without VP9 WebM: the app window's WebCodecs encoder takes every tick
 * with its own timestamp (1/FPS s apart), so the file never depends on how fast this machine runs, and nothing is
 * dropped. `codec` names the profile and level asked for; the encoder's avcC says what it wrote, and anything above
 * `maxLevel` (4.2 for the full size, which older iPhones and iPads decode) fails the run.
 */
async function mp4(page: Page, ticks: readonly Buffer[], size: { width: number; height: number }, codec: string, maxLevel: number, bitrate: number, file: string) {
  const unique = [...new Set(ticks)];
  const index = ticks.map((t) => unique.indexOf(t));
  await page.evaluate(() => ((window as unknown as { __frames: string[] }).__frames = []));
  for (let i = 0; i < unique.length; i += 16) {
    const batch = unique.slice(i, i + 16).map((b) => b.toString("base64"));
    await page.evaluate((b) => (window as unknown as { __frames: string[] }).__frames.push(...b), batch);
  }
  const encoded = await page.evaluate(
    async ({ index, size, codec, bitrate, fps }) => {
      const frames = (window as unknown as { __frames: string[] }).__frames;
      const b64 = (data: Uint8Array) => {
        let s = "";
        for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
        return btoa(s);
      };
      const chunks: Array<{ data: string; key: boolean; timestamp: number }> = [];
      let description: string | undefined;
      let failed: DOMException | undefined;
      const encoder = new VideoEncoder({
        output: (chunk, meta) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          chunks.push({ data: b64(data), key: chunk.type === "key", timestamp: chunk.timestamp });
          const d = meta?.decoderConfig?.description;
          if (d !== undefined && description === undefined) description = b64(ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
        },
        error: (e) => (failed = e),
      });
      encoder.configure({ codec, ...size, bitrate, framerate: fps, latencyMode: "quality", avc: { format: "avc" } });
      const bytes = (i: number) => Uint8Array.from(atob(frames[i] ?? ""), (c) => c.charCodeAt(0));
      let bitmap: ImageBitmap | undefined;
      let shown = -1;
      const step = 1_000_000 / fps;
      for (const [k, i] of index.entries()) {
        if (i !== shown) {
          bitmap?.close();
          bitmap = await createImageBitmap(new Blob([bytes(i)], { type: "image/jpeg" }), { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" });
          shown = i;
        }
        if (bitmap === undefined) continue;
        const frame = new VideoFrame(bitmap, { timestamp: Math.round(k * step), duration: Math.round(step) });
        // A key frame every 2 s, so a seek or a loop lands quickly.
        encoder.encode(frame, { keyFrame: k % (2 * fps) === 0 });
        frame.close();
        while (encoder.encodeQueueSize > 8) await new Promise((done) => encoder.addEventListener("dequeue", done, { once: true }));
      }
      await encoder.flush();
      encoder.close();
      bitmap?.close();
      if (failed !== undefined) throw new Error(`VideoEncoder: ${failed.message}`);
      return { chunks, description };
    },
    { index, size, codec, bitrate, fps: FPS },
  );
  if (encoded.description === undefined) throw new Error(`${file}: the encoder gave no avcC`);
  if (encoded.chunks.length !== ticks.length) throw new Error(`${file}: ${String(ticks.length)} frames in, ${String(encoded.chunks.length)} out`);
  const avcC = Buffer.from(encoded.description, "base64");
  const level = avcC[3] ?? 0;
  if (level > maxLevel) throw new Error(`${file}: H.264 level ${String(level / 10)}, above ${String(maxLevel / 10)}`);
  writeFileSync(file, muxMp4(size, avcC, encoded.chunks.map((c) => ({ data: Buffer.from(c.data, "base64"), key: c.key }))));
}

/** One H.264 track as a plain MP4, its index (moov) first so a browser can start before the rest has come. */
function muxMp4(size: { width: number; height: number }, avcC: Buffer, samples: ReadonlyArray<{ data: Buffer; key: boolean }>): Buffer {
  const u8 = (n: number) => Buffer.from([n]);
  const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
  };
  const box = (type: string, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([u32(body.length + 8), Buffer.from(type, "latin1"), body]);
  };
  const full = (type: string, version: number, flags: number, ...parts: Buffer[]) => box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...parts);
  const matrix = Buffer.concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));
  const scale = FPS * 1000;
  const delta = 1000;
  const duration = samples.length * delta;
  const movieDuration = Math.round((duration / scale) * 1000);
  const entry = box(
    "avc1",
    Buffer.alloc(6),
    u16(1),
    Buffer.alloc(16),
    u16(size.width),
    u16(size.height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    Buffer.alloc(32),
    u16(0x18),
    u16(0xffff),
    box("avcC", avcC),
  );
  const moov = (offset: number) =>
    box(
      "moov",
      full("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(movieDuration), u32(0x00010000), u16(0x0100), Buffer.alloc(10), matrix, Buffer.alloc(24), u32(2)),
      box(
        "trak",
        full("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDuration), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(size.width << 16), u32(size.height << 16)),
        box(
          "mdia",
          full("mdhd", 0, 0, u32(0), u32(0), u32(scale), u32(duration), u16(0x55c4), u16(0)),
          full("hdlr", 0, 0, u32(0), Buffer.from("vide", "latin1"), Buffer.alloc(12), Buffer.from("VideoHandler\0", "latin1")),
          box(
            "minf",
            full("vmhd", 0, 1, Buffer.alloc(8)),
            box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
            box(
              "stbl",
              full("stsd", 0, 0, u32(1), entry),
              full("stts", 0, 0, u32(1), u32(samples.length), u32(delta)),
              full("stss", 0, 0, u32(samples.filter((s) => s.key).length), ...samples.flatMap((s, i) => (s.key ? [u32(i + 1)] : []))),
              full("stsc", 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
              full("stsz", 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length))),
              full("stco", 0, 0, u32(1), u32(offset)),
            ),
          ),
        ),
      ),
    );
  const ftyp = box("ftyp", Buffer.from("isom", "latin1"), u32(0x200), Buffer.from("isomiso2avc1mp41", "latin1"));
  // The chunk offset is where mdat's payload starts, past the moov that holds it: moov's size doesn't depend on it.
  const offset = ftyp.length + moov(0).length + 8;
  return Buffer.concat([ftyp, moov(offset), box("mdat", ...samples.map((s) => s.data))]);
}

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
    test.setTimeout(180_000);
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
      // And as H.264, for Safari on an older iPhone or Mac.
      // H.264 level 4.2 holds at most 8,704 macroblocks a frame: 1792x1152 (8,064) is the widest 14:9 under it.
      await mp4(page, ticks, { width: 1792, height: 1152 }, "avc1.64002A", 42, 1_400_000, `${out}.mp4`);
      await mp4(page, ticks, { width: 1120, height: 720 }, "avc1.64001F", 31, 700_000, `${out}-small.mp4`);
    } finally {
      await close();
    }
  });
}
