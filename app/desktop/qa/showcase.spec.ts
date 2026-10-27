// fleetd.sh's showcase: the app on fixtures/showcase, recorded while a busy storefront takes one request from the
// message to the merge, in the light and the dark theme. `pnpm fixtures && pnpm qa:build && pnpm site:showcase` writes
// site/showcase-<theme>.webm, its H.264 twin site/showcase-<theme>.mp4 and its poster, site/showcase-<theme>.jpg (a
// busy moment: the phone's screen yours, its code typed), each with a -small twin for small screens, over the files in
// the repo, and each step's start in the video, in seconds, to site/showcase.json: the page marks the step that is
// playing.
//
// It runs at a person's pace with nothing idle: QA types the request at once, then moves through the views as the
// story goes (Screens, the browser, the phone, Take over and the code, Hand back, the merge line, back to Agents).
// The video loops: its last moments fade into its first, which the encode then leaves out, so the end runs into the
// start without a cut.
//
// The frames are the window's own (CDP's screencast), with motion on: the app's beat, its entrances and the typing.
// They are spaced out to a steady 25 fps, then encoded as VP9 by the ffmpeg Playwright installs for its own videos
// (`pnpm exec playwright install ffmpeg`; FFMPEG=<path> to use another), and as H.264 by the app's WebCodecs encoder.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type Page, test } from "@playwright/test";
import { CODE } from "../fixtures/showcase/pages.ts";
import { DIGIT_MS, REQUEST, STEPS } from "../fixtures/showcase/index.ts";
import { appMain, desktopDir, fixtureMeta, fixturesDir, launch, settle, setView, show } from "./harness.ts";

const repo = path.resolve(desktopDir, "../..");
const CHAT = "#/project/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22";
const FPS = 25;
/** The loop's fade, in frames: the last ones fade into the first ones, which the video then starts after. */
const FADE = 15;
// When QA moves, in ms after the send: to Screens once the two screens are up, into the browser's, back out and into
// the phone's once it has booted, Take over once the lead asks, Hand back once the code is in, out again as the
// browser's recording lands, to the merge line as the batch starts, and back to Agents once it merged.
const QA = {
  screens: STEPS.screens + 600,
  web: STEPS.screens + 1200,
  allScreens: 9600,
  phone: 10_200,
  takeOver: STEPS.phoneAsks + 1200,
  handBack: STEPS.phoneAsks + 3400,
  back: STEPS.pr232 + 500,
  shipping: STEPS.batch - 400,
  line: STEPS.batch,
  agents: STEPS.merged + 1600,
} as const;
/** The poster's moment: the phone yours, its code typed, the rest of the floor still at work. */
const POSTER = QA.takeOver + DIGIT_MS.first + CODE.length * DIGIT_MS.every + 200;

/** The request a few keys at a time, as a quick typist's keys land on the frames: about 1.2 s for the whole of it. */
const BURST = 3;
const BURST_MS = 45;

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

/**
 * The frames as the video plays them: from `first` on, the last FADE fading into the FADE before `first`, so its end
 * runs into its start. Blended in the app window's canvas, as JPEGs like the screencast's.
 */
async function looped(page: Page, ticks: readonly Buffer[], first: number): Promise<Buffer[]> {
  const out = ticks.slice(first);
  for (let j = 0; j < FADE; j++) {
    const k = out.length - FADE + j;
    const from = out[k];
    const to = ticks[first - FADE + j];
    if (from === undefined || to === undefined) continue;
    const jpeg = await page.evaluate(
      async ({ a, b, t }) => {
        const bitmap = (s: string) => createImageBitmap(new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))], { type: "image/jpeg" }));
        const [x, y] = await Promise.all([bitmap(a), bitmap(b)]);
        const canvas = new OffscreenCanvas(x.width, x.height);
        const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(x, 0, 0);
        ctx.globalAlpha = t;
        ctx.drawImage(y, 0, 0, x.width, x.height);
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      },
      { a: from.toString("base64"), b: to.toString("base64"), t: (j + 1) / (FADE + 1) },
    );
    out[k] = Buffer.from(jpeg, "base64");
  }
  return out;
}

/** A screencast frame as the page's poster: a JPEG at `quality`, at `scale` of its size. */
async function poster(page: Page, jpeg: Buffer, scale: number, quality: number, file: string) {
  const out = await page.evaluate(
    async ({ src, scale, quality }) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(src), (c) => c.charCodeAt(0))], { type: "image/jpeg" }));
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      (canvas.getContext("2d") as OffscreenCanvasRenderingContext2D).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { src: jpeg.toString("base64"), scale, quality },
  );
  writeFileSync(file, Buffer.from(out, "base64"));
}

/** Clicks what `target` finds, then leaves no hover or focus ring behind. */
async function press(page: Page, target: ReturnType<Page["locator"]>) {
  await target.first().click();
  await page.mouse.move(2, 2);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

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
      await show(page, "chat", `${CHAT}/agents`);
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
      // The fade's frames come first; the video starts after them, on the first frame with a key typed.
      await sleepUntil(start + (FADE * 1000) / FPS);

      const composer = page.locator("[data-composer] textarea");
      await composer.click();
      let typing = 0;
      for (let i = 0; i < REQUEST.length; i += BURST) {
        const next = Date.now() + BURST_MS;
        await page.keyboard.insertText(REQUEST.slice(i, i + BURST));
        if (typing === 0) typing = Date.now();
        await sleepUntil(next);
      }
      await sleepUntil(Date.now() + 150);
      await page.keyboard.press("Enter");
      const sent = Date.now();
      const tab = (name: RegExp) => page.getByRole("tab", { name }).or(page.getByRole("radio", { name }));

      await sleepUntil(sent + QA.screens);
      await press(page, tab(/^Screens/u));
      await sleepUntil(sent + QA.web);
      await press(page, page.getByRole("link", { name: /signed-in shopper/u }));
      await sleepUntil(sent + QA.allScreens);
      await press(page, page.getByText("All screens"));
      await sleepUntil(sent + QA.phone);
      await press(page, page.getByRole("link", { name: /iPhone app/u }));
      await sleepUntil(sent + QA.takeOver);
      await press(page, page.getByRole("button", { name: "Take over", exact: true }));
      // The keys go to the page, a digit as each shows.
      for (const [k, digit] of Array.from(CODE).entries()) {
        await sleepUntil(sent + QA.takeOver + DIGIT_MS.first + k * DIGIT_MS.every - 120);
        await page.keyboard.type(digit);
      }
      await sleepUntil(sent + QA.handBack);
      await press(page, page.getByRole("button", { name: /^Hand back/u }));
      await sleepUntil(sent + QA.back);
      await press(page, page.getByText("All screens"));
      await sleepUntil(sent + QA.shipping);
      await press(page, tab(/^Shipping/u));
      await sleepUntil(sent + QA.line);
      await press(page, tab(/^Merge line/u));
      // Agents, and in it its agents rather than the Screens it showed last: the floor as the video starts.
      await sleepUntil(sent + QA.agents);
      await press(page, tab(/^Agents/u));
      await sleepUntil(sent + QA.agents + 300);
      await press(page, tab(/^Agents/u).last());
      await sleepUntil(sent + STEPS.end);
      await cdp.send("Page.stopScreencast");
      const end = Date.now();
      if (frames.length < 10) throw new Error(`the screencast sent ${frames.length} frames`);

      // A steady rate: each tick shows the newest frame by then. The screencast sends one only when something drew.
      const ticks: Buffer[] = [];
      for (let t = start; t <= end; t += 1000 / FPS) {
        const frame = frames.findLast((x) => x.at <= t) ?? frames[0];
        if (frame) ticks.push(frame.jpeg);
      }
      const first = frames.find((x) => x.at > typing)?.at ?? typing;
      const video = await looped(page, ticks, Math.max(FADE, Math.ceil(((first - start) * FPS) / 1000)));
      const out = path.join(repo, "site", `showcase-${theme}`);
      // The poster, lighter than a screencast frame: the page shows it until the video plays, and instead of it with
      // reduced motion.
      const still = frames.findLast((x) => x.at <= sent + POSTER)?.jpeg;
      if (still === undefined) throw new Error("no frame for the poster");
      await poster(page, still, 1, 0.78, `${out}.jpg`);
      await poster(page, still, 0.5, 0.8, `${out}-small.jpg`);
      // Seconds into the video, which starts as the typing shows.
      const at = (ms: number) => Math.max(0, Math.round((ms - first) / 100) / 10);
      const chapters = path.join(repo, "site", "showcase.json");
      const all = existsSync(chapters) ? (JSON.parse(readFileSync(chapters, "utf8")) as Record<string, unknown>) : {};
      all[theme] = { ask: at(typing), plan: at(sent + STEPS.reply - 500), build: at(sent + STEPS.split + 600), screens: at(sent + QA.web), merge: at(sent + QA.shipping), end: Math.round((video.length / FPS) * 10) / 10 };
      writeFileSync(chapters, `${JSON.stringify(all, null, 2)}\n`);
      // Two sizes: 1440 px tall for a wide screen at 2x, 720 for a small screen's (the page picks by the frame's pixels).
      for (const [height, file] of [[1440, `${out}.webm`], [720, `${out}-small.webm`]] as const) {
        const run = spawnSync(
          ffmpeg(),
          ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "pipe:0", "-vf", `scale=-2:${String(height)}:flags=lanczos`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-crf", height === 720 ? "34" : "38", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-an", file],
          { input: Buffer.concat(video), maxBuffer: 1 << 30 },
        );
        if (run.status !== 0) throw new Error(`ffmpeg failed: ${String(run.stderr)}`);
      }
      // And as H.264, for Safari on an older iPhone or Mac.
      // H.264 level 4.2 holds at most 8,704 macroblocks a frame: 1792x1152 (8,064) is the widest 14:9 under it.
      await mp4(page, video, { width: 1792, height: 1152 }, "avc1.64002A", 42, 1_400_000, `${out}.mp4`);
      await mp4(page, video, { width: 1120, height: 720 }, "avc1.64001F", 31, 700_000, `${out}-small.mp4`);
    } finally {
      await close();
    }
  });
}
