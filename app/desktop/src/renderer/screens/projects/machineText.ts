// How a machine reads on the Machines screen, as the GPUI strip said it (live/strips.rs, model.rs SleptSpan):
// only what it reports, a sleep for an hour after it woke, an offline machine with how long.

import { SLEPT_SHOWN_MS } from "../../../shared/contracts";
import type { LoginLimit, Machine, MachineLive, SleptSpan, SlotState } from "./contracts";

export type Tone = "quiet" | "warning" | "danger";
export interface Part {
  readonly text: string;
  readonly tone: Tone;
}

/** "46s", "10m46s", "2h05m". */
export const durationText = (ms: number): string => {
  const s = Math.floor(Math.max(ms, 0) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
};

/** "slept 10m46s", while the wake is under an hour old. */
export const sleptText = (span: SleptSpan | undefined, nowMs: number): string | null =>
  span !== undefined && nowMs - span.toMs < SLEPT_SHOWN_MS ? `slept ${durationText(span.toMs - span.fromMs)}` : null;

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export const agoText = (ms: number): string => {
  const m = Math.floor(Math.max(ms, 0) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  const d = Math.floor(m / 1440);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};

const WINDOWS: Readonly<Record<string, string>> = { five_hour: "5h", seven_day: "wk", seven_day_opus: "opus wk", seven_day_sonnet: "sonnet wk" };

export const limitPart = (l: LoginLimit): Part | null => {
  if (l.utilization === undefined) return null;
  const tone: Tone = l.status === "rejected" ? "danger" : l.status === "allowed_warning" ? "warning" : "quiet";
  return { text: `${Math.round(l.utilization * 100)}% ${WINDOWS[l.limitType] ?? l.limitType}`, tone };
};

const worst = (tones: ReadonlyArray<Tone>): Tone => (tones.includes("danger") ? "danger" : tones.includes("warning") ? "warning" : "quiet");

/**
 * A machine's line: "offline, last seen 12 min ago", or "3 running", "slept 10m46s", "load 3.1/32", "mem 41%",
 * "claude 58% 5h · 41% wk". The snapshot's machine says status and last seen; its live entry says load and usage.
 */
export const machineParts = (m: Machine, live: MachineLive | undefined, nowMs: number): ReadonlyArray<Part> => {
  if (m.status === "offline") {
    const seen = Date.parse(m.lastSeenAt);
    return [{ text: Number.isNaN(seen) ? "offline" : `offline, last seen ${agoText(nowMs - seen)}`, tone: "warning" }];
  }
  const out: Array<Part> = [];
  if (m.status === "degraded") out.push({ text: "degraded", tone: "warning" });
  if (live) out.push({ text: `${live.running} running`, tone: "quiet" });
  const slept = sleptText(live?.slept ?? m.lastSlept, nowMs);
  if (slept) out.push({ text: slept, tone: "warning" });
  const load = live?.load;
  if (load) {
    out.push({ text: `load ${load.load1.toFixed(1)}/${load.cpus}`, tone: "quiet" });
    if (load.memUsedPct !== undefined) out.push({ text: `mem ${load.memUsedPct}%`, tone: "quiet" });
    const limits = (load.limits ?? []).map(limitPart).filter((p): p is Part => p !== null);
    if (limits.length > 0) out.push({ text: `claude ${limits.map((p) => p.text).join(" · ")}`, tone: worst(limits.map((p) => p.tone)) });
  }
  return out;
};

/** "agents 8 / 40 · 1 queued", the words the chat header's Max agents control uses. */
export const slotsText = (s: SlotState): string => `agents ${s.used} / ${s.cap}${s.queued > 0 ? ` · ${s.queued} queued` : ""}`;

/** Offline last, then by name. */
export const machineOrder = (a: Machine, b: Machine): number =>
  Number(a.status === "offline") - Number(b.status === "offline") || a.name.localeCompare(b.name);
