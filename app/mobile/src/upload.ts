// A photo or file sent from the composer, as the desktop app sends one (screens/chat/drafts.ts): what the hub takes
// (images, PDFs, text and CSV, Office files and zips, up to its size limit), then attachment_part pieces in order and
// attachment_put with the last, with progress after each, resumed after a drop (the desktop's shared/transfer.ts). Pure but for the call it is given, so it is unit-tested.
import { fileSize } from "./chatView";
import { ATTACHMENT_MAX_BYTES, mimeOfFile, sendFile, TAKES, type AttachmentMime, type AttachmentRef, type ToolInput, type ToolName, type Wait } from "./desktop";
import type { Typed } from "./hub/client";

/** The hub's call, as HubClient's. */
export type Call = <T extends ToolName>(tool: T, input: ToolInput<T>, timeoutMs?: number) => Promise<Typed<T>>;

export type Uploaded = { readonly ok: true; readonly ref: AttachmentRef } | { readonly ok: false; readonly message: string };

export const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * The mime type the hub takes for a file, by its name, or the picker's type for a name that says nothing (text by
 * either); undefined when it takes none. The hub checks the bytes again.
 */
export const mimeOf = (name: string, type?: string | null): AttachmentMime | undefined => {
  const known = mimeOfFile(name, false);
  if (known !== undefined) return known;
  const byType = type === undefined || type === null ? undefined : mimeOfFile(`file.${extensionFor(type)}`, false);
  if (byType !== undefined) return byType;
  return type?.startsWith("text/") === true ? "text/plain" : undefined;
};

/** The usual extension of a type a picker names, for mimeOfFile: `application/pdf` is `pdf`. */
const extensionFor = (type: string): string =>
  ({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "text/csv": "csv",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/zip": "zip",
  })[type] ?? "";

/**
 * A picked photo's name as what it is: the picker hands a HEIC from the library back as a JPEG (its uri says so) but
 * keeps the library's name, `IMG_0111.heic`.
 */
export const pickedName = (fileName: string | null | undefined, uri: string, fallback: string): string => {
  const ext = /\.([a-z0-9]+)$/iu.exec(uri)?.[1]?.toLowerCase();
  const base = (fileName ?? fallback).replace(/\.[a-z0-9]+$/iu, "");
  return ext === undefined ? (fileName ?? fallback) : `${base}.${ext}`;
};

/** Why the hub wouldn't take a file, before sending a byte; undefined when it would. */
export const refusal = (name: string, mime: AttachmentMime | undefined, bytes: number): string | undefined => {
  if (mime === undefined) return `${name} can't be sent: chats take ${TAKES}.`;
  if (bytes > ATTACHMENT_MAX_BYTES) return `${name} is ${fileSize(bytes)}: the hub takes files up to ${fileSize(ATTACHMENT_MAX_BYTES)}.`;
  return undefined;
};

export const toBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * Sends `bytes` to the hub as `name`; `progress` hears the share sent so far, 0 to 1. A piece the link cut off goes
 * again once it is back (sendFile), so a drop mid-way costs that piece, not the file.
 */
export const upload = async (call: Call, bytes: Uint8Array, name: string, mime: AttachmentMime, progress: (done: number) => void = () => undefined, wait?: Wait): Promise<Uploaded> => {
  const sent = await sendFile(
    (tool, input, ms) => call(tool, input as never, ms),
    bytes.length,
    (start, end) => toBase64(bytes.subarray(start, Math.min(end, bytes.length))),
    name,
    mime,
    progress,
    wait,
  );
  return sent.ok ? { ok: true, ref: { attachmentId: sent.attachmentId, name, mime, bytes: sent.bytes } } : sent;
};
