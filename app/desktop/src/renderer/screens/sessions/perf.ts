// A live screen's performance, as its panel shows it (PerfPanel.tsx): what this window measures of the frames as they
// come and are drawn, and what the screen's machine and the frames' sender measured (a frame's `perf`, once a second:
// contracts' ScreenPerf). Only what was measured; nothing is estimated. It counts only while the panel is open: closed,
// a frame costs one map lookup.
//
// Whether the panel is open is this app's own memory, one choice for every screen, kept across launches.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { BrowserFrame, ScreenPerf } from "../../../shared/contracts";
import { useDataLayer } from "../../src/data/react";
import { FrameCounts, type PerfNow, type ViewerSecond } from "./perfModel";

const KEY = "fleetd.screenPerf";
const listeners = new Set<() => void>();
let open: boolean | undefined;

const readOpen = (): boolean => {
  try {
    return window.localStorage.getItem(KEY) === "open";
  } catch {
    return false;
  }
};

export const perfOpen = (): boolean => (open ??= readOpen());

export const setPerfOpen = (on: boolean): void => {
  open = on;
  try {
    window.localStorage.setItem(KEY, on ? "open" : "closed");
  } catch {
    // No storage: the choice holds until the window closes.
  }
  for (const l of listeners) l();
};

/** Whether the performance panel is open, and its toggle. */
export function usePerfOpen(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    perfOpen,
    () => false,
  );
  return [on, setPerfOpen];
}

class Meter {
  readonly counts = new FrameCounts();
  private decodes: number[] = [];
  private decoding = new Map<number, number>();
  /** The size of the picture last drawn (it may be smaller than the screen). */
  picture: { width: number; height: number } | undefined;
  lastArrival: number | undefined;
  perf: { at: number; perf: ScreenPerf } | undefined;

  arrived(frame: BrowserFrame, now: number): void {
    this.lastArrival = now;
    this.counts.arrived(
      frame.seq,
      frame.link,
      Math.floor((frame.jpegB64 ?? frame.h264B64 ?? "").length / 4) * 3,
      now,
      frame.perf,
    );
    if (frame.perf !== undefined) this.perf = { at: now, perf: frame.perf };
  }

  drawn(seq: number, width: number, height: number): void {
    this.counts.drawn(seq);
    this.picture = { width, height };
  }

  decodeIn(seq: number, now: number): void {
    if (this.decoding.size > 120) this.decoding.clear();
    this.decoding.set(seq, now);
  }

  decodeOut(seq: number, now: number): void {
    const at = this.decoding.get(seq);
    if (at === undefined) return;
    this.decoding.delete(seq);
    this.decodes.push(now - at);
  }

  second(now: number): ViewerSecond {
    const sorted = [...this.decodes].sort((a, b) => a - b);
    this.decodes = [];
    return {
      ...this.counts.second(now),
      ...(sorted.length === 0
        ? {}
        : { decodeMs: sorted[Math.floor(sorted.length / 2)] ?? 0 }),
    };
  }
}

const meters = new Map<string, Meter>();

/** Frame `seq` of `sessionId`'s drawn here, its picture of its size. */
export const perfDrawn = (
  sessionId: string,
  seq: number,
  width: number,
  height: number,
): void => meters.get(sessionId)?.drawn(seq, width, height);
/** An H.264 frame of `sessionId`'s into this window's decoder, and its picture out. */
export const perfDecodeIn = (sessionId: string, seq: number): void =>
  meters.get(sessionId)?.decodeIn(seq, performance.now());
export const perfDecodeOut = (sessionId: string, seq: number): void =>
  meters.get(sessionId)?.decodeOut(seq, performance.now());

/** The screen's measures each second while `on`; undefined until the first second has gone. */
export function useScreenPerf(
  sessionId: string,
  on: boolean,
): PerfNow | undefined {
  const layer = useDataLayer();
  const [now, setNow] = useState<PerfNow | undefined>(undefined);
  useEffect(() => {
    if (!on) return undefined;
    const meter = new Meter();
    meters.set(sessionId, meter);
    const unsubscribe = layer.store.subscribe((s, prev) => {
      const f = s.browserFrame;
      if (
        f !== undefined &&
        f !== prev.browserFrame &&
        f.sessionId === sessionId
      )
        meter.arrived(f, performance.now());
    });
    const tick = window.setInterval(() => {
      const t = performance.now();
      const viewer = meter.second(t);
      setNow({
        viewer,
        history: meter.counts.history,
        picture: meter.picture,
        quietMs:
          meter.lastArrival === undefined ? undefined : t - meter.lastArrival,
        perf: meter.perf?.perf,
        perfAgeMs: meter.perf === undefined ? undefined : t - meter.perf.at,
      });
    }, 1000);
    return () => {
      unsubscribe();
      window.clearInterval(tick);
      if (meters.get(sessionId) === meter) meters.delete(sessionId);
      setNow(undefined);
    };
  }, [layer, sessionId, on]);
  return now;
}
