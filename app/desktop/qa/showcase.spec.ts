// fleetd.sh's clips: the app on fixtures/showcase, recorded a few seconds at a time, one clip for each of the landing
// page's sections, in the light and the dark theme. `pnpm fixtures && pnpm qa:build && pnpm site:showcase` writes, for
// each clip, site/showcase-<clip>-<theme>.webm, its H.264 twin site/showcase-<clip>-<theme>.mp4 and its poster,
// site/showcase-<clip>-<theme>.jpg, each with a -small twin for small screens, over the files in the repo.
//
// - lead: you ask storefront's lead, it splits the work into three writers and #231 opens; cut to the merge line as
//   the train merges four PRs as one batch.
// - team: checkout's chat, which the team shares: Sam asks, Alice adds hers, the lead answers the two of them.
// - screens: an agent's live browser; cut to the iPhone's sign-in asking for you, Take over, the code, Hand back.
// - navi: Ada, a Navi, woken by mail with a reply that waits on you; Send it, and it went.
//
// Each clip is one run of the app at a person's pace, from which it keeps its takes, a few seconds each, cut together
// tight; what QA does between them (taking the phone over for the lead's clip, opening the phone for the screens') is
// left out. Each clip loops: its last moments fade into the moments before its first take, so the end runs into the
// start without a cut.
//
// The frames are the window's own (CDP's screencast), with motion on: the app's beat, its entrances and the typing.
// They are spaced out to a steady 25 fps, then encoded as VP9 by the ffmpeg Playwright installs for its own videos
// (`pnpm exec playwright install ffmpeg`; FFMPEG=<path> to use another), and as H.264 by the app's WebCodecs encoder.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type ElectronApplication, type Page, test } from "@playwright/test";
import { CODE } from "../fixtures/showcase/pages.ts";
import { DIGIT_MS, REQUEST, STEPS } from "../fixtures/showcase/index.ts";
import { TEAM_REQUEST, TEAM_STEPS } from "../fixtures/showcase/more.ts";
import { appMain, desktopDir, fixtureMeta, fixturesDir, launch, settle, setView, show } from "./harness.ts";

const repo = path.resolve(desktopDir, "../..");
const STOREFRONT = "devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22";
const CHAT = `#/project/${STOREFRONT}`;
const FPS = 25;
/** The loop's fade, in frames: the last ones fade into the ones before the first take. */
const FADE = 15;

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

/** What a clip's run hands back: its takes, each [from, to] in this machine's ms, and its poster's moment. */
interface Run {
  readonly takes: ReadonlyArray<readonly [number, number]>;
  readonly poster: number;
}

/** A clip's run: QA at work in the app, from `start` (the screencast is up and the fade's frames are in). */
type Script = (page: Page, start: number) => Promise<Run>;

const tab = (page: Page, name: RegExp) => page.getByRole("tab", { name }).or(page.getByRole("radio", { name }));
/** A sidebar's row. */
const item = (page: Page, name: string | RegExp) => page.getByRole("button", { name }).or(page.getByRole("link", { name }));

/**
 * Types `text` into the chat's composer as a quick typist would, and sends it. `typing` is the first frame with a key
 * typed in it, where a clip that opens on the ask starts.
 */
async function ask(page: Page, text: string, frames: ReadonlyArray<{ at: number }>): Promise<{ typing: number; sent: number }> {
  await page.locator("[data-composer] textarea").click();
  let typed = 0;
  for (let i = 0; i < text.length; i += BURST) {
    const next = Date.now() + BURST_MS;
    await page.keyboard.insertText(text.slice(i, i + BURST));
    if (typed === 0) typed = Date.now();
    await sleepUntil(next);
  }
  await sleepUntil(Date.now() + 150);
  await page.keyboard.press("Enter");
  const sent = Date.now();
  return { typing: frames.find((x) => x.at > typed)?.at ?? typed, sent };
}

/** The phone's code, a digit as each shows after Take over. */
async function typeCode(page: Page, takenAt: number) {
  for (const [k, digit] of Array.from(CODE).entries()) {
    await sleepUntil(takenAt + DIGIT_MS.first + k * DIGIT_MS.every - 120);
    await page.keyboard.type(digit);
  }
}

/** The clips, in the page's order. */
const clips = (frames: ReadonlyArray<{ at: number }>): Record<"lead" | "team" | "screens" | "navi", Script> => ({
  // The ask, the lead's split and its three writers, #231 up; then the merge line as the batch goes through CI and
  // merges. Between them QA takes the phone over and hands it back, as the screens clip shows, so the order runs on.
  lead: async (page) => {
    const { typing, sent } = await ask(page, REQUEST, frames);
    await sleepUntil(sent + STEPS.screens + 600);
    await press(page, tab(page, /^Screens/u));
    await sleepUntil(sent + 10_200);
    await press(page, page.getByRole("link", { name: /iPhone app/u }));
    await sleepUntil(sent + STEPS.phoneAsks + 1200);
    await press(page, page.getByRole("button", { name: "Take over", exact: true }));
    await typeCode(page, sent + STEPS.phoneAsks + 1200);
    await sleepUntil(sent + STEPS.phoneAsks + 3400);
    await press(page, page.getByRole("button", { name: /^Hand back/u }));
    await sleepUntil(sent + STEPS.batch - 1400);
    await press(page, tab(page, /^Shipping/u));
    await sleepUntil(sent + STEPS.batch - 800);
    await press(page, tab(page, /^Merge line/u));
    await sleepUntil(sent + STEPS.merged + 2200);
    return { takes: [[typing, sent + 4900], [sent + STEPS.batch - 500, sent + STEPS.merged + 2200]], poster: sent + 4700 };
  },
  // checkout's chat: Sam's ask, Alice's beside it, and the lead's answer to both.
  team: async (page) => {
    const { typing, sent } = await ask(page, TEAM_REQUEST, frames);
    await sleepUntil(sent + TEAM_STEPS.said + 1800);
    return { takes: [[typing, sent + TEAM_STEPS.said + 1800]], poster: sent + TEAM_STEPS.said + 1000 };
  },
  // The web writer's browser, live; then the phone asks for you, and you take it over, type the code and hand back.
  screens: async (page) => {
    const { sent } = await ask(page, REQUEST, frames);
    await sleepUntil(sent + STEPS.screens + 300);
    await press(page, tab(page, /^Screens/u));
    await sleepUntil(sent + STEPS.screens + 800);
    await press(page, page.getByRole("link", { name: /signed-in shopper/u }));
    await sleepUntil(sent + 9600);
    await press(page, page.getByText("All screens"));
    await sleepUntil(sent + 10_200);
    await press(page, page.getByRole("link", { name: /iPhone app/u }));
    const takeOver = sent + STEPS.phoneAsks + 1200;
    await sleepUntil(takeOver);
    await press(page, page.getByRole("button", { name: "Take over", exact: true }));
    await typeCode(page, takeOver);
    await sleepUntil(sent + STEPS.phoneAsks + 3400);
    await press(page, page.getByRole("button", { name: /^Hand back/u }));
    await sleepUntil(sent + STEPS.phoneAsks + 4800);
    return {
      takes: [[sent + STEPS.screens + 1000, sent + 9300], [sent + STEPS.phoneAsks - 300, sent + STEPS.phoneAsks + 4800]],
      poster: takeOver + DIGIT_MS.first + CODE.length * DIGIT_MS.every + 200,
    };
  },
  // From storefront to Ada: Marta's mail woke it, and its reply with both files waits on you. Send it, and it went.
  navi: async (page, start) => {
    await sleepUntil(start + 700);
    await press(page, item(page, /^Ada\b/u));
    await sleepUntil(start + 2900);
    await press(page, page.getByRole("button", { name: "Send it" }));
    await sleepUntil(start + 5000);
    return { takes: [[start, start + 5000]], poster: start + 2500 };
  },
});

/** Where each clip opens, after the storefront's Agents. */
const opening: Partial<Record<keyof ReturnType<typeof clips>, (page: Page) => Promise<void>>> = {
  // checkout's chat, the panel hidden: the clip is the conversation.
  team: async (page) => {
    await press(page, item(page, /^checkout\b/u));
    await page.locator("[data-composer] textarea").waitFor({ state: "visible", timeout: 10_000 });
    await press(page, page.getByRole("button", { name: "Hide the panel" }));
  },
};

async function record(app: ElectronApplication, page: Page, settled: () => Promise<void>, clip: keyof ReturnType<typeof clips>, theme: "light" | "dark") {
  // A running clock from the fixture's "now": QA's fixed one never moves, and the merge line redraws only when a read's
  // answer is newer than the last (TrainPane's dataUpdatedAt stamp).
  const { now } = fixtureMeta(path.join(fixturesDir, "showcase-order.json"));
  await page.clock.install({ time: new Date(now ?? Date.now()) });
  await page.reload();
  await setView(app, page, "medium", theme);
  await show(page, "chat", `${CHAT}/agents`);
  await settled();
  // As on the site's shots (site.spec.ts): no sample-data banner or chip.
  // The hubs' rows name the two hubs, Acme and Personal, rather than sample data: they stay.
  await hideByClass(page, '[role="status"]', "Sample data, not connected", "display: none");
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
  await opening[clip]?.(page);
  await settle(page);

  const frames: Array<{ at: number; jpeg: Buffer }> = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    frames.push({ at: Date.now(), jpeg: Buffer.from(data, "base64") });
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
  // The fade's frames come first.
  const start = Date.now() + (FADE * 1000) / FPS;
  await sleepUntil(start);
  const run = await clips(frames)[clip](page, start);
  await cdp.send("Page.stopScreencast");
  if (frames.length < 10) throw new Error(`the screencast sent ${String(frames.length)} frames`);

  // A steady rate: each tick shows the newest frame by then. The screencast sends one only when something drew. The
  // first take starts the fade's frames early, which the video then starts after.
  const at = (t: number) => (frames.findLast((x) => x.at <= t) ?? frames[0])?.jpeg;
  const ticks: Buffer[] = [];
  run.takes.forEach(([from, to], n) => {
    for (let t = n === 0 ? from - (FADE * 1000) / FPS : from; t <= to; t += 1000 / FPS) {
      const jpeg = at(t);
      if (jpeg) ticks.push(jpeg);
    }
  });
  const video = await looped(page, ticks, FADE);
  const out = path.join(repo, "site", `showcase-${clip}-${theme}`);
  // The poster, lighter than a screencast frame: the page shows it until the video plays, and instead of it with
  // reduced motion.
  const still = frames.findLast((x) => x.at <= run.poster)?.jpeg;
  if (still === undefined) throw new Error("no frame for the poster");
  await poster(page, still, 1, 0.78, `${out}.jpg`);
  await poster(page, still, 0.5, 0.8, `${out}-small.jpg`);
  // Two sizes: 1440 px tall for a wide screen at 2x, 720 for a small screen's (the page picks by the frame's pixels).
  for (const [height, file] of [[1440, `${out}.webm`], [720, `${out}-small.webm`]] as const) {
    const encode = spawnSync(
      ffmpeg(),
      ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "pipe:0", "-vf", `scale=-2:${String(height)}:flags=lanczos`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-crf", height === 720 ? "34" : "38", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-an", file],
      { input: Buffer.concat(video), maxBuffer: 1 << 30 },
    );
    if (encode.status !== 0) throw new Error(`ffmpeg failed: ${String(encode.stderr)}`);
  }
  // And as H.264, for Safari on an older iPhone or Mac.
  // H.264 level 4.2 holds at most 8,704 macroblocks a frame: 1792x1152 (8,064) is the widest 14:9 under it.
  await mp4(page, video, { width: 1792, height: 1152 }, "avc1.64002A", 42, 1_400_000, `${out}.mp4`);
  await mp4(page, video, { width: 1120, height: 720 }, "avc1.64001F", 31, 700_000, `${out}-small.mp4`);
}

for (const clip of ["lead", "team", "screens", "navi"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`showcase ${clip} ${theme}`, async () => {
      test.setTimeout(120_000);
      const { app, page, settled, close } = await launch("showcase-order", appMain, { realClock: true });
      try {
        await record(app, page, settled, clip, theme);
      } finally {
        await close();
      }
    });
  }
}
