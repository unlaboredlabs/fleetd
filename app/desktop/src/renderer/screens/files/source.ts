// A chat file read in byte ranges from the workspace (attachment_get's offset and length), so a view reads only what
// it shows: a table's first rows, a sheet's zip directory and one sheet, the pages of a PDF it draws. Never the whole
// 25 MB to show a name. An older workspace that ignores offset sends the whole file at once: it is kept, and every
// range after it is cut from it. Pure but for the call it is given, so it is unit-tested.
import { ATTACHMENT_PART_BYTES, type AttachmentGetOutput, type Call, type ProjectRef } from "../../../shared/contracts";
import { fromBase64 } from "../../../shared/base64";

/** What a file is, from its first piece. */
export interface FileHead {
  readonly name: string;
  readonly mime: string;
  /** The whole file's size. */
  readonly size: number;
}

export class ReadError extends Error {}

export interface FileSource {
  /** The name, type and size, with the file's first `FIRST_BYTES` (read once). */
  readonly head: () => Promise<FileHead & { readonly first: Uint8Array }>;
  /** The bytes from `offset`, at most `length`, cut at the file's end. */
  readonly range: (offset: number, length: number) => Promise<Uint8Array>;
  /** The file's first `cap` bytes (all of it when smaller). */
  readonly upTo: (cap: number) => Promise<Uint8Array>;
}

/** The first piece: big enough for most notes and tables at once, small enough to come at once. */
export const FIRST_BYTES = 256 * 1024;

export function fileSource(call: Call, projectRef: ProjectRef, attachmentId: string, piece = ATTACHMENT_PART_BYTES): FileSource {
  // Set by `get` once an older workspace sent all of it; read through `whole()`, as it may be set across an await.
  let kept: Uint8Array | undefined;
  const whole = (): Uint8Array | undefined => kept;
  let first: Promise<FileHead & { readonly first: Uint8Array }> | undefined;

  const get = async (offset: number, length: number): Promise<{ readonly out: AttachmentGetOutput; readonly data: Uint8Array }> => {
    const got = await call("attachment_get", { projectRef, attachmentId, offset, length });
    if (!got.ok) throw new ReadError(got.error.message);
    const data = fromBase64(got.output.dataB64);
    if (data === null) throw new ReadError("The workspace sent a file that isn't readable.");
    // No offset: the whole file, from an older workspace.
    if (got.output.offset === undefined) kept = data;
    return { out: got.output, data };
  };

  const head = () => {
    first ??= get(0, Math.min(piece, FIRST_BYTES)).then(({ out, data }) => ({ name: out.name, mime: out.mime, size: out.bytes, first: data }));
    return first;
  };

  const range = async (offset: number, length: number): Promise<Uint8Array> => {
    const { size, first: start } = await head();
    const end = Math.min(size, offset + length);
    if (end <= offset) return new Uint8Array(0);
    const all = whole();
    if (all !== undefined) return all.subarray(offset, end);
    if (end <= start.length) return start.subarray(offset, end);
    // In pieces of at most what one call carries, two at a time.
    const out = new Uint8Array(end - offset);
    const starts: number[] = [];
    for (let at = offset; at < end; at += piece) starts.push(at);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < starts.length) {
        const at = starts[next++] as number;
        const { data } = await get(at, Math.min(piece, end - at));
        if (whole() !== undefined) return;
        out.set(data.subarray(0, end - at), at - offset);
      }
    };
    await Promise.all([worker(), worker()]);
    return whole()?.subarray(offset, end) ?? out;
  };

  return { head, range, upTo: (cap) => range(0, cap) };
}
