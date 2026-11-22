// A chat file's trip to and from the hub on a weak link, for the desktop app and the phone (through its desktop.ts):
// up as attachment_part pieces then attachment_put, down as attachment_get pieces, and an image's preview. A piece the
// link cut off goes again once the link is back, from where it stopped, rather than failing the file: the hub answers
// a piece sent again that it already has as taken, and the same put again with the file it stored. An older hub
// refuses those, so the file then goes again from its start, once; and it ignores maxSide and offset, sending the
// whole file, which reads as the answer. Pieces are sized to the link (pace): a few seconds each, so on a slow link no
// frame holds up the socket's others (a probe's answer, an event) for long enough that the link reads as dead, and a
// drop costs less. Pure: the call, the bytes, the wait and the clock are given, so it is unit-tested.
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
/** The first piece of a file, up or down: small, as the link's speed isn't known yet (a multiple of 3). */
export const FIRST_PIECE_BYTES = 65_535;
/**
 * What a piece should take on the link, as its last piece went. Every frame the socket carries after it waits until it
 * has come (two reads are in flight), and the phone's and the web app's links count a whole frame as their only sign
 * of life (the phone's reads one silent for 15 s as dead): at 256 kbit/s a 512 KiB piece is 22 s.
 */
export const PIECE_TARGET_MS = 3000;
/**
 * A piece going up may take longer: one goes at a time, each waiting a round trip for its answer, which a longer piece
 * pays less often, and the uplink holds up only what this app sends itself (frames down still come).
 */
export const UP_PIECE_TARGET_MS = 2 * PIECE_TARGET_MS;

/**
 * The size of each next piece, from how fast the last ones went: the bytes the link moved in `target` ms, from
 * FIRST_PIECE_BYTES up to `max`, a multiple of 3 so read pieces' base64 joins. A piece's time runs from when it was
 * asked, its wait behind another in flight included: answers that come together after a stall never read as a fast
 * link, and two reads in flight settle at about half the target each.
 */
const pace = (max: number, target: number, now: () => number) => {
  let size = FIRST_PIECE_BYTES;
  return {
    size: () => size,
    took: (bytes: number, asked: number): void => {
      const ms = Math.max(1, now() - asked);
      size = Math.min(max, Math.max(FIRST_PIECE_BYTES, Math.floor(((bytes / ms) * target) / 3) * 3));
    },
  };
};

/** The side a bubble's preview is asked at, in pixels: the phone's at 3x, the desktop's 360-point box at 2x. */
export const PREVIEW_SIDE = { phone: 1024, desktop: 720 } as const;

const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait before each try again: half a second, doubling, at most 2 s, so a link back is used within 2 s. */
const backoff = (n: number): number => Math.min(2000, 500 * 2 ** n);

/** The bytes a base64 string holds, without decoding it. */
export const b64Bytes = (b64: string): number => {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
};

/**
 * `tool` called until the hub answers, again while the link is down, within RECONNECT_BUDGET_MS of waiting; `again`
 * says whether it went more than once (its first may have reached the hub).
 */
const answered = async (
  call: TransferCall,
  tool: TransferTool,
  input: Readonly<Record<string, unknown>>,
  wait: Wait,
  now: () => number = Date.now,
): Promise<{ readonly outcome: TransferOutcome; readonly again: boolean; readonly asked: number }> => {
  let waited = 0;
  for (let n = 0; ; n++) {
    const asked = now();
    const outcome = await call(tool, input, PIECE_TIMEOUT_MS);
    if (outcome.ok || !LINK_DOWN.has(outcome.error.code) || waited >= RECONNECT_BUDGET_MS) return { outcome, again: n > 0, asked };
    const ms = backoff(n);
    await wait(ms);
    waited += ms;
  }
};

export type Sent = { readonly ok: true; readonly attachmentId: string; readonly bytes: number } | { readonly ok: false; readonly message: string };

/**
 * Sends a file of `size` bytes as `name`: `piece(start, end)` gives its bytes in that range as base64, and `progress`
 * hears the share sent so far, 0 to 1. Its pieces are sized to the link (pace).
 */
export const sendFile = async (
  call: TransferCall,
  size: number,
  piece: (start: number, end: number) => Promise<string> | string,
  name: string,
  mime: AttachmentMime,
  progress: (done: number) => void = () => undefined,
  wait: Wait = sleep,
  now: () => number = Date.now,
): Promise<Sent> => {
  const failed = (o: TransferOutcome): Sent => ({ ok: false, message: o.ok ? "The hub didn't store the file." : o.error.message });
  const paced = pace(ATTACHMENT_PART_BYTES, UP_PIECE_TARGET_MS, now);
  for (let fresh = 0; ; fresh++) {
    progress(0);
    let uploadId: string | undefined;
    let at = 0;
    let restart = false;
    for (let step = paced.size(); at + step < size; at += step, step = paced.size()) {
      const read = piece(at, at + step);
      const dataB64 = typeof read === "string" ? read : await read;
      const { outcome, again, asked } = await answered(call, "attachment_part", { ...(uploadId === undefined ? {} : { uploadId, offset: at }), dataB64 }, wait, now);
      if (!outcome.ok) {
        // A hub older than resuming refuses the piece it already had: the file goes again, from its start.
        restart = again && fresh === 0 && !LINK_DOWN.has(outcome.error.code);
        if (restart) break;
        return failed(outcome);
      }
      uploadId = (outcome.output as { uploadId: string }).uploadId;
      paced.took(step, asked);
      progress((at + step) / size);
    }
    if (restart) continue;
    // Bytes given at once go at once: a one-piece file's put leaves before sendFile returns.
    const last = piece(at, size);
    const dataB64 = typeof last === "string" ? last : await last;
    const { outcome, again } = await answered(call, "attachment_put", { name, mime, dataB64, ...(uploadId === undefined ? {} : { uploadId }) }, wait, now);
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

/** A read file, or why not: the hub's or the link's error code (`invalid` when the hub sent no file) and its words. */
export type Read = { readonly ok: true; readonly file: AttachmentGetOutput } | { readonly ok: false; readonly code: string; readonly message: string };

const readFailed = (o: TransferOutcome): Read => (o.ok ? { ok: false, code: "invalid", message: "The hub sent no file." } : { ok: false, code: o.error.code, message: o.error.message });

/** Pieces asked for at once while a file is read: the next is on its way while one comes, so no round trip idles. */
export const READS_IN_FLIGHT = 2;

/**
 * A file of the chat, whole, read in pieces sized to the link (pace), READS_IN_FLIGHT at a time: each again from its
 * offset after a drop. `progress` hears the share read so far. An older hub sends it whole on the first call.
 */
export const readFile = async (
  call: TransferCall,
  ref: { readonly projectRef: unknown; readonly attachmentId: string },
  progress: (done: number) => void = () => undefined,
  wait: Wait = sleep,
  now: () => number = Date.now,
): Promise<Read> => {
  const paced = pace(READ_PIECE_BYTES, PIECE_TARGET_MS, now);
  const piece = async (offset: number, length: number): Promise<Read> => {
    const { outcome, asked } = await answered(call, "attachment_get", { ...ref, offset, length }, wait, now);
    if (!outcome.ok) return readFailed(outcome);
    const out = outcome.output as AttachmentGetOutput;
    if (typeof out.dataB64 !== "string") return readFailed(outcome);
    paced.took(b64Bytes(out.dataB64), asked);
    return { ok: true, file: out };
  };
  const head = await piece(0, paced.size());
  // No offset: a hub that reads whole files only, and this is the file.
  if (!head.ok || head.file.offset === undefined) return head;
  const { offset: _, ...first } = head.file;
  const pieces = [first.dataB64];
  let next = b64Bytes(first.dataB64);
  // In order, each asked for once the one READS_IN_FLIGHT before it has come, at the size the link then takes.
  const reads: { readonly at: number; readonly read: Promise<Read> }[] = [];
  const ask = (): void => {
    if (next >= first.bytes) return;
    const length = paced.size();
    reads.push({ at: next, read: piece(next, length) });
    next += length;
  };
  for (let i = 0; i < READS_IN_FLIGHT; i++) ask();
  // The array's iterator reads its length each step, so it takes the pieces asked on the way too.
  for (const { at, read } of reads) {
    const r = await read;
    if (!r.ok) return r;
    pieces.push(r.file.dataB64);
    progress(Math.min(1, (at + b64Bytes(r.file.dataB64)) / first.bytes));
    ask();
  }
  progress(1);
  return { ok: true, file: { ...first, dataB64: pieces.join("") } };
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
