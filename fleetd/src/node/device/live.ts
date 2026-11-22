// Android sessions' live view and takeover, as browser sessions have them: the
// hub's `browser_watch`, `browser_input` and `browser_control` for a device session come here. A watched device's
// screen goes out through a pump that turns each new frame (scrcpy's) into a `browser_frame`, the newest only and
// fitted to the watcher's link (browser/fit.ts); a person's mouse and keys become one finger, a scroll, a key or text.
import type { BrowserControl, BrowserFrame, BrowserInput } from "../../shared/contracts.ts";
import { Pacer } from "../browser/fit.ts";
import type { Frame, Input } from "./scrcpy_wire.ts";

/** A device's screen frame as the hub's live view takes it. */
export function browserFrame(sessionId: string, frame: Frame, control: BrowserControl): BrowserFrame {
  return {
    sessionId,
    seq: frame.seq,
    ...(frame.video
      ? { h264B64: Buffer.from(frame.video.data).toString("base64"), key: frame.video.key }
      : { jpegB64: Buffer.from(frame.jpeg).toString("base64") }),
    width: Math.max(frame.width, 1),
    height: Math.max(frame.height, 1),
    control,
  };
}

/**
 * A person's input as the device takes it; undefined for what a touch screen has no use for (hovering, other buttons,
 * a browser's address bar). `pressed` says whether this session has a finger down, and changes with a press or release.
 */
export function deviceInput(input: BrowserInput, pressed: { down: boolean }): Input | undefined {
  switch (input.kind) {
    case "mouse": {
      const { x, y } = input;
      if (input.action === "pressed" && input.button === "left") {
        pressed.down = true;
        return { kind: "touch", action: "down", x, y };
      }
      if (input.action === "released" && pressed.down) {
        pressed.down = false;
        return { kind: "touch", action: "up", x, y };
      }
      if (input.action === "moved" && pressed.down) return { kind: "touch", action: "move", x, y };
      if (input.action === "wheel") return { kind: "scroll", x, y, dx: input.deltaX ?? 0, dy: input.deltaY ?? 0 };
      return undefined;
    }
    case "key": {
      // A key that types goes as its text, once; its release then says nothing more.
      const typed = input.text ?? ([...input.key].length === 1 ? input.key : undefined);
      const modifiers = input.modifiers ?? 0;
      const ctrlOrMeta = (modifiers & (2 | 4)) !== 0;
      if (typed !== undefined && !ctrlOrMeta) return input.action === "down" ? { kind: "text", text: typed } : undefined;
      return { kind: "key", down: input.action === "down", key: input.key, modifiers };
    }
    case "text":
      return { kind: "text", text: input.text };
    default:
      return undefined;
  }
}

/**
 * Sends each new frame to the hub, the newest at once, then each as the watcher's link has room for it (`kbps`, the
 * hub's word for its slowest viewer); the frames that come meanwhile wait, and only the newest of them goes. An H.264
 * frame goes at once, in order: its encoder keeps to the budget, and one skipped would break the ones after it. One
 * that comes while a JPEG is being fitted (a still before its keyframe) goes right after that JPEG.
 */
export class Pump {
  private readonly pacer = new Pacer();
  private next: Frame | undefined;
  private busy = false;
  private stopped = false;
  /** H.264 frames waiting for the JPEG being fitted. */
  private after: Frame[] = [];
  private fitting = false;

  constructor(
    private readonly sessionId: string,
    private readonly control: () => BrowserControl,
    private readonly send: (frame: BrowserFrame) => void,
    public kbps: number | undefined,
  ) {}

  offer(frame: Frame): void {
    if (this.stopped) return;
    if (frame.video) {
      this.next = undefined;
      if (this.fitting) return void this.after.push(frame);
      return this.send(browserFrame(this.sessionId, frame, this.control()));
    }
    this.next = frame;
    if (!this.busy) void this.run();
  }

  private async run(): Promise<void> {
    this.busy = true;
    try {
      while (this.next && !this.stopped) {
        const frame = this.next;
        this.next = undefined;
        this.fitting = true;
        const fitted = await this.pacer.fit(this.kbps, browserFrame(this.sessionId, frame, this.control())).finally(() => (this.fitting = false));
        if (this.stopped) return;
        this.send(fitted);
        const after = this.after;
        this.after = [];
        for (const f of after) this.send(browserFrame(this.sessionId, f, this.control()));
        const wait = this.pacer.wait(this.kbps);
        if (wait > 0) await Bun.sleep(wait);
      }
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.next = undefined;
    this.after = [];
  }
}
