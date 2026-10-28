// The FLEETD_RECORD encoder, in a hidden window of its own (src/main/instrument/record.ts). getDisplayMedia here is
// answered by main with the app window's own frame, i.e. Chromium's tab capture: the compositor's output, with no
// OS screen capture and so no Screen Recording permission. Each frame goes through an OffscreenCanvas, where the
// macOS traffic lights (drawn by the window server, so not in the capture) are painted back, and MediaRecorder
// encodes the result to H.264 MP4 in real time. The stills come from the same canvas.
//
// Frames are carried by Chromium's insertable streams, not a <video> and requestVideoFrameCallback: this window is
// never shown, so it never renders, and only a pipeline outside rendering sees every frame (with its own timestamp).
//
// A take's encoder starts on the first frame its MediaRecorder gets, and a stop before the encoder has delivered one
// finishes an empty take (no bytes at all). On a hosted macOS runner the encoder has started up to 3.6 s after the
// capture's first frame: Chromium's recorder takes frames only once it knows which encoders the GPU process offers,
// and an idle page sends no more after that. So until a take's encoder has delivered a frame, the canvas's last frame
// is sent again every PROBE_MS, and a stop waits for that first frame. Nothing else shows when it comes (the MP4 is
// handed over only at stop, whatever the timeslice), but requestData returns the file's first bytes (its ftyp) once
// it has, so each take asks for them every PROBE_MS too.
import { type Chunk, type Lights, RECORDER_GLOBAL, RECORDER_MIME, type RecorderApi, type Take } from "../../shared/recorder";

const TIMESLICE_MS = 1000;
const PROBE_MS = 50;
/** How long a stop waits for the take's encoder to deliver its first frame. */
const BEGIN_MS = 10_000;

// Chromium's insertable streams for video, which TypeScript's DOM types don't carry yet.
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<VideoFrame>;
}
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: "video" });
  readonly writable: WritableStream<VideoFrame>;
}

let canvas: OffscreenCanvas | undefined;
let stream: MediaStream | undefined;
const recorders = new Map<Take, MediaRecorder>();
/** Each take's first bytes, which come once its encoder has delivered a frame. */
const begun = new Map<Take, Promise<void>>();
let startedAt = 0;
let frames = 0;
let firstFrame: number | null = null;
let encoding: number | null = null;
const since = () => (performance.now() - startedAt) / 1000;
const queue: Array<Chunk> = [];
// Blob → bytes is async; chaining keeps each take's chunks in the order they were encoded.
let pending: Promise<void> = Promise.resolve();
let bitrate = 0;
let active = true;
/** Whether the canvas holds a frame yet; a still before that would be blank. */
let drawn = false;
/** Sends the canvas again, if nothing went out for PROBE_MS. */
let resend = (): void => undefined;

const record = (take: Take): void => {
  if (stream === undefined || recorders.has(take)) return;
  const recorder = new MediaRecorder(stream, { mimeType: RECORDER_MIME, videoBitsPerSecond: bitrate });
  let probe: ReturnType<typeof setInterval> | undefined;
  let begin: () => void = () => undefined;
  begun.set(take, new Promise<void>((resolve) => (begin = resolve)));
  recorder.ondataavailable = (event) => {
    const data = event.data;
    if (data.size > 0 && probe !== undefined) {
      clearInterval(probe);
      probe = undefined;
      if (take === "full") encoding = since();
      begin();
    }
    pending = pending.then(async () => {
      if (data.size > 0) queue.push({ take, bytes: new Uint8Array(await data.arrayBuffer()) });
    });
  };
  recorder.onerror = (event) => {
    const error = event instanceof ErrorEvent ? event.message : "MediaRecorder failed";
    pending = pending.then(() => void queue.push({ take, error }));
  };
  recorder.onstop = () => {
    clearInterval(probe);
    pending = pending.then(() => void queue.push({ take, end: true }));
  };
  recorders.set(take, recorder);
  recorder.start(TIMESLICE_MS);
  probe = setInterval(() => {
    resend();
    if (recorder.state === "recording") recorder.requestData();
  }, PROBE_MS);
};

const drawLights = (ctx: OffscreenCanvasRenderingContext2D, lights: Lights, scale: number): void => {
  lights.centers.forEach(([x, y], i) => {
    const [fill, rim] = active ? (lights.active[i] ?? lights.inactive) : lights.inactive;
    ctx.beginPath();
    ctx.arc(x * scale, y * scale, (lights.radius - 0.25) * scale, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 0.5 * scale;
    ctx.strokeStyle = rim;
    ctx.stroke();
  });
};

const api: RecorderApi = {
  async start(options) {
    if (!MediaRecorder.isTypeSupported(RECORDER_MIME)) throw new Error(`this Electron can't record ${RECORDER_MIME}`);
    bitrate = options.bitrate;
    const capture = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: options.fps, max: options.fps }, width: { ideal: options.width }, height: { ideal: options.height } },
      audio: false,
    });
    const [track] = capture.getVideoTracks();
    if (track === undefined) throw new Error("the capture has no video");
    const out = new OffscreenCanvas(options.width, options.height);
    const ctx = out.getContext("2d", { alpha: false });
    if (ctx === null) throw new Error("no 2d canvas");
    const scale = options.width / options.contentWidth;
    const generator = new MediaStreamTrackGenerator({ kind: "video" });
    // The last frame out, in the capture's microseconds and in performance.now() milliseconds.
    let sent = { timestamp: 0, at: 0 };
    const send = (controller: TransformStreamDefaultController<VideoFrame>, timestamp: number) => {
      // Never behind a frame sent again, which carries a timestamp of its own.
      const next = Math.max(timestamp, sent.timestamp + 1);
      controller.enqueue(new VideoFrame(out, { timestamp: next }));
      sent = { timestamp: next, at: performance.now() };
    };
    void new MediaStreamTrackProcessor({ track }).readable
      .pipeThrough(
        new TransformStream<VideoFrame, VideoFrame>({
          start(controller) {
            resend = () => {
              const idle = performance.now() - sent.at;
              if (drawn && idle >= PROBE_MS) send(controller, sent.timestamp + Math.round(idle * 1000));
            };
          },
          transform(frame, controller) {
            // Top-left anchored at 1:1, so a resized window crops or pads instead of stretching.
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, out.width, out.height);
            ctx.drawImage(frame, 0, 0);
            if (options.lights !== null) drawLights(ctx, options.lights, scale);
            const timestamp = frame.timestamp;
            frame.close();
            send(controller, timestamp);
            drawn = true;
            frames += 1;
            firstFrame ??= since();
          },
        }),
      )
      .pipeTo(generator.writable);
    canvas = out;
    stream = new MediaStream([generator]);
    startedAt = performance.now();
    record("full");
    return RECORDER_MIME;
  },
  clipStart: () => record("clip"),
  async stop(take) {
    const recorder = recorders.get(take);
    if (recorder?.state !== "recording") return;
    await Promise.race([begun.get(take), new Promise((resolve) => setTimeout(resolve, BEGIN_MS))]);
    // A no-op if it stopped meanwhile.
    recorder.stop();
  },
  async drain() {
    await pending;
    return queue.splice(0);
  },
  setActive(value) {
    active = value;
  },
  timing: () => ({ frames, firstFrame, encoding }),
  async still() {
    if (canvas === undefined || !drawn) return null;
    return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  },
};

Object.defineProperty(window, RECORDER_GLOBAL, { value: api });
