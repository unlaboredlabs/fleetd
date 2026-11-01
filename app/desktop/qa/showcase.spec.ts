// fleetd.sh's clips: the app on fixtures/showcase, recorded a few seconds at a time, one clip for each of the landing
// page's sections, in the light and the dark theme. `pnpm fixtures && pnpm qa:build && pnpm site:showcase` writes, for
// each clip, site/showcase-<clip>-<theme>.webm, its H.264 twin site/showcase-<clip>-<theme>.mp4 and its poster,
// site/showcase-<clip>-<theme>.jpg, each with a -small twin for small screens, over the files in the repo.
//
// - lead: you ask storefront's lead, it splits the work into three writers and #231 opens; cut to the merge line as
//   the train merges four PRs as one batch.
// - team: checkout's chat, which the team shares: Sam asks, Alice adds hers, the lead answers the two of them.
// - screens: an agent's live browser; cut to the iPhone's sign-in asking for you, Take over, the code, Hand back.
// - navi: Ada, a Navi, with a lease renewal that waits on you; Send it, and it went.
//
// Each clip is one run of the app at a person's pace, from which it keeps its takes, a few seconds each, cut together
// tight; what QA does between them (taking the phone over for the lead's clip, opening the phone for the screens') is
// left out. Each clip loops: its last moments fade into the moments before its first take, so the end runs into the
// start without a cut.
//
// The frames are the window's own (CDP's screencast), with motion on: the app's beat, its entrances and the typing.
// They are laid out on a steady 60 fps, each frame showing the newest screencast frame by then, framed by the camera and
// with the cursor drawn on it (camera.ts works both out for every frame), then encoded as VP9 by the ffmpeg Playwright
// installs for its own videos (`pnpm exec playwright install ffmpeg`; FFMPEG=<path> to use another), and as H.264 by the
// app's WebCodecs encoder, both at a fixed quality that keeps UI text as sharp as the app's own.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { devNull, homedir } from "node:os";
import path from "node:path";
import { type ElectronApplication, type Page, test } from "@playwright/test";
import { CODE } from "../fixtures/showcase/pages.ts";
import { DIGIT_MS, REQUEST, STEPS } from "../fixtures/showcase/index.ts";
import { TEAM_REQUEST, TEAM_STEPS } from "../fixtures/showcase/more.ts";
import { type Box, type Direction, direct, type Step } from "./camera.ts";
import { appMain, desktopDir, fixtureMeta, fixturesDir, launch, scale, settle, setView, show } from "./harness.ts";

const repo = path.resolve(desktopDir, "../..");
const STOREFRONT = "devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22";
const CHAT = `#/project/${STOREFRONT}`;
const FPS = 60;
/** The loop's fade, in frames: the last ones fade into the ones before the first take. */
const FADE = 36;
/** The full-size clip's frame: the window at 2x, for a wide screen at 2x. */
const FULL = { width: 2800, height: 1800 } as const;

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
 * The frames (JPEGs) as H.264 MP4, for the browsers without VP9 WebM: the app window's WebCodecs encoder takes
 * every frame with its own timestamp (1/FPS s apart), so the file never depends on how fast this machine runs, and
 * nothing is dropped. Each frame at quantizer `qp`, a fixed quality, where the encoder offers it, else at a variable
 * rate of at most `bitrate`, which still UI holds well under.
 * `codec` names the profile and level asked for; the encoder's avcC says what it wrote, and anything above `maxLevel`
 * fails the run. A few frames at a time, so the window never holds the whole clip.
 */
async function mp4(page: Page, files: readonly Buffer[], size: { width: number; height: number }, codec: string, maxLevel: number, qp: number, bitrate: number, file: string) {
  await page.evaluate(
    async ({ size, codec, fps, qp, bitrate }) => {
      const w = window as unknown as { __mp4?: { encoder: VideoEncoder; chunks: Array<{ data: string; key: boolean }>; description?: string; failed?: string; qp?: number } };
      const b64 = (data: Uint8Array) => {
        let s = "";
        for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
        return btoa(s);
      };
      const state: NonNullable<typeof w.__mp4> = { chunks: [], encoder: undefined as unknown as VideoEncoder };
      state.encoder = new VideoEncoder({
        output: (chunk, meta) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          state.chunks.push({ data: b64(data), key: chunk.type === "key" });
          const d = meta?.decoderConfig?.description;
          if (d !== undefined && state.description === undefined) state.description = b64(ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
        },
        error: (e) => (state.failed = e.message),
      });
      const base = { codec, ...size, framerate: fps, latencyMode: "quality", avc: { format: "avc" } } as const;
      const fixed = { ...base, bitrateMode: "quantizer" } as const;
      if ((await VideoEncoder.isConfigSupported(fixed)).supported === true) {
        state.encoder.configure(fixed);
        state.qp = qp;
      } else state.encoder.configure({ ...base, bitrateMode: "variable", bitrate });
      w.__mp4 = state;
    },
    { size, codec, fps: FPS, qp, bitrate },
  );
  const samples: Array<{ data: Buffer; key: boolean }> = [];
  for (let i = 0; i < files.length; i += 8) {
    const batch = files.slice(i, i + 8).map((f) => f.toString("base64"));
    const chunks = await page.evaluate(
      async ({ batch, first, size, fps }) => {
        const w = window as unknown as { __mp4: { encoder: VideoEncoder; chunks: Array<{ data: string; key: boolean }>; qp?: number } };
        const { encoder } = w.__mp4;
        const step = 1_000_000 / fps;
        for (const [n, src] of batch.entries()) {
          const k = first + n;
          const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(src), (c) => c.charCodeAt(0))], { type: "image/jpeg" }), { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" });
          const frame = new VideoFrame(bitmap, { timestamp: Math.round(k * step), duration: Math.round(step) });
          // A key frame every 2 s, so a seek or a loop lands quickly.
          encoder.encode(frame, { keyFrame: k % (2 * fps) === 0, ...(w.__mp4.qp === undefined ? {} : { avc: { quantizer: w.__mp4.qp } }) });
          frame.close();
          bitmap.close();
          while (encoder.encodeQueueSize > 4) await new Promise((done) => encoder.addEventListener("dequeue", done, { once: true }));
        }
        return w.__mp4.chunks.splice(0);
      },
      { batch, first: i, size, fps: FPS },
    );
    samples.push(...chunks.map((c) => ({ data: Buffer.from(c.data, "base64"), key: c.key })));
  }
  const done = await page.evaluate(async () => {
    const w = window as unknown as { __mp4: { encoder: VideoEncoder; chunks: Array<{ data: string; key: boolean }>; description?: string; failed?: string; qp?: number } };
    await w.__mp4.encoder.flush();
    w.__mp4.encoder.close();
    return { chunks: w.__mp4.chunks.splice(0), description: w.__mp4.description, failed: w.__mp4.failed, fixed: w.__mp4.qp !== undefined };
  });
  if (done.failed !== undefined) throw new Error(`VideoEncoder: ${done.failed}`);
  samples.push(...done.chunks.map((c) => ({ data: Buffer.from(c.data, "base64"), key: c.key })));
  if (done.description === undefined) throw new Error(`${file}: the encoder gave no avcC`);
  if (samples.length !== files.length) throw new Error(`${file}: ${String(files.length)} frames in, ${String(samples.length)} out`);
  if (!done.fixed) console.log(`${path.basename(file)}: no fixed-quality H.264 here, so a variable rate up to ${String(bitrate / 1e6)} Mbps`);
  const avcC = Buffer.from(done.description, "base64");
  const level = avcC[3] ?? 0;
  if (level > maxLevel) throw new Error(`${file}: H.264 level ${String(level / 10)}, above ${String(maxLevel / 10)}`);
  writeFileSync(file, muxMp4(size, avcC, samples));
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

/** A screencast frame as the page's poster: a JPEG at `quality`, `width` px wide. */
async function poster(page: Page, jpeg: Buffer, width: number, quality: number, file: string) {
  const out = await page.evaluate(
    async ({ src, width, quality }) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(src), (c) => c.charCodeAt(0))], { type: "image/jpeg" }));
      const canvas = new OffscreenCanvas(width, Math.round((bitmap.height * width) / bitmap.width));
      (canvas.getContext("2d") as OffscreenCanvasRenderingContext2D).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { src: jpeg.toString("base64"), width, quality },
  );
  writeFileSync(file, Buffer.from(out, "base64"));
}

/**
 * The ticks as the clip shows them: each its screencast frame, framed by the camera and with the cursor drawn over it,
 * at the full size. Drawn in the app window's canvas, a few ticks at a time, each frame sent over once while in use.
 */
async function film(
  page: Page,
  frames: ReadonlyArray<{ jpeg: Buffer }>,
  ticks: ReadonlyArray<{ frame: number } & Direction>,
  view: { width: number; height: number },
): Promise<Buffer[]> {
  const out: Buffer[] = [];
  const sent = new Set<number>();
  const BATCH = 8;
  for (let i = 0; i < ticks.length; i += BATCH) {
    const batch = ticks.slice(i, i + BATCH);
    const next = new Set(ticks.slice(i + BATCH, i + 2 * BATCH).map((k) => k.frame));
    const fresh = [...new Set(batch.map((b) => b.frame))].filter((f) => !sent.has(f));
    for (const f of fresh) sent.add(f);
    const jpegs = await page.evaluate(
      async ({ batch, fresh, keep, size, view }) => {
        const w = window as unknown as { __film?: Map<number, ImageBitmap> };
        const cache = (w.__film ??= new Map());
        for (const [f, src] of fresh) cache.set(f, await createImageBitmap(new Blob([Uint8Array.from(atob(src), (c) => c.charCodeAt(0))], { type: "image/jpeg" })));
        const canvas = new OffscreenCanvas(size.width, size.height);
        const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
        ctx.imageSmoothingQuality = "high";
        // The pointer as macOS draws it, its size on a 1x screen, tip at (0, 0) in CSS px: black, with a white rim.
        const arrow = new Path2D("M0.5 0.5 L0.5 16.3 L4.4 12.6 L6.9 18.4 L9.4 17.3 L7 11.7 L12.3 11.7 Z");
        const results: string[] = [];
        for (const { frame, shot, pointer } of batch) {
          const bitmap = cache.get(frame);
          if (bitmap === undefined) throw new Error(`frame ${String(frame)} was not sent`);
          const px = bitmap.width / view.width;
          const vw = view.width / shot.zoom;
          const vh = view.height / shot.zoom;
          const left = shot.x - vw / 2;
          const top = shot.y - vh / 2;
          ctx.drawImage(bitmap, left * px, top * px, vw * px, vh * px, 0, 0, size.width, size.height);
          const k = size.width / vw;
          ctx.save();
          ctx.translate((pointer.x - left) * k, (pointer.y - top) * k);
          // It dips as it clicks, about its tip.
          ctx.scale(k * pointer.scale, k * pointer.scale);
          ctx.lineJoin = "round";
          ctx.shadowColor = "rgba(0,0,0,0.32)";
          ctx.shadowBlur = 2.5 * k;
          ctx.shadowOffsetY = 0.75 * k;
          // The white rim, a px outside the arrow, casts the shadow; the black arrow sits on it.
          ctx.lineWidth = 2;
          ctx.strokeStyle = "#fff";
          ctx.fillStyle = "#fff";
          ctx.stroke(arrow);
          ctx.fill(arrow);
          ctx.shadowColor = "transparent";
          ctx.fillStyle = "#000";
          ctx.fill(arrow);
          ctx.restore();
          const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.96 })).arrayBuffer());
          let s = "";
          for (let j = 0; j < bytes.length; j += 0x8000) s += String.fromCharCode(...bytes.subarray(j, j + 0x8000));
          results.push(btoa(s));
        }
        for (const [f, bitmap] of cache) {
          if (keep.includes(f)) continue;
          bitmap.close();
          cache.delete(f);
        }
        return results;
      },
      {
        batch,
        fresh: fresh.map((f) => [f, frames[f]?.jpeg.toString("base64") ?? ""] as const),
        keep: [...next],
        size: FULL,
        view,
      },
    );
    out.push(...jpegs.map((j) => Buffer.from(j, "base64")));
    for (const f of sent) if (!next.has(f)) sent.delete(f);
  }
  return out;
}

/**
 * Where on the page two screencast frames differ, CSS px, or null when they don't: compared at an eighth of the
 * window's size, a cell of 25 px counting once a few of its pixels changed.
 */
async function effect(page: Page, before: Buffer, after: Buffer, view: { width: number; height: number }): Promise<Box | null> {
  return page.evaluate(
    async ({ a, b, view }) => {
      const w = view.width / 8;
      const h = view.height / 8;
      const pixels = async (src: string) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(src), (c) => c.charCodeAt(0))], { type: "image/jpeg" }), { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return ctx.getImageData(0, 0, w, h).data;
      };
      const [x, y] = await Promise.all([pixels(a), pixels(b)]);
      const CELL = 25 / 8;
      const cols = Math.ceil(w / CELL);
      const counts = new Map<number, number>();
      for (let i = 0; i < w * h; i++) {
        const d = Math.abs((x[i * 4] ?? 0) - (y[i * 4] ?? 0)) + Math.abs((x[i * 4 + 1] ?? 0) - (y[i * 4 + 1] ?? 0)) + Math.abs((x[i * 4 + 2] ?? 0) - (y[i * 4 + 2] ?? 0));
        if (d < 48) continue;
        const cell = Math.floor((i % w) / CELL) + cols * Math.floor(Math.floor(i / w) / CELL);
        counts.set(cell, (counts.get(cell) ?? 0) + 1);
      }
      let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
      for (const [cell, n] of counts) {
        if (n < 3) continue;
        const cx = (cell % cols) * 25;
        const cy = Math.floor(cell / cols) * 25;
        box = box === null ? { x0: cx, y0: cy, x1: cx + 25, y1: cy + 25 } : { x0: Math.min(box.x0, cx), y0: Math.min(box.y0, cy), x1: Math.max(box.x1, cx + 25), y1: Math.max(box.y1, cy + 25) };
      }
      return box === null ? null : { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 };
    },
    { a: before.toString("base64"), b: after.toString("base64"), view },
  );
}

/** Each recording's steps, as QA takes them: what the cursor and camera follow (camera.ts). */
const timelines = new WeakMap<Page, Step[]>();

/** Where `target` is on the page, CSS px. */
async function where(target: ReturnType<Page["locator"]>): Promise<Box> {
  const box = await target.first().boundingBox();
  if (box === null) throw new Error("a step's target has no box");
  return box;
}

/** Notes a step in the page's timeline. */
const note = (page: Page, kind: Step["kind"], at: number, until: number, box: Box, hint: Hint = {}) => timelines.get(page)?.push({ kind, at, until, box, ...hint });

/** A step's hint for the camera: `zoom: false` to leave it where it is, or a zoom of its own. */
type Hint = Pick<Step, "zoom">;

/**
 * Points the camera at what `targets` show, together, from `from` to `until`, while the app moves on its own: a take
 * with nothing to click.
 */
async function look(page: Page, from: number, until: number, ...targets: Array<ReturnType<Page["locator"]>>) {
  const boxes = await Promise.all(targets.map(where));
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const width = Math.max(...boxes.map((b) => b.x + b.width)) - x;
  const height = Math.max(...boxes.map((b) => b.y + b.height)) - y;
  note(page, "look", from, until, { x, y, width, height });
}

/** Clicks what `target` finds, then leaves no hover or focus ring behind. */
async function press(page: Page, target: ReturnType<Page["locator"]>, hint: Hint = {}) {
  const box = await where(target);
  const at = Date.now();
  note(page, "click", at, at, box, hint);
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
  const field = page.locator("[data-composer] textarea");
  const clicked = Date.now();
  note(page, "click", clicked, clicked, await where(field), { zoom: false });
  await field.click();
  let typed = 0;
  for (let i = 0; i < text.length; i += BURST) {
    const next = Date.now() + BURST_MS;
    await page.keyboard.insertText(text.slice(i, i + BURST));
    if (typed === 0) typed = Date.now();
    await sleepUntil(next);
  }
  const box = await where(page.locator("[data-composer]"));
  await sleepUntil(Date.now() + 150);
  await page.keyboard.press("Enter");
  const sent = Date.now();
  note(page, "type", typed, sent, box);
  return { typing: frames.find((x) => x.at > typed)?.at ?? typed, sent };
}

/** The phone's code, a digit as each shows after Take over. */
async function typeCode(page: Page, takenAt: number) {
  const from = takenAt + DIGIT_MS.first - 120;
  for (const [k, digit] of Array.from(CODE).entries()) {
    await sleepUntil(from + k * DIGIT_MS.every);
    await page.keyboard.type(digit);
  }
  note(page, "type", from, Date.now(), await where(page.getByLabel("The page: your clicks and keys go to it")));
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
    await look(page, sent + STEPS.batch + 200, sent + STEPS.merged + 600, page.getByRole("region", { name: "Merging now" }), page.getByRole("region", { name: "Recent" }));
    await sleepUntil(sent + STEPS.merged + 2200);
    return { takes: [[typing, sent + 4900], [sent + STEPS.batch - 500, sent + STEPS.merged + 2200]], poster: sent + 4700 };
  },
  // checkout's chat: Sam's ask, Alice's beside it, and the lead's answer to both.
  team: async (page) => {
    const { typing, sent } = await ask(page, TEAM_REQUEST, frames);
    await sleepUntil(sent + TEAM_STEPS.said + 200);
    // The conversation, from Sam's ask to the lead's answer, once it is all there.
    await look(page, sent + 700, sent + TEAM_STEPS.said + 600, page.getByText(TEAM_REQUEST).first(), page.getByText(/^Sam, Alice: one order/u));
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
    await look(page, sent + STEPS.screens + 1500, sent + 8500, page.getByLabel(/^The page/u));
    await sleepUntil(sent + 9600);
    await press(page, page.getByRole("button", { name: "All screens" }));
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
  // From storefront to Ada: its lease renewal for Marta waits on you. Send it, and it went.
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
  const steps: Step[] = [];
  timelines.set(page, steps);
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
  const at = (t: number) => Math.max(0, frames.findLastIndex((x) => x.at <= t));
  const ticks: Array<{ t: number; frame: number }> = [];
  run.takes.forEach(([from, to], n) => {
    for (let t = n === 0 ? from - (FADE * 1000) / FPS : from; t <= to; t += 1000 / FPS) ticks.push({ t, frame: at(t) });
  });
  const view = { width: 1400, height: 900 };
  // What each click changed: the camera frames it with the click.
  for (const [n, step] of steps.entries()) {
    if (step.kind !== "click" || step.zoom === false) continue;
    const after = Math.min(step.at + 800, (steps[n + 1]?.at ?? Infinity) - 50);
    const a = frames[at(step.at - 30)]?.jpeg;
    const b = frames[at(after)]?.jpeg;
    if (a === undefined || b === undefined) continue;
    const changed = await effect(page, a, b, view);
    if (changed !== null) steps[n] = { ...step, effect: changed };
  }
  // As far in as the recording's pixels go at the full size, so text stays as sharp as unzoomed.
  const cap = Math.min(1.8, (view.height * scale) / FULL.height);
  const directions = direct(steps, run.takes, { view, cap, fade: (FADE * 1000) / FPS }, ticks.map((k) => k.t));
  const video = await looped(page, await film(page, frames, ticks.map((k, n) => ({ frame: k.frame, ...(directions[n] as Direction) })), view), FADE);
  pacing(clip, frames, run.takes, directions.slice(FADE));
  // For ffmpeg, one after another in a file.
  const mjpeg = test.info().outputPath("frames.mjpeg");
  mkdirSync(path.dirname(mjpeg), { recursive: true });
  writeFileSync(mjpeg, "");
  for (const jpeg of video) appendFileSync(mjpeg, jpeg);
  const out = path.join(repo, "site", `showcase-${clip}-${theme}`);
  // The poster, lighter than a screencast frame: the page shows it until the video plays, and instead of it with
  // reduced motion. The whole window, without the cursor.
  const still = frames.findLast((x) => x.at <= run.poster)?.jpeg;
  if (still === undefined) throw new Error("no frame for the poster");
  await poster(page, still, 2800, 0.78, `${out}.jpg`);
  await poster(page, still, 1400, 0.8, `${out}-small.jpg`);
  // Two sizes: the window at 2x for a wide screen, and 720 rows for a small one (the page picks by the frame's pixels).
  // VP9 at a fixed quality (CRF), in two passes: UI text as sharp as the app's own on the big one.
  for (const [width, height, file, crf] of [[FULL.width, FULL.height, `${out}.webm`, 22], [1120, 720, `${out}-small.webm`, 30]] as const) {
    const log = path.join(test.info().outputPath(), `vp9-${String(height)}`);
    for (const pass of [1, 2]) {
      const encode = spawnSync(
        ffmpeg(),
        ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", mjpeg, "-vf", `scale=${String(width)}:${String(height)}:flags=lanczos`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-crf", String(crf), "-b:v", "0", "-pass", String(pass), "-passlogfile", log, "-g", String(2 * FPS), "-row-mt", "1", "-tile-columns", "2", "-threads", "4", "-auto-alt-ref", "1", "-lag-in-frames", "25", "-deadline", "good", "-cpu-used", pass === 1 ? "4" : "2", "-an", ...(pass === 1 ? ["-f", "webm", devNull] : [file])],
        { maxBuffer: 1 << 26 },
      );
      if (encode.status !== 0) throw new Error(`ffmpeg failed: ${String(encode.stderr)}`);
    }
  }
  // And as H.264, for Safari on an older iPhone or Mac, at about what x264's CRF 18 gives.
  // H.264 level 4.2 holds at most 8,704 macroblocks a frame and 522,240 a second: 1792x1152 at 60 fps (8,064 and
  // 483,840) is the most 14:9 under it, which older iPhones and iPads decode.
  await mp4(page, video, { width: 1792, height: 1152 }, "avc1.64002A", 42, 20, 12_000_000, `${out}.mp4`);
  await mp4(page, video, { width: 1120, height: 720 }, "avc1.640028", 40, 26, 5_000_000, `${out}-small.mp4`);
}

/**
 * Logs the clip's frame pacing: how often the screencast sent a frame over its takes (it sends one only when the app
 * drew), and how evenly the cursor and camera move from one 60 fps frame to the next while they move.
 */
function pacing(clip: string, frames: ReadonlyArray<{ at: number }>, takes: ReadonlyArray<readonly [number, number]>, moves: readonly Direction[]) {
  const gaps = takes.flatMap(([from, to]) => {
    const at = frames.filter((f) => f.at >= from && f.at <= to).map((f) => f.at);
    return at.slice(1).map((t, n) => t - (at[n] ?? t));
  });
  const sorted = gaps.toSorted((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const speed = (a: Direction, b: Direction) => Math.hypot(b.pointer.x - a.pointer.x, b.pointer.y - a.pointer.y);
  // A jump: a frame whose move is more than twice the larger of its neighbours', while moving faster than 2 px a frame.
  let jumps = 0;
  for (let n = 2; n < moves.length - 1; n++) {
    const [a, b, c, d] = [moves[n - 2], moves[n - 1], moves[n], moves[n + 1]];
    if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
    const now = speed(b, c);
    if (now > 2 && now > 2 * Math.max(speed(a, b), speed(c, d))) jumps++;
  }
  console.log(`${clip}: screencast ${String(gaps.length + takes.length)} frames, every ${String(q(0.5))} ms (p95 ${String(q(0.95))}, longest ${String(q(1))}); ${String(moves.length)} frames at ${String(FPS)} fps, ${String(jumps)} cursor jumps`);
}

for (const clip of ["lead", "team", "screens", "navi"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`showcase ${clip} ${theme}`, async () => {
      test.setTimeout(600_000);
      const { app, page, settled, close } = await launch("showcase-order", appMain, { realClock: true });
      try {
        await record(app, page, settled, clip, theme);
      } finally {
        await close();
      }
    });
  }
}
