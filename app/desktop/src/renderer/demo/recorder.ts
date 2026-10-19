// The FLEETD_RECORD encoder, in a hidden window of its own (src/main/instrument/record.ts). getDisplayMedia here is
// answered by main with the app window's own frame, i.e. Chromium's tab capture: the compositor's output, with no
// OS screen capture and so no Screen Recording permission. MediaRecorder encodes it to H.264 MP4 in real time.
import { type Chunk, RECORDER_GLOBAL, RECORDER_MIME, type RecorderApi, type Take } from "../../shared/recorder";

const TIMESLICE_MS = 1000;

let stream: MediaStream | undefined;
const recorders = new Map<Take, MediaRecorder>();
const queue: Array<Chunk> = [];
// Blob → bytes is async; chaining keeps each take's chunks in the order they were encoded.
let pending: Promise<void> = Promise.resolve();
let bitrate = 0;

const record = (take: Take): void => {
  if (stream === undefined || recorders.has(take)) return;
  const recorder = new MediaRecorder(stream, { mimeType: RECORDER_MIME, videoBitsPerSecond: bitrate });
  recorder.ondataavailable = (event) => {
    const data = event.data;
    pending = pending.then(async () => {
      if (data.size > 0) queue.push({ take, bytes: new Uint8Array(await data.arrayBuffer()) });
    });
  };
  recorder.onerror = (event) => {
    const error = event instanceof ErrorEvent ? event.message : "MediaRecorder failed";
    pending = pending.then(() => void queue.push({ take, error }));
  };
  recorder.onstop = () => {
    pending = pending.then(() => void queue.push({ take, end: true }));
  };
  recorders.set(take, recorder);
  recorder.start(TIMESLICE_MS);
};

const api: RecorderApi = {
  async start(options) {
    if (!MediaRecorder.isTypeSupported(RECORDER_MIME)) throw new Error(`this Electron can't record ${RECORDER_MIME}`);
    bitrate = options.bitrate;
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: options.fps, max: options.fps }, width: { ideal: options.width }, height: { ideal: options.height } },
      audio: false,
    });
    record("full");
    return RECORDER_MIME;
  },
  clipStart: () => record("clip"),
  stop(take) {
    const recorder = recorders.get(take);
    if (recorder?.state === "recording") recorder.stop();
  },
  async drain() {
    await pending;
    return queue.splice(0);
  },
};

Object.defineProperty(window, RECORDER_GLOBAL, { value: api });
