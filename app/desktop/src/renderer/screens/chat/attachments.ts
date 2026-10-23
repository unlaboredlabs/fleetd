// What a message can carry (the hub's attachment_put limits) and how a file becomes one. From the board composer.

import type { AttachmentMime } from "../../../shared/contracts";

export const MAX_ATTACHMENTS = 8;
/** A paste longer than this becomes a `pasted-N.txt` attachment (T3 Code's large-paste rule, under the limit). */
export const PASTE_AS_FILE = 3500;

/** The mime type the hub takes for a file; undefined when it isn't an image, text or PDF. */
export const mimeFor = (name: string, looksText: boolean): AttachmentMime | undefined => {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const known: Record<string, AttachmentMime> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
  };
  return known[ext] ?? (looksText ? "text/plain" : undefined);
};

/** A pasted image has no useful name ("image.png"): name it by its kind and number. */
export const pastedName = (mime: string, n: number): string => {
  const ext = mime === "image/jpeg" ? "jpg" : mime.startsWith("image/") ? mime.slice("image/".length) : "txt";
  return `pasted-${n}.${ext}`;
};

export const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.floor(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`;

export const toBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export const looksText = (buf: ArrayBuffer): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(buf).subarray(0, 4096));
    return true;
  } catch {
    return false;
  }
};
