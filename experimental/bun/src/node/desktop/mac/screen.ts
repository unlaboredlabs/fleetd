// The Mac's own screen, read and driven by the node (crates/fleetd/src/node/desktop/mac/capture.rs, input.rs), under its
// own Screen Recording and Accessibility grants. Frames come from ScreenCaptureKit at the display's points
// (capture.ts); input goes as CGEvents through bun:ffi. Every CoreGraphics call it makes takes and returns plain values:
// a CGPoint argument is passed as its two doubles, which both the arm64 and the x86_64 calling conventions place where
// the struct would go.
//
// The pointer's place comes from HIToolbox's HIGetMousePosition, which writes it to memory and returns that memory's
// address (not a status), since CGEventGetLocation returns a struct.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { jpeg, type Raw, type Screen, type Shot } from "../screen.ts";
import { parseChord } from "../x11.ts";
import { Capture } from "./capture.ts";
import { ofChar, ofSym, SHIFT } from "./keys.ts";

const LEFT_DOWN = 1;
const LEFT_UP = 2;
const RIGHT_DOWN = 3;
const RIGHT_UP = 4;
const MOVED = 5;
const LEFT_DRAGGED = 6;
const RIGHT_DRAGGED = 7;
const OTHER_DOWN = 25;
const OTHER_UP = 26;
const OTHER_DRAGGED = 27;
const HID = 0;
const CLICK_STATE = 1;
const LINES = 1;
/** HIToolbox's `kHICoordSpace72DPIGlobal`: points, from the main display's top left. */
const GLOBAL_POINTS = 1;

const CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const HI = "/System/Library/Frameworks/Carbon.framework/Frameworks/HIToolbox.framework/HIToolbox";

function load() {
  const cg = dlopen(CG, {
    CGMainDisplayID: { returns: FFIType.u32 },
    CGDisplayPixelsWide: { args: [FFIType.u32], returns: FFIType.u64 },
    CGDisplayPixelsHigh: { args: [FFIType.u32], returns: FFIType.u64 },
    CGEventCreateMouseEvent: { args: [FFIType.ptr, FFIType.u32, FFIType.f64, FFIType.f64, FFIType.u32], returns: FFIType.ptr },
    CGEventCreateKeyboardEvent: { args: [FFIType.ptr, FFIType.u16, FFIType.bool], returns: FFIType.ptr },
    CGEventKeyboardSetUnicodeString: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
    CGEventCreateScrollWheelEvent2: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
    CGEventSetIntegerValueField: { args: [FFIType.ptr, FFIType.u32, FFIType.i64], returns: FFIType.void },
    CGEventSetFlags: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
    CGEventPost: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
  });
  const cf = dlopen(CF, { CFRelease: { args: [FFIType.ptr], returns: FFIType.void } });
  // `HIPoint *HIGetMousePosition(HICoordinateSpace, void *, HIPoint *)`: returns the point it was given, filled in.
  type Hi = { HIGetMousePosition: (space: number, object: null, out: unknown) => unknown };
  let hi: Hi | undefined;
  try {
    hi = dlopen(HI, { HIGetMousePosition: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr } }).symbols as unknown as Hi;
  } catch {
    hi = undefined;
  }
  return { cg: cg.symbols, cf: cf.symbols, hi };
}

type Api = ReturnType<typeof load>;
let api: Api | undefined;
function open(): Api {
  if (process.platform !== "darwin") throw new Error("the Mac screen is a Mac's own");
  try {
    api ??= load();
  } catch (e) {
    throw new Error(`this Mac lacks what its screen needs: ${(e as Error).message}`);
  }
  return api;
}

/** The mouse event kinds for a button (1 left, 2 middle, 3 right): pressed, released, dragged, and its number. */
function kinds(button: number): [number, number, number, number] {
  if (button === 3) return [RIGHT_DOWN, RIGHT_UP, RIGHT_DRAGGED, 1];
  if (button === 2) return [OTHER_DOWN, OTHER_UP, OTHER_DRAGGED, 2];
  return [LEFT_DOWN, LEFT_UP, LEFT_DRAGGED, 0];
}

export class MacScreen implements Screen {
  private flags = 0;
  private buttons = 0;
  /** Where the node last put the pointer, where macOS can't say. */
  private last: [number, number] = [0, 0];
  private queue: Promise<unknown> = Promise.resolve();

  private readonly capture = new Capture();

  private constructor(private readonly api: Api) {}

  static open(): MacScreen {
    return new MacScreen(open());
  }

  size(): [number, number] {
    const id = this.api.cg.CGMainDisplayID();
    return [Math.max(1, Number(this.api.cg.CGDisplayPixelsWide(id))), Math.max(1, Number(this.api.cg.CGDisplayPixelsHigh(id)))];
  }

  changed(): boolean {
    return true;
  }

  /** The main display in BGRA at its points, the pointer drawn. */
  grabRaw(): Promise<Raw> {
    return this.capture.grab(this.size());
  }

  encode(raw: Raw): Promise<Uint8Array> {
    return jpeg(raw.data, raw.width, raw.height);
  }

  async grab(): Promise<Shot> {
    const raw = await this.grabRaw();
    return { jpeg: await this.encode(raw), width: raw.width, height: raw.height };
  }

  async sync(): Promise<void> {
    await Bun.sleep(20);
  }

  private post(event: unknown): void {
    if (!event) throw new Error("macOS made no event");
    this.api.cg.CGEventSetFlags(event as never, this.flags);
    this.api.cg.CGEventPost(HID, event as never);
    this.api.cf.CFRelease(event as never);
  }

  private clamp(x: number, y: number): [number, number] {
    const [w, h] = this.size();
    return [Math.max(0, Math.min(w - 1, Math.trunc(x))), Math.max(0, Math.min(h - 1, Math.trunc(y)))];
  }

  private mouse(kind: number, at: [number, number], button: number, clicks: number): void {
    const event = this.api.cg.CGEventCreateMouseEvent(null, kind, at[0], at[1], button);
    if (event && clicks > 0) this.api.cg.CGEventSetIntegerValueField(event, CLICK_STATE, clicks);
    this.post(event);
    this.last = at;
  }

  private keyCode(code: number, down: boolean): void {
    this.post(this.api.cg.CGEventCreateKeyboardEvent(null, code, down));
  }

  private keyText(text: string): void {
    const units = Uint16Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
    for (let at = 0; at < units.length; at += 20) {
      const chunk = units.subarray(at, at + 20);
      for (const down of [true, false]) {
        const event = this.api.cg.CGEventCreateKeyboardEvent(null, 0, down);
        if (event) this.api.cg.CGEventKeyboardSetUnicodeString(event, chunk.length, ptr(chunk));
        this.post(event);
      }
    }
  }

  private tap(code: number, shift: boolean): void {
    const before = this.flags;
    if (shift) this.flags |= SHIFT;
    try {
      this.keyCode(code, true);
      this.keyCode(code, false);
    } finally {
      this.flags = before;
    }
  }

  async moveTo(x: number, y: number): Promise<void> {
    const at = this.clamp(x, y);
    if (this.buttons === 0) return this.mouse(MOVED, at, 0, 0);
    const [, , dragged, which] = kinds(this.buttons);
    this.mouse(dragged, at, which, 0);
  }

  async button(button: number, down: boolean): Promise<void> {
    const at = await this.pointer();
    const [pressed, released, , which] = kinds(button);
    this.buttons = down ? button : 0;
    this.mouse(down ? pressed : released, at, which, 1);
  }

  async click(x: number, y: number, button: number, count: number): Promise<void> {
    const at = this.clamp(x, y);
    this.mouse(MOVED, at, 0, 0);
    const [pressed, released, , which] = kinds(button);
    for (let n = 1; n <= Math.max(1, count); n++) {
      this.mouse(pressed, at, which, n);
      this.mouse(released, at, which, n);
    }
    await this.sync();
  }

  async drag(from: [number, number], to: [number, number]): Promise<void> {
    const start = this.clamp(from[0], from[1]);
    this.mouse(MOVED, start, 0, 0);
    this.mouse(LEFT_DOWN, start, 0, 1);
    await this.sync();
    for (let step = 1; step <= 4; step++) {
      const at = (a: number, b: number) => a + Math.trunc(((b - a) * step) / 4);
      this.mouse(LEFT_DRAGGED, this.clamp(at(from[0], to[0]), at(from[1], to[1])), 0, 0);
      await Bun.sleep(15);
    }
    this.mouse(LEFT_UP, this.clamp(to[0], to[1]), 0, 1);
    await this.sync();
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    this.mouse(MOVED, this.clamp(x, y), 0, 0);
    const clamp = (n: number) => Math.max(-50, Math.min(50, n));
    this.post(this.api.cg.CGEventCreateScrollWheelEvent2(null, LINES, 2, -clamp(dy), -clamp(dx), 0));
    await this.sync();
  }

  async pointer(): Promise<[number, number]> {
    if (this.api.hi) {
      const at = new Float64Array([Number.NaN, Number.NaN]);
      const filled = this.api.hi.HIGetMousePosition(GLOBAL_POINTS, null, ptr(at));
      if (filled && Number.isFinite(at[0]) && Number.isFinite(at[1])) return [Math.round(at[0]!), Math.round(at[1]!)];
    }
    return this.last;
  }

  async keySym(sym: number, down: boolean, shift: boolean): Promise<void> {
    const key = ofSym(sym);
    if ("modifier" in key) {
      this.flags = down ? this.flags | key.flag : this.flags & ~key.flag;
      return this.keyCode(key.modifier, down);
    }
    if ("code" in key) {
      const before = this.flags;
      if (key.shift && shift) this.flags |= SHIFT;
      try {
        return this.keyCode(key.code, down);
      } finally {
        this.flags = before;
      }
    }
    if (key.text && down) this.keyText(key.text);
  }

  async chord(chord: string): Promise<void> {
    const syms = parseChord(chord);
    const shifted = syms.length === 1;
    for (const sym of syms) await this.keySym(sym, true, shifted);
    for (const sym of [...syms].reverse()) await this.keySym(sym, false, shifted);
    await this.sync();
  }

  async typeText(text: string): Promise<void> {
    let run = "";
    for (const c of text) {
      if (c === "\n" || c === "\r" || c === "\t") {
        if (run) this.keyText(run);
        run = "";
        this.tap(ofChar(c)![0], false);
      } else run += c;
    }
    if (run) this.keyText(run);
    await this.sync();
  }

  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  close(): void {
    this.capture.close();
  }
}
