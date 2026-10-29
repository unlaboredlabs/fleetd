// A photo or file sent from the composer, as the desktop app sends one (screens/chat/drafts.ts): what the hub takes
// (an image, text or a PDF, up to its size limit), then attachment_part pieces in order and attachment_put with the
// last, with progress after each. Pure but for the call it is given, so it is unit-tested.
import { fileSize } from "./chatView";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_PART_BYTES, type AttachmentMime, type AttachmentRef, type ToolInput, type ToolName } from "./desktop";
import type { Typed } from "./hub/client";

/** The hub's call, as HubClient's. */
export type Call = <T extends ToolName>(tool: T, input: ToolInput<T>, timeoutMs?: number) => Promise<Typed<T>>;

export type Uploaded = { readonly ok: true; readonly ref: AttachmentRef } | { readonly ok: false; readonly message: string };

export const UPLOAD_TIMEOUT_MS = 120_000;

/** The mime type the hub takes for a file, by its name or the picker's type; undefined when it takes none. */
export const mimeOf = (name: string, type?: string | null): AttachmentMime | undefined => {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const byExt: Readonly<Record<string, AttachmentMime>> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/plain",
    log: "text/plain",
    csv: "text/plain",
    json: "text/plain",
  };
  const known: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain", "application/pdf"];
  if (type !== undefined && type !== null && known.includes(type)) return type as AttachmentMime;
  if (type?.startsWith("text/") === true) return "text/plain";
  return byExt[ext];
};

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
  if (mime === undefined) return `${name} can't be sent: the hub takes pictures, text files and PDFs.`;
  if (bytes > ATTACHMENT_MAX_BYTES) return `${name} is ${fileSize(bytes)}: the hub takes files up to ${fileSize(ATTACHMENT_MAX_BYTES)}.`;
  return undefined;
};

export const toBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** Sends `bytes` to the hub as `name`; `progress` hears the share sent so far, 0 to 1. */
export const upload = async (call: Call, bytes: Uint8Array, name: string, mime: AttachmentMime, progress: (done: number) => void = () => undefined): Promise<Uploaded> => {
  const failed = (o: { readonly error: { readonly message: string } }): Uploaded => ({ ok: false, message: o.error.message });
  const piece = (at: number) => toBase64(bytes.subarray(at, Math.min(at + ATTACHMENT_PART_BYTES, bytes.length)));
  let uploadId: string | undefined;
  let at = 0;
  progress(0);
  for (; at + ATTACHMENT_PART_BYTES < bytes.length; at += ATTACHMENT_PART_BYTES) {
    const o = await call("attachment_part", { ...(uploadId === undefined ? {} : { uploadId, offset: at }), dataB64: piece(at) }, UPLOAD_TIMEOUT_MS);
    if (!o.ok) return failed(o);
    uploadId = o.output.uploadId;
    progress((at + ATTACHMENT_PART_BYTES) / bytes.length);
  }
  const o = await call("attachment_put", { name, mime, dataB64: piece(at), ...(uploadId === undefined ? {} : { uploadId }) }, UPLOAD_TIMEOUT_MS);
  if (!o.ok) return failed(o);
  progress(1);
  return { ok: true, ref: { attachmentId: o.output.attachmentId, name, mime, bytes: o.output.bytes } };
};
