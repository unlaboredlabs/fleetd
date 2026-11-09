// The two privacy grants the agents' Mac needs, read exactly and never prompting (crates/fleetd/src/node/agents_mac/
// tcc.rs): Accessibility (`AXIsProcessTrusted`) and Screen Recording (`CGPreflightScreenCaptureAccess`). macOS grants
// them to the node, the process launchd started, and its children share them. `ask` puts fleetd in a grant's list of
// System Settings, where the person turns it on.
//
// The frameworks are opened with bun:ffi on macOS only; elsewhere macOS can't be asked and every read is undefined.
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import type { MacCheckId } from "./common.ts";

type Api = {
  axTrusted: () => number;
  axTrustedWith: (options: number) => number;
  preflight: () => boolean;
  request: () => boolean;
  dictCreate: (alloc: number | null, keys: number, values: number, n: number, kcb: number, vcb: number) => number;
  cfRelease: (p: number) => void;
  /** A framework global's address. */
  global: (lib: "ax" | "cf", name: string) => number;
};

const cstr = (s: string) => ptr(Buffer.from(`${s}\0`));

let api: Api | null | undefined;
function open(): Api | null {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== "darwin") return api;
  try {
    const AX = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
    const CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
    const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
    const ax = dlopen(AX, {
      AXIsProcessTrusted: { returns: FFIType.u8 },
      AXIsProcessTrustedWithOptions: { args: [FFIType.ptr], returns: FFIType.u8 },
    });
    const cg = dlopen(CG, {
      CGPreflightScreenCaptureAccess: { returns: FFIType.bool },
      CGRequestScreenCaptureAccess: { returns: FFIType.bool },
    });
    const cf = dlopen(CF, {
      CFDictionaryCreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    });
    // Data symbols (a CFStringRef global, the callbacks' structs) through libSystem's own dlopen and dlsym.
    const sys = dlopen("/usr/lib/libSystem.B.dylib", {
      dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
      dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    });
    const RTLD_LAZY = 1;
    const handles = { ax: sys.symbols.dlopen(cstr(AX), RTLD_LAZY), cf: sys.symbols.dlopen(cstr(CF), RTLD_LAZY) };
    api = {
      axTrusted: () => ax.symbols.AXIsProcessTrusted(),
      axTrustedWith: (o) => ax.symbols.AXIsProcessTrustedWithOptions(o as never),
      preflight: () => cg.symbols.CGPreflightScreenCaptureAccess(),
      request: () => cg.symbols.CGRequestScreenCaptureAccess(),
      dictCreate: (a, k, v, n, kcb, vcb) => Number(cf.symbols.CFDictionaryCreate(a as never, k as never, v as never, n, kcb as never, vcb as never)),
      cfRelease: (p) => cf.symbols.CFRelease(p as never),
      global: (lib, name) => Number(sys.symbols.dlsym(handles[lib], cstr(name)) ?? 0),
    };
  } catch {
    api = null;
  }
  return api;
}

export const tcc = {
  accessibility(): boolean | undefined {
    const a = open();
    return a ? a.axTrusted() !== 0 : undefined;
  },
  screenRecording(): boolean | undefined {
    const a = open();
    return a ? a.preflight() : undefined;
  },
  /** Asks macOS for one grant the node lacks: that adds fleetd to its System Settings list (switched off) and shows
   * macOS's own prompt at the Mac. Only the node asks. */
  ask(id: MacCheckId): void {
    const a = open();
    if (!a) return;
    if (id === "accessibility" && this.accessibility() === false) {
      const key = a.global("ax", "kAXTrustedCheckOptionPrompt");
      const yes = a.global("cf", "kCFBooleanTrue");
      const kcb = a.global("cf", "kCFTypeDictionaryKeyCallBacks");
      const vcb = a.global("cf", "kCFTypeDictionaryValueCallBacks");
      if (!key || !yes || !kcb || !vcb) return;
      const keys = new BigUint64Array([BigInt(read.ptr(key as never))]);
      const values = new BigUint64Array([BigInt(read.ptr(yes as never))]);
      const options = a.dictCreate(null, ptr(keys), ptr(values), 1, kcb, vcb);
      if (options) {
        a.axTrustedWith(options);
        a.cfRelease(options);
      }
    } else if (id === "screen_recording" && this.screenRecording() === false) {
      a.request();
    }
  },
};
