// A screen's performance on the phone, as its card shows it (screens/PerfCard.tsx): what the phone measures of the
// frames as they come and draw, and what the screen's machine and the workspace measured (a frame's `perf`, once a
// second). Only what was measured. It counts only while the card is open. Whether it is open is this phone's own
// memory, one choice for every screen, kept in a small file in the app's documents.
import { File, Paths } from "expo-file-system";
import { useEffect, useState, useSyncExternalStore } from "react";
import { FrameCounts, type BrowserFrame, type PerfNow, type ViewerSecond } from "./desktop";

const file = (): File => new File(Paths.document, "screen-perf.json");
let open = false;
try {
  const f = file();
  if (f.exists) open = (JSON.parse(f.textSync()) as { open?: unknown }).open === true;
} catch {}
const listeners = new Set<() => void>();

export const setPerfOpen = (on: boolean): void => {
  open = on;
  for (const l of listeners) l();
  void file()
    .write(JSON.stringify({ open: on }))
    .catch(() => undefined);
};

export const usePerfOpen = (): boolean =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );

/** One screen's counts while its card is open: frames that came, and that drew (the desktop's FrameCounts). */
export class PerfMeter {
  private readonly counts = new FrameCounts();
  private picture: { width: number; height: number } | undefined;
  private lastArrival: number | undefined;
  private perf: { at: number; perf: NonNullable<BrowserFrame["perf"]> } | undefined;

  arrived(frame: BrowserFrame): void {
    const now = Date.now();
    this.lastArrival = now;
    this.counts.arrived(frame.seq, frame.link, Math.floor((frame.jpegB64 ?? "").length / 4) * 3, now, frame.perf);
    if (frame.perf !== undefined) this.perf = { at: now, perf: frame.perf };
  }

  drawn(frame: BrowserFrame): void {
    this.counts.drawn(frame.seq);
    this.picture = { width: frame.width, height: frame.height };
  }

  now(): PerfNow {
    const t = Date.now();
    const viewer: ViewerSecond = this.counts.second(t);
    return {
      viewer,
      history: this.counts.history,
      picture: this.picture,
      quietMs: this.lastArrival === undefined ? undefined : t - this.lastArrival,
      perf: this.perf?.perf,
      perfAgeMs: this.perf === undefined ? undefined : t - this.perf.at,
    };
  }
}

/** The screen's measures each second while `meter` is set (the card open). */
export function useScreenPerf(meter: PerfMeter | undefined): PerfNow | undefined {
  const [now, setNow] = useState<PerfNow | undefined>(undefined);
  useEffect(() => {
    if (meter === undefined) return undefined;
    const tick = setInterval(() => setNow(meter.now()), 1000);
    return () => {
      clearInterval(tick);
      setNow(undefined);
    };
  }, [meter]);
  return now;
}
