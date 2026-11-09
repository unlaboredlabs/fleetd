// The Mac's screen through ScreenCaptureKit (crates/fleetd/src/node/desktop/mac/capture.rs): one SCScreenshotManager
// capture of the main display per frame, at the display's size in points, so a frame's pixels are the coordinates
// CGEvent takes, with the pointer drawn. The content filter and the configuration are kept between frames and made
// again when the display's size changes or a capture fails.
//
// Objective-C goes through objc_msgSend, given each call's own signature with CFunction. ScreenCaptureKit answers
// through completion blocks, which only native code can be: completion.c's slot is one, compiled at the first capture
// by bun:ffi's `cc`. A capture starts at once and the node polls its slot every few milliseconds, never holding its
// event loop for the capture itself.
import { CFunction, CString, cc, dlopen, FFIType, type Pointer, toArrayBuffer } from "bun:ffi";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Raw } from "../screen.ts";
import completionSource from "./completion.c" with { type: "file" };

/** How long one capture may take before the node gives up on it. */
const CAPTURE_WAIT_MS = 5_000;
/** How often a capture's slot is looked at. */
const POLL_MS = 2;
/** kCVPixelFormatType_32BGRA. */
const BGRA = 0x42475241;
/** CGBitmapInfo's byte order mask, and its 32-bit little-endian order (BGRA in memory with alpha first). */
const BYTE_ORDER_MASK = 0x7000;
const BYTE_ORDER_32_LITTLE = 2 << 12;
const RTLD_LAZY = 1;
const RTLD_GLOBAL = 8;

/** A native address, as bun:ffi gives one. */
type Ptr = Pointer | bigint;


function load() {
  const system = dlopen("/usr/lib/libSystem.B.dylib", {
    dlopen: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.ptr },
    dlsym: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
  }).symbols;
  const c = (s: string) => Buffer.from(`${s}\0`);
  const open = (path: string) => {
    const lib = system.dlopen(c(path), RTLD_LAZY | RTLD_GLOBAL);
    if (!lib) throw new Error(`cannot open ${path}`);
    return lib;
  };
  // Loaded for its classes, which the runtime finds by name from then on.
  open("/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit");
  const objc = dlopen("/usr/lib/libobjc.A.dylib", {
    objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
    sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
    objc_retain: { args: [FFIType.ptr], returns: FFIType.ptr },
    objc_release: { args: [FFIType.ptr], returns: FFIType.void },
    objc_autoreleasePoolPush: { returns: FFIType.ptr },
    objc_autoreleasePoolPop: { args: [FFIType.ptr], returns: FFIType.void },
  }).symbols;
  const msgSend = system.dlsym(open("/usr/lib/libobjc.A.dylib"), c("objc_msgSend"));
  if (!msgSend) throw new Error("macOS has no objc_msgSend");
  const send = (args: FFIType[]) => CFunction({ ptr: msgSend, args: [FFIType.ptr, FFIType.ptr, ...args], returns: FFIType.ptr });
  const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    CFDataGetLength: { args: [FFIType.ptr], returns: FFIType.i64 },
    CFDataGetBytePtr: { args: [FFIType.ptr], returns: FFIType.ptr },
  }).symbols;
  const cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
    CGMainDisplayID: { returns: FFIType.u32 },
    CGImageGetWidth: { args: [FFIType.ptr], returns: FFIType.u64 },
    CGImageGetHeight: { args: [FFIType.ptr], returns: FFIType.u64 },
    CGImageGetBytesPerRow: { args: [FFIType.ptr], returns: FFIType.u64 },
    CGImageGetBitsPerPixel: { args: [FFIType.ptr], returns: FFIType.u64 },
    CGImageGetBitmapInfo: { args: [FFIType.ptr], returns: FFIType.u32 },
    CGImageGetDataProvider: { args: [FFIType.ptr], returns: FFIType.ptr },
    CGDataProviderCopyData: { args: [FFIType.ptr], returns: FFIType.ptr },
  }).symbols;
  // TinyCC reads its source from disk, and a compiled fleetd keeps it in its own embedded files: it is copied out.
  const dir = mkdtempSync(join(tmpdir(), "fleetd-capture-"));
  let slot;
  try {
    const source = join(dir, "completion.c");
    writeFileSync(source, readFileSync(completionSource));
    slot = cc({
      source,
      symbols: {
        slot_new: { returns: FFIType.ptr },
        slot_answered: { args: [FFIType.ptr], returns: FFIType.i32 },
        slot_object: { args: [FFIType.ptr], returns: FFIType.ptr },
        slot_error: { args: [FFIType.ptr], returns: FFIType.ptr },
        slot_free: { args: [FFIType.ptr], returns: FFIType.void },
      },
    }).symbols;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    objc,
    cf,
    cg,
    slot,
    send0: send([]),
    send1: send([FFIType.u64]),
    send2: send([FFIType.u64, FFIType.u64]),
    send3: send([FFIType.u64, FFIType.u64, FFIType.u64]),
    /** `[x sel:BOOL sel:BOOL completionHandler:]`: the two BOOLs as the bytes they are. */
    sendBoolsBlock: send([FFIType.bool, FFIType.bool, FFIType.ptr]),
    /** `[x sel:object sel:object completionHandler:]`. */
    sendObjsBlock: send([FFIType.ptr, FFIType.ptr, FFIType.ptr]),
    sels: new Map<string, Ptr>(),
  };
}

type Api = ReturnType<typeof load>;
let api: Api | undefined;

function theApi(): Api {
  if (process.platform !== "darwin") throw new Error("the Mac screen is a Mac's own");
  try {
    api ??= load();
  } catch (e) {
    throw new Error(`this Mac lacks what its screen capture needs: ${(e as Error).message}`);
  }
  return api;
}

const cstr = (s: string) => Buffer.from(`${s}\0`);
const addr = (p: Ptr | null) => (p === null ? 0 : Number(p));

function sel(a: Api, name: string): Ptr {
  let s = a.sels.get(name);
  if (!s) {
    s = a.objc.sel_registerName(cstr(name))!;
    a.sels.set(name, s);
  }
  return s;
}

function cls(a: Api, name: string): Ptr {
  const c = a.objc.objc_getClass(cstr(name));
  if (!c) throw new Error(`macOS has no ${name} (ScreenCaptureKit's screenshots need macOS 14 or later)`);
  return c;
}

const send = (a: Api, receiver: Ptr, name: string, ...args: number[]): Ptr | null => {
  const s = sel(a, name);
  if (args.length === 0) return a.send0(receiver, s) as Ptr | null;
  if (args.length === 1) return a.send1(receiver, s, args[0]) as Ptr | null;
  if (args.length === 2) return a.send2(receiver, s, args[0], args[1]) as Ptr | null;
  return a.send3(receiver, s, args[0], args[1], args[2]) as Ptr | null;
};

/** An NSError's localizedDescription and code. */
function errorText(a: Api, error: Ptr | null): string {
  if (!error) return "no error given";
  const text = send(a, error, "localizedDescription");
  const code = BigInt.asIntN(64, BigInt(addr(send(a, error, "code"))));
  const utf8 = text ? send(a, text, "UTF8String") : null;
  const said = utf8 ? new CString(utf8 as Pointer).toString() : "";
  return `${said} (code ${code})`;
}

/** Runs `f` inside an autorelease pool, so what its calls autorelease goes when it ends. */
function pooled<T>(a: Api, f: () => T): T {
  const pool = a.objc.objc_autoreleasePoolPush();
  try {
    return f();
  } finally {
    a.objc.objc_autoreleasePoolPop(pool);
  }
}

/** Starts a call with a completion slot, and waits for what the block is given: the object retained (the caller's to
 * release), or the error's text. */
async function completion(a: Api, start: (block: Ptr) => void): Promise<{ object: Ptr } | { error: string }> {
  const slot = a.slot.slot_new();
  if (!slot) return { error: "the completion block could not be made" };
  pooled(a, () => start(slot));
  const until = performance.now() + CAPTURE_WAIT_MS;
  while (!a.slot.slot_answered(slot)) {
    // An answer that never comes keeps its slot: a few bytes, against a crash if it came late.
    if (performance.now() > until) return { error: "ScreenCaptureKit did not answer in 5 s" };
    await Bun.sleep(POLL_MS);
  }
  const object = a.slot.slot_object(slot);
  const error = a.slot.slot_error(slot);
  a.slot.slot_free(slot);
  if (object) {
    if (error) a.cf.CFRelease(error);
    return { object };
  }
  const text = pooled(a, () => errorText(a, error));
  if (error) a.cf.CFRelease(error);
  return { error: text };
}

/** What a capture is made with, kept between frames. */
type Made = { filter: Ptr; config: Ptr; width: number; height: number };

export class Capture {
  private made: Made | undefined;

  /** The filter on the main display, and a configuration of its size in BGRA with the pointer drawn. */
  private async make(a: Api, width: number, height: number): Promise<Made> {
    const shareable = cls(a, "SCShareableContent");
    const content = await completion(a, (block) =>
      a.sendBoolsBlock(shareable, sel(a, "getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:"), false, true, block),
    );
    if ("error" in content) throw new Error(`macOS refused to list the screen's content: ${content.error}`);
    return pooled(a, () => {
      const main = a.cg.CGMainDisplayID();
      let display: Ptr | null = null;
      try {
        const displays = send(a, content.object, "displays")!;
        const count = addr(send(a, displays, "count"));
        for (let i = 0; i < count && !display; i++) {
          const d = send(a, displays, "objectAtIndex:", i)!;
          if ((addr(send(a, d, "displayID")) >>> 0) === main) display = d;
        }
        if (!display && count > 0) display = send(a, displays, "objectAtIndex:", 0);
        if (!display) throw new Error("macOS lists no display to capture");
        display = a.objc.objc_retain(display);
      } finally {
        a.cf.CFRelease(content.object);
      }
      const empty = send(a, cls(a, "NSArray"), "array")!;
      const alloc = send(a, cls(a, "SCContentFilter"), "alloc")!;
      const filter = send(a, alloc, "initWithDisplay:excludingWindows:", addr(display), addr(empty));
      a.objc.objc_release(display!);
      if (!filter) throw new Error("ScreenCaptureKit made no content filter for the display");
      const config = send(a, send(a, cls(a, "SCStreamConfiguration"), "alloc")!, "init")!;
      send(a, config, "setWidth:", width);
      send(a, config, "setHeight:", height);
      send(a, config, "setPixelFormat:", BGRA);
      send(a, config, "setShowsCursor:", 1);
      return { filter, config, width, height };
    });
  }

  private drop(a: Api): void {
    if (!this.made) return;
    a.objc.objc_release(this.made.filter);
    a.objc.objc_release(this.made.config);
    this.made = undefined;
  }

  /** One frame of the main display at `size` (its points). */
  async grab([width, height]: [number, number]): Promise<Raw> {
    const a = theApi();
    if (this.made && (this.made.width !== width || this.made.height !== height)) this.drop(a);
    this.made ??= await this.make(a, width, height);
    const m = this.made;
    const manager = cls(a, "SCScreenshotManager");
    const captured = await completion(a, (block) =>
      a.sendObjsBlock(manager, sel(a, "captureImageWithFilter:configuration:completionHandler:"), m.filter, m.config, block),
    );
    if ("error" in captured) {
      // Made again for the next frame: the display may have gone or changed.
      if (this.made === m) this.drop(a);
      throw new Error(`the screen was not captured: ${captured.error}`);
    }
    try {
      return pixels(a, captured.object);
    } finally {
      a.cf.CFRelease(captured.object);
    }
  }

  close(): void {
    if (api) this.drop(api);
  }
}

/** A CGImage's pixels as packed BGRA rows. */
function pixels(a: Api, image: Ptr): Raw {
  const width = Number(a.cg.CGImageGetWidth(image));
  const height = Number(a.cg.CGImageGetHeight(image));
  const stride = Number(a.cg.CGImageGetBytesPerRow(image));
  if (Number(a.cg.CGImageGetBitsPerPixel(image)) !== 32 || stride < width * 4) throw new Error("the captured screen isn't 32-bit color");
  const little = (a.cg.CGImageGetBitmapInfo(image) & BYTE_ORDER_MASK) === BYTE_ORDER_32_LITTLE;
  const data = a.cg.CGDataProviderCopyData(a.cg.CGImageGetDataProvider(image));
  if (!data) throw new Error("the captured screen has no pixels");
  try {
    const len = Number(a.cf.CFDataGetLength(data));
    if (len < stride * (height - 1) + width * 4) throw new Error("the captured screen came short");
    const bytes = new Uint8Array(toArrayBuffer(a.cf.CFDataGetBytePtr(data)!, 0, len));
    return { data: packed(bytes, width, height, stride, little), width, height };
  } finally {
    a.cf.CFRelease(data);
  }
}

/** Rows of `stride` bytes as packed BGRA: as they are when `little`, else ARGB in memory, each pixel's bytes reversed. */
export function packed(bytes: Uint8Array, width: number, height: number, stride: number, little: boolean): Uint8Array {
  const row = width * 4;
  const out = new Uint8Array(row * height);
  if (little && stride === row) {
    out.set(bytes.subarray(0, row * height));
    return out;
  }
  for (let y = 0; y < height; y++) {
    const from = bytes.subarray(y * stride, y * stride + row);
    if (little) out.set(from, y * row);
    else
      for (let x = 0; x < row; x += 4) {
        const at = y * row + x;
        out[at] = from[x + 3]!;
        out[at + 1] = from[x + 2]!;
        out[at + 2] = from[x + 1]!;
        out[at + 3] = from[x]!;
      }
  }
  return out;
}
