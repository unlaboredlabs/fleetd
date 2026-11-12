// A PR's build on a screen's device, without the disk or GitHub (builds.ts finds and fetches it): the file and piece
// limits, which artifact names a kind's build, and a device step sealed under the screen's relay key and opened.
import type { SessionKind } from "../../shared/contracts.ts";
import { secretbox, secretboxOpen } from "../../shared/sealed_box_core.ts";

/** The most a screen takes of a file (node/device/remote.rs `FILE_MAX`). */
export const FILE_MAX = 64 << 20;
/** A device step's piece (remote.rs `PIECE`). */
export const PIECE = 4 << 20;

export type Found = { runId: number; artifact: string; sha: string };
export type Build = { name: string; bytes: Uint8Array };

export const noun = (kind: SessionKind) => (kind === "ios" ? "iOS simulator build" : "Android build");

export function namedFor(name: string, kind: SessionKind): boolean {
  const n = name.toLowerCase();
  if (kind === "ios") return n.includes("ios");
  if (kind === "android") return n.includes("android") || n.includes("apk");
  return false;
}

// ---- the hub's own sealed device steps (remote.rs) ----

export type Way = "call" | "answer";

export function wayKey(relayKey: Uint8Array, way: Way): Uint8Array {
  const label = way === "call" ? "fleetd device 1: agent to runner" : "fleetd device 1: runner to agent";
  return new Uint8Array(new Bun.CryptoHasher("sha256").update(label).update(relayKey).digest());
}

export function nonce(count: number): Uint8Array {
  const out = new Uint8Array(24);
  new DataView(out.buffer).setBigUint64(0, BigInt(count), true);
  return out;
}

/** A device step, sealed with the screen's relay key under its count: `{ step: "sealed", count, dataB64 }`. */
export function sealCall(relayKey: Uint8Array, count: number, call: Record<string, unknown>): Record<string, unknown> {
  const sealed = secretbox(wayKey(relayKey, "call"), nonce(count), new TextEncoder().encode(JSON.stringify(call)));
  return { step: "sealed", count, dataB64: Buffer.from(sealed).toString("base64") };
}

/** The screen's machine's answer to step `count`, opened; undefined for one that doesn't open with the key. */
export function openDone(relayKey: Uint8Array, count: number, done: Record<string, unknown>): Record<string, unknown> | undefined {
  if (done.step !== "sealed" || typeof done.dataB64 !== "string") return undefined;
  const plain = secretboxOpen(wayKey(relayKey, "answer"), nonce(count), Buffer.from(done.dataB64, "base64"));
  if (!plain) return undefined;
  try {
    const opened = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
    return opened.step === "sealed" ? undefined : opened;
  } catch {
    return undefined;
  }
}
