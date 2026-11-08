// A chat file's trip to and from the hub on a weak link, for the desktop app and the phone (through its desktop.ts):
// up as attachment_part pieces then attachment_put, down as attachment_get pieces, and an image's preview. A piece the
// link cut off goes again once the link is back, from where it stopped, rather than failing the file: the hub answers
// a piece sent again that it already has as taken, and the same put again with the file it stored. An older hub
// refuses those, so the file then goes again from its start, once; and it ignores maxSide and offset, sending the
// whole file, which reads as the answer. Pure: the call, the bytes and the wait are given, so it is unit-tested.
import { ATTACHMENT_PART_BYTES } from "./contracts";
import type { AttachmentGetOutput, AttachmentMime } from "./contracts";

export type TransferOutcome = { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
export type TransferTool = "attachment_part" | "attachment_put" | "attachment_get";
export type TransferCall = (tool: TransferTool, input: Readonly<Record<string, unknown>>, timeoutMs: number) => Promise<TransferOutcome>;
export type Wait = (ms: number) => Promise<void>;

/** A call that failed because the link did, not the hub: worth sending again once it is back. */
export const LINK_DOWN: ReadonlySet<string> = new Set(["disconnected", "offline", "timeout"]);
/** How long a transfer waits for the link to come back between two answers, before it gives up. */
export const RECONNECT_BUDGET_MS = 120_000;
/** One piece's call: 512 KiB up a slow link is a few seconds, and a dead link fails it sooner. */
export const PIECE_TIMEOUT_MS = 120_000;
/** A piece read down: the largest multiple of 3 within a call's piece, so the pieces' base64 joins as one. */
export const READ_PIECE_BYTES = ATTACHMENT_PART_BYTES - (ATTACHMENT_PART_BYTES % 3);
/** The side a bubble's preview is asked at, in pixels: the phone's at 3x, the desktop's 360-point box at 2x. */
export const PREVIEW_SIDE = { phone: 1024, desktop: 720 } as const;

const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait before each try again: half a second, doubling, at most 4 s. */
const backoff = (n: number): number => Math.min(4000, 500 * 2 ** n);

/** The bytes a base64 string holds, without decoding it. */
export const b64Bytes = (b64: string): number => {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
};

/**
 * `tool` called until the hub answers, again while the link is down, within RECONNECT_BUDGET_MS of waiting; `again`
 * says whether it went more than once (its first may have reached the hub).
 */
const answered = async (call: TransferCall, tool: TransferTool, input: Readonly<Record<string, unknown>>, wait: Wait): Promise<{ readonly outcome: TransferOutcome; readonly again: boolean }> => {
  let waited = 0;
  for (let n = 0; ; n++) {
    const outcome = await call(tool, input, PIECE_TIMEOUT_MS);
    if (outcome.ok || !LINK_DOWN.has(outcome.error.code) || waited >= RECONNECT_BUDGET_MS) return { outcome, again: n > 0 };
    const ms = backoff(n);
    await wait(ms);
    waited += ms;
  }
};

export type Sent = { readonly ok: true; readonly attachmentId: string; readonly bytes: number } | { readonly ok: false; readonly message: string };

/**
 * Sends a file of `size` bytes as `name`: `piece(start, end)` gives its bytes in that range as base64, and `progress`
 * hears the share sent so far, 0 to 1.
 */
export const sendFile = async (
  call: TransferCall,
  size: number,
  piece: (start: number, end: number) => Promise<string> | string,
  name: string,
  mime: AttachmentMime,
  progress: (done: number) => void = () => undefined,
  wait: Wait = sleep,
): Promise<Sent> => {
  const failed = (o: TransferOutcome): Sent => ({ ok: false, message: o.ok ? "The hub didn't store the file." : o.error.message });
  for (let fresh = 0; ; fresh++) {
    progress(0);
    let uploadId: string | undefined;
    let at = 0;
    let restart = false;
    for (; at + ATTACHMENT_PART_BYTES < size; at += ATTACHMENT_PART_BYTES) {
      const read = piece(at, at + ATTACHMENT_PART_BYTES);
      const dataB64 = typeof read === "string" ? read : await read;
      const { outcome, again } = await answered(call, "attachment_part", { ...(uploadId === undefined ? {} : { uploadId, offset: at }), dataB64 }, wait);
      if (!outcome.ok) {
        // A hub older than resuming refuses the piece it already had: the file goes again, from its start.
        restart = again && fresh === 0 && !LINK_DOWN.has(outcome.error.code);
        if (restart) break;
        return failed(outcome);
      }
      uploadId = (outcome.output as { uploadId: string }).uploadId;
      progress((at + ATTACHMENT_PART_BYTES) / size);
    }
    if (restart) continue;
    // Bytes given at once go at once: a one-piece file's put leaves before sendFile returns.
    const last = piece(at, size);
    const dataB64 = typeof last === "string" ? last : await last;
    const { outcome, again } = await answered(call, "attachment_put", { name, mime, dataB64, ...(uploadId === undefined ? {} : { uploadId }) }, wait);
    if (!outcome.ok) {
      // An older hub forgot the upload once the put that reached it stored it.
      if (again && fresh === 0 && uploadId !== undefined && !LINK_DOWN.has(outcome.error.code)) continue;
      return failed(outcome);
    }
    const out = outcome.output as { attachmentId: string; bytes: number };
    progress(1);
    return { ok: true, attachmentId: out.attachmentId, bytes: out.bytes };
  }
};

export type Read = { readonly ok: true; readonly file: AttachmentGetOutput } | { readonly ok: false; readonly message: string };

const readFailed = (o: TransferOutcome): Read => ({ ok: false, message: o.ok ? "The hub sent no file." : o.error.message });

/**
 * A file of the chat, whole, read in pieces: each from where the last ended, again from there after a drop.
 * `progress` hears the share read so far. An older hub sends it whole on the first call.
 */
export const readFile = async (
  call: TransferCall,
  ref: { readonly projectRef: unknown; readonly attachmentId: string },
  progress: (done: number) => void = () => undefined,
  wait: Wait = sleep,
): Promise<Read> => {
  const pieces: string[] = [];
  let at = 0;
  let first: AttachmentGetOutput | undefined;
  for (;;) {
    const { outcome } = await answered(call, "attachment_get", { ...ref, offset: at, length: READ_PIECE_BYTES }, wait);
    if (!outcome.ok) return readFailed(outcome);
    const out = outcome.output as AttachmentGetOutput;
    if (typeof out.dataB64 !== "string") return readFailed(outcome);
    // No offset: a hub that reads whole files only, and this is the file.
    if (out.offset === undefined) return { ok: true, file: out };
    first ??= out;
    const got = b64Bytes(out.dataB64);
    pieces.push(out.dataB64);
    at += got;
    progress(out.bytes === 0 ? 1 : at / out.bytes);
    if (at >= out.bytes || got === 0) {
      const { offset: _, ...file } = first;
      return { ok: true, file: { ...file, dataB64: pieces.join("") } };
    }
  }
};

/**
 * An image's preview, at most `side` pixels a side, for its bubble; `preview` false when the hub sent the file itself
 * (it was small already, or the hub is older), which the viewer can then show as it is.
 */
export const readPreview = async (call: TransferCall, ref: { readonly projectRef: unknown; readonly attachmentId: string }, side: number, wait: Wait = sleep): Promise<Read> => {
  const { outcome } = await answered(call, "attachment_get", { ...ref, maxSide: side }, wait);
  if (!outcome.ok) return readFailed(outcome);
  const out = outcome.output as AttachmentGetOutput;
  return typeof out.dataB64 === "string" ? { ok: true, file: out } : readFailed(outcome);
};
