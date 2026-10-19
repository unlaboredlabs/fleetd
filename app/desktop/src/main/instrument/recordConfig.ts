// FLEETD_RECORD=<dir>[,fps], parsed exactly as the GPUI app parsed it (app/fleetd-app/src/record.rs), so the lab
// driver and scripts/demo-mac.sh drive either app the same way.
import type { Lights } from "../../shared/recorder";

const DEFAULT_FPS = 30;

export interface RecordConfig {
  readonly dir: string;
  readonly fps: number;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** `<dir>` or `<dir>,<fps>` (fps 1-120). */
export const parseRecord = (value: string): Parsed<RecordConfig> => {
  const comma = value.lastIndexOf(",");
  const dir = (comma === -1 ? value : value.slice(0, comma)).trim();
  const rate = comma === -1 ? String(DEFAULT_FPS) : value.slice(comma + 1).trim();
  if (!/^\d+$/u.test(rate)) return { ok: false, error: `FLEETD_RECORD=${JSON.stringify(value)}: ${JSON.stringify(rate)} is not a frame rate` };
  const fps = Number(rate);
  if (fps < 1 || fps > 120) return { ok: false, error: `FLEETD_RECORD=${JSON.stringify(value)}: the frame rate must be 1-120` };
  if (dir === "") return { ok: false, error: `FLEETD_RECORD=${JSON.stringify(value)}: no directory` };
  return { ok: true, value: { dir, fps } };
};

/**
 * The capture's bitrate: about 0.08 bits per pixel per frame, as the GPUI recorder used, so text stays crisp (a
 * Retina window at 30 fps gets ~12 Mbit/s) and a 15-minute master stays near 1.5 GB.
 */
export const bitrateFor = (width: number, height: number, fps: number): number =>
  Math.min(24_000_000, Math.max(4_000_000, Math.round((width * height * fps) / 12)));

/** The delay after typing `ch`, the `index`th character: about 50 ms a key, uneven, with a beat after a word or a sentence. */
export const keyDelayMs = (index: number, ch: string): number =>
  30 + ((index * 7919) % 40) + (ch === " " ? 40 : ch === "." || ch === "," ? 180 : 0);

/**
 * The window server draws the traffic lights, so a capture of the page lacks them; the recorder draws them back at
 * the window's own button position (Electron's trafficLightPosition: the close button's top-left; buttons sit in a
 * 16 pt tall frame). macOS 26 made them 14 pt, 23 pt apart, from 12 pt and 20 pt.
 */
export const trafficLights = (position: { readonly x: number; readonly y: number }, macosMajor: number, dark: boolean): Lights => {
  const big = macosMajor >= 26;
  const [diameter, pitch] = big ? [14, 23] : [12, 20];
  const frame = diameter + 2;
  return {
    centers: [0, 1, 2].map((i) => [position.x + frame / 2 + i * pitch, position.y + 8] as const),
    radius: diameter / 2,
    active: [
      ["#ff5f57", "#e0443e"],
      ["#febc2e", "#dea123"],
      ["#28c840", "#1aab29"],
    ],
    inactive: dark ? ["#4a4a4c", "#3e3e40"] : ["#dcdcdc", "#c8c8c8"],
  };
};
