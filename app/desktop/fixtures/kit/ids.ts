// Deterministic ids, so a rebuilt fixture is byte-identical and a screenshot diff means a UI change. Each is shaped
// like the real thing (the QA raw-text check must find a leaked one), derived from a seed string.
import { createHash } from "node:crypto";

const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");

/** A v4-shaped UUID, as the hub's project, thread and turn ids are. */
export const uuid = (seed: string): string => {
  const h = hex(`uuid:${seed}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16] ?? "0", 16) % 4] ?? "8"}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** A 40-hex git sha. */
export const sha = (seed: string): string => hex(`sha:${seed}`).slice(0, 40);

/** An ISO timestamp `ms` milliseconds after `from`. */
export const at = (from: string, ms: number): string => new Date(Date.parse(from) + ms).toISOString();

/** A stable pseudo-random number in [0, 1) for `seed`, for spreads that must not change between builds. */
export const rand = (seed: string): number => parseInt(hex(`rand:${seed}`).slice(0, 8), 16) / 0x1_0000_0000;
