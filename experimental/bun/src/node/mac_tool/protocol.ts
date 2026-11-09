// The agents' Mac's steps and answers (D298; crates/fleetd/src/node/mac_tool/mod.rs). An agent's `fleetd mac` asks its
// own node (client.ts), which seals each step to the Mac's node and sends it through the hub; the Mac's node
// (host.ts) opens it, runs it in the agent's own folder there and seals the answer back. Each step is a sealed box to
// the Mac's key holding the step, when it was made, a nonce the Mac takes only once and a fresh key for the answer,
// so only the agent's node opens what comes back. A step or an answer may carry raw bytes after its JSON (a piece of
// a file), so large pushes and pulls go without base64.
import { seal, secretbox, secretboxOpen } from "../../shared/sealed_box.ts";
import type { McpToolError } from "../../shared/screens_wire.ts";

/** The most of a file one step carries. */
export const PIECE = 2 << 20;
/** The most a push sends. */
export const PUSH_MAX = 2 * 2 ** 30;
/** The most a pull brings back. */
export const PULL_MAX = 2 ** 30;
/** The most output one `logs` step carries. */
export const LOGS_MAX = 256 << 10;
/** How far a step's clock may be from the Mac's: older ones are refused, as are nonces seen within it. */
export const SKEW_MS = 5 * 60_000;

export type MacEnv = { name: string; value: string };
export type MacJob = { job: number; command: string; background: boolean; running: boolean; exitCode?: number; startedMs: number };

export type Step =
  | { step: "have" }
  | { step: "put"; name: string; offset: number; dataB64: string }
  | { step: "checkout"; snapshot: string; pack?: string }
  | { step: "run"; args: string[]; env: MacEnv[]; background: boolean }
  | { step: "logs"; job: number; offset: number }
  | { step: "ps" }
  | { step: "kill"; job: number }
  | { step: "get"; path: string; offset: number; raw?: boolean }
  /** `device`: a device type of the agent's choosing; absent, the golden's. `wait`: none free, the agent joins the line
   * (queue.ts) and hears its place; an older node sends none. */
  | { step: "sim_start"; device?: string; wait?: boolean }
  | { step: "sim_end" };

export type Done =
  | { step: "have"; snapshots: string[]; raw: boolean }
  | { step: "put"; bytes: number }
  | { step: "checkout"; folder: string }
  | { step: "run"; job: number }
  | { step: "logs"; dataB64: string; offset: number; done: boolean; exitCode?: number }
  | { step: "ps"; jobs: MacJob[] }
  | { step: "kill"; job: number; killed: boolean }
  | { step: "get"; dataB64: string; total: number; folder: boolean }
  | { step: "sim_start"; udid: string; device: string }
  | { step: "sim_queued"; place: number; secs?: number | null; why: string }
  | { step: "sim_end"; ended: boolean };

/** What goes inside the sealed box. */
export type Envelope = { thread: string; atMs: number; nonce: string; answerKey: string; step: Step };
export type Answer = { done?: Done; error?: McpToolError };

const encoder = new TextEncoder();
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** A step and the raw bytes after its JSON, sealed to the Mac's raw X25519 key `to`, base64. */
export function sealStep(to: Uint8Array, envelope: Envelope, raw: Uint8Array = new Uint8Array()): string {
  return Buffer.from(seal(to, concat(encoder.encode(JSON.stringify(envelope)), raw))).toString("base64");
}

/** The JSON object at the start of `plain`, and the raw bytes after it (mod.rs `split_raw`). */
export function splitRaw<T>(plain: Uint8Array): [T, Uint8Array] {
  if (plain[0] !== 0x7b) throw new Error("it doesn't start with an object");
  let depth = 0;
  let inString = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain[i]!;
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) depth++;
    else if (c === 0x7d || c === 0x5d) {
      depth--;
      if (depth === 0) return [JSON.parse(new TextDecoder().decode(plain.subarray(0, i + 1))) as T, plain.subarray(i + 1)];
    }
  }
  throw new Error("it ends inside its JSON");
}

/** The answer and the raw bytes after it, sealed with the step's own answer key (fresh each step: one fixed nonce). */
export function sealAnswer(key: Uint8Array, answer: Answer, raw: Uint8Array = new Uint8Array()): string {
  return Buffer.from(secretbox(key, new Uint8Array(24), concat(encoder.encode(JSON.stringify(answer)), raw))).toString("base64");
}

export function openAnswer(key: Uint8Array, sealedB64: string): [Answer, Uint8Array] | undefined {
  const plain = secretboxOpen(key, new Uint8Array(24), Buffer.from(sealedB64, "base64"));
  if (!plain) return undefined;
  try {
    return splitRaw<Answer>(plain);
  } catch {
    return undefined;
  }
}

/** A name safe as one path part: what an agent's folder and a project's mirror are called on the Mac. */
export function safePart(name: string): string | undefined {
  const ok = name.length > 0 && name.length <= 100 && name !== "." && name !== ".." && !name.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(name);
  return ok ? name : undefined;
}

/** iOS simulators agents may have booted at once: about 3 GB each, the Mac keeping 8 GB for itself, at least 1. */
export const simBudget = (memBytes: number) => Math.max(Math.floor(Math.max(Math.floor(memBytes / 2 ** 30) - 8, 0) / 3), 1);
