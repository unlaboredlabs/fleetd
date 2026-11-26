// What the performance panel says, from what was measured (perf.ts): a verdict in words first (is it smooth, and if
// not, what holds it back: the machine, the link or this computer), then the measures under quiet labels. Pure, so the
// words are tested without a screen.
import type { ScreenPerf, SessionKind } from "../../../shared/contracts";

/** Seconds the panel's graph keeps. */
export const HISTORY = 60;

/** One second's measures, as the panel reads them: all over the same frames, by their numbers (FrameCounts). */
export type ViewerSecond = {
  /** Whether the screen's machine sends its measures (a node from before them, or a link that drops them, doesn't):
   * without them nothing says what was made, and what came and was drawn is counted over the last WINDOW_MS. */
  measured: boolean;
  /** Frames the screen made (numbered), that reached this viewer, and that it drew, a second. Drawn ≤ came ≤ made. */
  made: number;
  arrived: number;
  drawn: number;
  /** What the frames that reached it carried, kbit/s. */
  kbps: number;
  /** This window's decoder, frame in to picture out, median ms; absent with no H.264 that second. */
  decodeMs?: number;
};

/** A second of the graph: frames shown, and made where the machine said. */
export type GraphSecond = { made?: number; shown: number };

export type PerfNow = {
  viewer: ViewerSecond;
  history: readonly GraphSecond[];
  picture: { width: number; height: number } | undefined;
  /** How long since a frame last came, ms. */
  quietMs: number | undefined;
  /** The machine's newest measures, and how old they are, ms. */
  perf: ScreenPerf | undefined;
  perfAgeMs: number | undefined;
};

/** The two measures a rate is over are at least this far apart where they can be: long enough that a frame either side
 * of an edge doesn't move it. */
export const WINDOW_MS = 2_000;

/**
 * A viewer's counts of one screen's frames. The screen's measures each say how many frames it has sent and the number
 * of the frame they were taken at (ScreenPerf `sent`, `seq`), so between two measures the frames made, came and drawn
 * are all counted over the same run of frame numbers and the same time: what was drawn is a subset of what came, which
 * is a subset of what was made, whatever edge a second falls on.
 */
export class FrameCounts {
  private stamps: { at: number; seq: number; sent: number }[] = [];
  private came: { at: number; seq: number; bytes: number }[] = [];
  private drew = new Set<number>();
  private link: number | undefined;
  history: GraphSecond[] = [];

  arrived(
    seq: number,
    link: number | undefined,
    bytes: number,
    now: number,
    stamp?: { sent: number; seq: number },
  ): void {
    if (link !== this.link) {
      this.stamps = [];
      this.came = [];
      this.drew.clear();
      this.link = link;
    }
    this.came.push({ at: now, seq, bytes });
    const last = this.stamps.at(-1);
    if (stamp !== undefined && (last === undefined || stamp.seq > last.seq))
      this.stamps.push({ at: now, seq: stamp.seq, sent: stamp.sent });
  }

  drawn(seq: number): void {
    this.drew.add(seq);
  }

  /** The rates now, and the second into the graph's history: none once no measure has come for STILL_MS. With no
   * measures from the screen's machine, what came and was drawn over the last WINDOW_MS, and nothing of what was made. */
  second(now: number): Omit<ViewerSecond, "decodeMs"> {
    if (this.stamps.length === 0) return this.unmeasured(now);
    const b = this.stamps.at(-1);
    let from = 0;
    if (b !== undefined)
      this.stamps.forEach((st, i) => {
        if (b.at - st.at >= WINDOW_MS) from = i;
      });
    this.stamps = this.stamps.slice(from);
    const a = this.stamps[0];
    let out = { measured: true, made: 0, arrived: 0, drawn: 0, kbps: 0 };
    if (a !== undefined && b !== undefined && b !== a && now - b.at < STILL_MS) {
      this.came = this.came.filter((c) => c.seq > a.seq);
      for (const q of this.drew) if (q <= a.seq) this.drew.delete(q);
      const per = 1000 / Math.max(1, b.at - a.at);
      const run = this.came.filter((c) => c.seq <= b.seq);
      let drawn = 0;
      for (const q of this.drew) if (q <= b.seq) drawn++;
      out = {
        measured: true,
        made: Math.round((b.sent - a.sent) * per),
        arrived: Math.round(run.length * per),
        drawn: Math.round(drawn * per),
        kbps: Math.round((run.reduce((n, c) => n + c.bytes, 0) * 8 * per) / 1000),
      };
    }
    this.history = [...this.history, { made: out.made, shown: out.drawn }].slice(-HISTORY);
    return out;
  }

  private unmeasured(now: number): Omit<ViewerSecond, "decodeMs"> {
    this.came = this.came.filter((c) => c.at > now - WINDOW_MS);
    const first = this.came[0];
    for (const q of this.drew) if (first === undefined || q < first.seq) this.drew.delete(q);
    let out = { measured: false, made: 0, arrived: 0, drawn: 0, kbps: 0 };
    if (first !== undefined) {
      const per = 1000 / Math.max(1, Math.min(WINDOW_MS, now - first.at));
      let drawn = 0;
      for (const c of this.came) if (this.drew.has(c.seq)) drawn++;
      out = {
        measured: false,
        made: 0,
        arrived: Math.round(this.came.length * per),
        drawn: Math.round(drawn * per),
        kbps: Math.round((this.came.reduce((n, c) => n + c.bytes, 0) * 8 * per) / 1000),
      };
    }
    this.history = [...this.history, { shown: out.drawn }].slice(-HISTORY);
    return out;
  }
}

/** The graph's box, in its own units: a second is 3 wide. */
export const GRAPH_W = HISTORY * 3;
export const GRAPH_H = 28;

/**
 * The graph over the last minute: the frames shown a second as a step line, the frames this viewer could have shown
 * (what was made, up to `cap` where it draws fewer) as a faint line, and the gap between them filled, so a dip reads at
 * a glance and a steady stream is two lines together near the top. `top` is the scale's top.
 */
export function graphOf(
  history: readonly GraphSecond[],
  cap?: number,
): {
  top: number;
  shown: string;
  target: string;
  gap: string;
  targetNow: number | undefined;
} {
  const at = HISTORY - history.length;
  const target = history.map((h) =>
    // Unmeasured, what was shown is all there is to show against.
    h.made === undefined ? h.shown : cap === undefined ? h.made : Math.min(h.made, cap),
  );
  const top = Math.max(10, ...target, ...history.map((h) => h.shown)) * 1.1;
  const y = (n: number) => (GRAPH_H - (n / top) * (GRAPH_H - 2)).toFixed(2);
  const line = (vals: readonly number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${String((at + i) * 3)} ${y(v)}H${String((at + i) * 3 + 3)}`).join("");
  const gap = history
    .map((h, i) => {
      const t = target[i] ?? 0;
      return h.shown < t
        ? `M${String((at + i) * 3)} ${y(t)}H${String((at + i) * 3 + 3)}V${y(h.shown)}H${String((at + i) * 3)}Z`
        : "";
    })
    .join("");
  return {
    top,
    shown: line(history.map((h) => h.shown)),
    target: line(target),
    gap,
    targetNow: target.at(-1),
  };
}

export type Tone = "success" | "warning" | "quiet";
export type Verdict = { word: string; line: string; tone: Tone };
export type Row = { label: string; value: string; note?: string; tone?: Tone };
export type Group = { label: string; rows: Row[] };

/** A screen with no frame for this long is still, not slow: nothing changed on it. */
export const STILL_MS = 2_000;
/** The machine's measures older than this are a still screen's: shown, but not judged on. */
export const STALE_MS = 3_000;

const perSecond = (n: number) => `${String(n)} a second`;
const ms = (n: number) => (n < 10 ? `${n.toFixed(1)} ms` : `${String(Math.round(n))} ms`);
const rate = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${String(kbps)} kbit/s`);
const secs = (msValue: number) => `${String(Math.round(msValue / 1000))} s`;

const ENCODER: Record<string, string> = {
  x264: "x264 on the CPU",
  hardware: "the Mac’s hardware",
  emulator: "Android’s own",
  h264: "H.264",
};

const encoderWords = (perf: ScreenPerf, kind: SessionKind | undefined): string =>
  perf.encoder === "jpeg"
    ? kind === undefined || kind === "browser"
      ? "Chrome’s JPEGs"
      : "JPEG"
    : (ENCODER[perf.encoder] ?? perf.encoder);

const CAP: Record<NonNullable<ScreenPerf["capBy"]>, string> = {
  busy: "held by the machine’s load",
  link: "held by what gets through",
  asked: "as this window draws",
};

/** A tenth of the frames this viewer could have shown, lost, is slow. */
export const LOST_SHARE = 0.1;

/**
 * The verdict: still, smooth, or slowed and by what. The machine first, where its load holds the frame rate; then lost
 * frames, a tenth or more of what this viewer could have shown (what was sent, up to `drawsAtMost`): on the way as far
 * as the sender skipped them, here as far as they reached it undrawn, whichever is more; then the way when it holds the
 * rate. A budget alone, with nothing lost, isn't slow.
 */
export function verdictOf(now: PerfNow | undefined, drawsAtMost?: number): Verdict {
  if (now === undefined)
    return {
      word: "Measuring",
      line: "The first second’s measures come next",
      tone: "quiet",
    };
  const { viewer, quietMs } = now;
  if (quietMs === undefined || quietMs >= STILL_MS)
    return {
      word: "Still",
      line: quietMs === undefined ? "No frame has come yet" : `Nothing changed on the screen for ${secs(quietMs)}`,
      tone: "quiet",
    };
  // Frames come, but nothing says what the screen made: its machine sends no measures. Only what was shown here.
  if (!viewer.measured)
    return {
      word: "Not measured",
      line: `Its machine doesn’t send measures: ${perSecond(viewer.drawn)} shown here`,
      tone: "quiet",
    };
  const perf = now.perfAgeMs !== undefined && now.perfAgeMs < STALE_MS ? now.perf : undefined;
  const link = perf?.link;
  if (perf?.capBy === "busy")
    return {
      word: "Slowed by the machine",
      line: `It’s busy${perf.cpuPct === undefined ? "" : ` (CPU ${String(perf.cpuPct)}%)`}: at most ${perSecond(perf.capFps ?? 0)}`,
      tone: "warning",
    };
  // Lost frames are the way's where its sender skipped them, and this viewer's where they reached it and it never drew
  // them. A viewer that draws at most so many reaches only those its sender paced to it; any other reaches every frame
  // sent that wasn't skipped.
  const could = drawsAtMost === undefined ? viewer.made : Math.min(viewer.made, drawsAtMost);
  const way = Math.min(link?.skipped ?? 0, viewer.made);
  const reached = drawsAtMost === undefined ? viewer.made - way : Math.min(viewer.arrived, drawsAtMost);
  const here = Math.max(0, reached - viewer.drawn);
  if (could >= 5 && way + here >= could * LOST_SHARE) {
    if (way >= here)
      return {
        word: "Slowed on the way",
        line: `${String(way)} of ${String(viewer.made)} frames a second skipped on the way${link?.budgetKbps === undefined ? "" : `: it gets ${rate(link.budgetKbps)} through`}`,
        tone: "warning",
      };
    return {
      word: "Slowed here",
      line: `This ${drawsAtMost === undefined ? "window" : "phone"} showed ${String(viewer.drawn)} of the ${String(reached)} frames that reached it`,
      tone: "warning",
    };
  }
  if (perf?.capBy === "link")
    return {
      word: "Slowed on the way",
      line: `Only ${perSecond(viewer.made)} get through${link?.budgetKbps === undefined ? "" : `, at ${rate(link.budgetKbps)}`}`,
      tone: "warning",
    };
  return {
    word: "Smooth",
    line: link === undefined ? perSecond(viewer.drawn) : `${perSecond(viewer.drawn)}, ${ms(link.rttMs)} round trip`,
    tone: "success",
  };
}

/** The measures, in groups: the stream, its delay, the machine. A measure not taken is left out, never guessed. */
export function groupsOf(
  now: PerfNow | undefined,
  at: {
    kind: SessionKind | undefined;
    screen: { width: number; height: number } | undefined;
    shownWidth: number | undefined;
    direct: boolean;
    machine: string | undefined;
    /** The most frames a second this viewer draws (the phone's), where it draws fewer than a screen may make. */
    drawsAtMost?: number;
  },
): Group[] {
  const perf = now?.perf;
  const viewer = now?.viewer;
  const stream: Row[] = [];
  if (viewer !== undefined)
    stream.push({
      label: "Shown",
      value: perSecond(viewer.drawn),
      ...(at.drawsAtMost === undefined ? {} : { note: `at most ${String(at.drawsAtMost)} here` }),
    });
  if (viewer?.measured === true) {
    const skipped = perf?.link?.skipped ?? 0;
    stream.push({
      label: "Sent",
      value: perSecond(viewer.made),
      ...(skipped > 0
        ? {
            note: `${String(skipped)} skipped on the way`,
            tone: "warning" as const,
          }
        : {}),
    });
  }
  if (perf !== undefined) {
    // Its most a second only where something holds it under what its encoder makes.
    if (perf.capBy === "busy" || (perf.capBy === "link" && perf.capFps !== undefined))
      stream.push({
        label: "At most",
        value: perSecond(perf.capFps ?? viewer?.made ?? 0),
        note: CAP[perf.capBy],
        tone: "warning",
      });
  }
  if (at.screen !== undefined) {
    const pic = now?.picture;
    const smaller = pic !== undefined && (pic.width !== at.screen.width || pic.height !== at.screen.height);
    stream.push({
      label: "Picture",
      value: `${String((smaller ? pic : at.screen).width)} × ${String((smaller ? pic : at.screen).height)}`,
      ...(smaller
        ? {
            note: `of ${String(at.screen.width)} × ${String(at.screen.height)}`,
          }
        : {}),
    });
    if (at.shownWidth !== undefined && at.shownWidth > 0) {
      const pct = Math.round((at.shownWidth / (smaller ? pic : at.screen).width) * 100);
      stream.push({
        label: "Scaled",
        value: `${String(pct)}%`,
        note: pct < 100 ? "to fit here" : pct > 100 ? "up to fit here" : "pixel for pixel",
      });
    }
  }
  if (viewer !== undefined) stream.push({ label: "Data", value: rate(viewer.kbps) });
  stream.push({
    label: "Path",
    value: at.direct ? "Straight to the machine" : "Through the workspace",
  });

  const delay: Row[] = [];
  const link = perf?.link;
  if (link !== undefined) {
    delay.push({
      label: "Round trip",
      value: ms(link.rttMs),
      note: at.direct ? "to the machine" : "to the workspace",
    });
    if (link.queueMs > 0)
      delay.push({
        label: "Queued",
        value: ms(link.queueMs),
        tone: link.queueMs >= 100 ? "warning" : "quiet",
      });
    if (link.budgetKbps !== undefined)
      delay.push({
        label: "Gets through",
        value: rate(link.budgetKbps),
        note: "the sender’s budget",
      });
  }
  if (perf !== undefined)
    delay.push({
      label: "Encoder",
      value: perf.encodeMs === undefined ? encoderWords(perf, at.kind) : ms(perf.encodeMs),
      ...(perf.encodeMs === undefined ? {} : { note: encoderWords(perf, at.kind) }),
    });
  if (viewer?.decodeMs !== undefined) delay.push({ label: "Decode", value: ms(viewer.decodeMs), note: "here" });

  const machine: Row[] = [];
  if (perf?.cpuPct !== undefined)
    machine.push({
      label: "CPU",
      value: `${String(perf.cpuPct)}%`,
      ...(perf.cores === undefined ? {} : { note: `of ${String(perf.cores)} cores` }),
      ...(perf.cpuPct >= 90 ? { tone: "warning" as const } : {}),
    });
  if (perf?.memPct !== undefined)
    machine.push({
      label: "Memory",
      value: `${String(perf.memPct)}%`,
      ...(perf.memPct >= 90 ? { tone: "warning" as const } : {}),
    });

  return [
    { label: "Stream", rows: stream },
    { label: "Delay", rows: delay },
    { label: at.machine ?? "Machine", rows: machine },
  ].filter((g) => g.rows.length > 0);
}
