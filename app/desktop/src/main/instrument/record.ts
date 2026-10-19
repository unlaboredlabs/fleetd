// FLEETD_RECORD=<dir>[,fps]: the app records its own window to <dir>/fleetd.mp4 (H.264), keeps a PNG of it every
// 2 s in <dir>/frames/, and between clipStart() and SIGUSR1 also writes <dir>/clip.mp4. tests/lab/demoFanout.ts reads
// its log lines.
//
// The capture is Chromium's tab capture of the app window's own frame, encoded by MediaRecorder in a hidden
// recorder window (src/renderer/demo/recorder.ts): no OS screen capture, so no Screen Recording permission, and no
// ffmpeg. The capture is the page only, so on macOS the recorder paints the traffic lights back where the window
// server draws them (grey while the window is inactive, as macOS shows them).
//
// Quitting (SIGTERM, SIGINT, Cmd-Q, closing the window) waits for both files to be finished; a run killed outright
// keeps what was written so far, which plays up to its last whole fragment.
import { mkdirSync } from "node:fs";
import { open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, nativeTheme, powerSaveBlocker, screen, session, systemPreferences } from "electron";
import { type Chunk, type Lights, RECORDER_GLOBAL, type RecorderApi, type RecorderStart, type Take } from "../../shared/recorder";
import { DEV_BUILD } from "../build";
import { bitrateFor, type RecordConfig, trafficLights } from "./recordConfig";

const PULL_MS = 500;
const STILL_MS = 2000;
const FINISH_MS = 15_000;
const log = (line: string): void => console.error(`FLEETD_RECORD ${line}`);

type Call = { [K in keyof RecorderApi]: RecorderApi[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };

/** The recorder page's API, called across with executeJavaScript (the page has no preload). */
const remote = (win: BrowserWindow): Call => {
  const call = (method: keyof RecorderApi, ...args: Array<unknown>) =>
    win.webContents.executeJavaScript(`window.${RECORDER_GLOBAL}.${method}(${args.map((a) => JSON.stringify(a)).join(",")})`);
  return {
    start: (options: RecorderStart) => call("start", options) as Promise<string>,
    clipStart: () => call("clipStart") as Promise<undefined>,
    stop: (take: Take) => call("stop", take) as Promise<undefined>,
    drain: () => call("drain") as Promise<ReadonlyArray<Chunk>>,
    setActive: (active: boolean) => call("setActive", active) as Promise<undefined>,
    still: () => call("still") as Promise<Uint8Array | null>,
  };
};

/** The recorder page: the dev server's while developing, else the built file. */
const recorderUrl = (): string => {
  const dev = process.env["ELECTRON_RENDERER_URL"];
  return dev !== undefined && DEV_BUILD
    ? new URL("demo/recorder.html", `${dev}/`).toString()
    : pathToFileURL(join(import.meta.dirname, "../renderer/demo/recorder.html")).toString();
};

/**
 * The recorder's own in-memory session, apart from the page session (which refuses file:// outright): it may
 * capture, and load nothing but its own page and script.
 */
const recorderSession = (target: BrowserWindow, page: string) => {
  const ses = session.fromPartition("fleetd-recorder");
  const assets = new URL("../assets/", page).toString();
  const devOrigin = page.startsWith("file:") ? null : new URL(page).origin;
  const own = (url: string) => (devOrigin === null ? url === page || url.startsWith(assets) : url.startsWith(`${devOrigin}/`));
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media" || permission === "display-capture"));
  ses.setPermissionCheckHandler((_contents, permission) => permission === "media" || permission === "display-capture");
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !own(details.url) }));
  // The only thing it can ever be given is the app window's own page.
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({ video: target.webContents.mainFrame }));
  return ses;
};

const openRecorder = async (target: BrowserWindow): Promise<BrowserWindow> => {
  const page = recorderUrl();
  const win = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { session: recorderSession(target, page), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadURL(page);
  return win;
};

/**
 * The traffic lights to paint back, on macOS (FLEETD_RECORD_CHROME=1 elsewhere, to check the drawing on Linux CI).
 * The position is the window's own; the app sets it in main/index.ts.
 */
const lightsFor = (target: BrowserWindow): Lights | null => {
  const mac = process.platform === "darwin";
  if (!mac && process.env["FLEETD_RECORD_CHROME"] !== "1") return null;
  const position = (mac ? target.getWindowButtonPosition() : null) ?? { x: 16, y: 14 };
  const major = mac ? Number(process.getSystemVersion().split(".")[0]) : 15;
  return trafficLights(position, major, nativeTheme.shouldUseDarkColors);
};

export interface Recording {
  /** Begins clip.mp4 with the next frame. For a scripted demo, just before it starts typing. */
  clipStart(): void;
}

export const startRecording = async (target: BrowserWindow, config: RecordConfig): Promise<Recording | undefined> => {
  const mp4 = join(config.dir, "fleetd.mp4");
  const files: Record<Take, string> = { full: mp4, clip: join(config.dir, "clip.mp4") };
  let recorder: BrowserWindow;
  let size: { width: number; height: number };
  let contentWidth: number;
  try {
    mkdirSync(join(config.dir, "frames"), { recursive: true });
    await Promise.all([rm(files.full, { force: true }), rm(files.clip, { force: true })]);
    recorder = await openRecorder(target);
    const [w = 0, h = 0] = target.getContentSize();
    contentWidth = w;
    const scale = screen.getDisplayMatching(target.getBounds()).scaleFactor;
    // H.264 wants even dimensions.
    size = { width: Math.round(w * scale) & ~1, height: Math.round(h * scale) & ~1 };
  } catch (error) {
    log(`error=cannot record into ${config.dir}: ${String(error)}`);
    return undefined;
  }
  const page = remote(recorder);
  try {
    await page.start({ fps: config.fps, ...size, contentWidth, bitrate: bitrateFor(size.width, size.height, config.fps), lights: lightsFor(target) });
  } catch (error) {
    log(`error=${String(error)}`);
    recorder.destroy();
    return undefined;
  }
  // A covered or napping window would stop producing frames: keep it rendering, and keep macOS from App Napping the
  // process, for as long as the recording runs (the process exits after it).
  target.webContents.setBackgroundThrottling(false);
  powerSaveBlocker.start("prevent-app-suspension");
  const started = performance.now();
  const seconds = () => (performance.now() - started) / 1000;
  const access = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") === "granted" : "n/a";
  log(`start window=${target.id} fps=${config.fps} size=${size.width}x${size.height} screen_capture_access=${access} out=${mp4}`);

  const handles = new Map<Take, FileHandle>();
  const bytes: Record<Take, number> = { full: 0, clip: 0 };
  const ended = new Set<Take>();
  let clipFrom: number | undefined;
  let failed = false;

  // One pull at a time, so chunks land in the order they were encoded.
  let pulling: Promise<void> = Promise.resolve();
  const pull = () => {
    pulling = pulling.then(async () => {
      if (recorder.isDestroyed()) return;
      for (const chunk of await page.drain()) {
        if ("bytes" in chunk) {
          const handle = handles.get(chunk.take) ?? (await open(files[chunk.take], "a"));
          handles.set(chunk.take, handle);
          await handle.write(chunk.bytes);
          bytes[chunk.take] += chunk.bytes.byteLength;
        } else if ("end" in chunk) {
          await handles.get(chunk.take)?.close();
          handles.delete(chunk.take);
          ended.add(chunk.take);
          if (chunk.take === "clip" && clipFrom !== undefined) log(`clip_done mp4=${files.clip} seconds=${(seconds() - clipFrom).toFixed(1)}`);
        } else {
          failed = true;
          log(chunk.take === "clip" ? `clip_error=${chunk.error}` : `error=${chunk.error}`);
        }
      }
    });
    return pulling;
  };
  const pump = setInterval(() => void pull().catch((error: unknown) => log(`error=${String(error)}`)), PULL_MS);

  const active = () => void page.setActive(target.isFocused()).catch(() => undefined);
  target.on("focus", active);
  target.on("blur", active);
  active();

  let stills = 0;
  const still = async () => {
    if (recorder.isDestroyed()) return;
    const at = seconds();
    const png = await page.still();
    if (png === null) return;
    await writeFile(join(config.dir, "frames", `frame-${at.toFixed(1).padStart(6, "0")}s.png`), png);
    stills += 1;
  };
  void still();
  const stillTimer = setInterval(() => void still().catch(() => undefined), STILL_MS);

  /** Stops `take` and resolves once its last byte is on disk (or after FINISH_MS). */
  const stop = async (take: Take) => {
    if (recorder.isDestroyed() || ended.has(take)) return;
    await page.stop(take);
    const deadline = performance.now() + FINISH_MS;
    while (!ended.has(take) && !recorder.isDestroyed() && performance.now() < deadline) {
      await pull();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  let finishing: Promise<void> | undefined;
  const finish = () =>
    (finishing ??= (async () => {
      clearInterval(stillTimer);
      const total = seconds();
      try {
        if (clipFrom !== undefined) await stop("clip");
        await stop("full");
      } catch (error) {
        log(`error=${String(error)}`);
      }
      clearInterval(pump);
      for (const handle of handles.values()) await handle.close();
      if (!recorder.isDestroyed()) recorder.destroy();
      if (ended.has("full") && !failed) log(`done mp4=${mp4} bytes=${bytes.full} pngs=${stills} seconds=${total.toFixed(1)}`);
      else if (!failed) log(`error=the capture did not finish within ${FINISH_MS / 1000} s; ${mp4} may be cut short`);
    })());

  // Hold every way out until the files are whole: a quit (signals included) and closing the window.
  let finished = false;
  app.on("before-quit", (event) => {
    if (finished) return;
    event.preventDefault();
    void finish().then(() => {
      finished = true;
      app.quit();
    });
  });
  target.on("close", (event) => {
    if (finished) return;
    event.preventDefault();
    void finish().then(() => {
      finished = true;
      target.close();
    });
  });
  process.on("SIGUSR1", () => {
    if (clipFrom === undefined) return;
    void stop("clip").catch((error: unknown) => log(`clip_error=${String(error)}`));
  });

  return {
    clipStart() {
      if (clipFrom !== undefined || recorder.isDestroyed()) return;
      clipFrom = seconds();
      void page.clipStart().then(
        () => log(`clip_start at=${(clipFrom ?? 0).toFixed(3)}s`),
        (error: unknown) => log(`clip_error=${String(error)}`),
      );
    },
  };
};
