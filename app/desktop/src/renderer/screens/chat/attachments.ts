// What a message can carry (the hub's attachment_put limits) and how a file becomes one. From the board composer.

import { ATTACHMENTS_MAX, type AttachmentMime } from "../../../shared/contracts";

export const MAX_ATTACHMENTS = ATTACHMENTS_MAX;
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

/** The box an image sent with a message fits in, keeping its shape. */
export const IMAGE_MAX = { width: 360, height: 280 } as const;

/**
 * How many pixels a PNG puts in a point, from its pHYs chunk: 2 for a Retina screenshot (144 dpi), 1 for anything
 * else or a file that doesn't say. Reads only the chunks before the image data.
 */
export function pngDensity(dataB64: string): number {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(dataB64.slice(0, 16_384)), (c) => c.charCodeAt(0));
  } catch {
    return 1;
  }
  const view = new DataView(bytes.buffer);
  const word = (at: number, n = 4) => String.fromCharCode(...bytes.subarray(at, at + n));
  if (bytes.length < 8 || word(1, 3) !== "PNG") return 1;
  for (let at = 8; at + 8 <= bytes.length; ) {
    const len = view.getUint32(at);
    const type = word(at + 4);
    if (type === "IDAT" || type === "IEND") return 1;
    if (type === "pHYs" && at + 17 <= bytes.length) {
      // Pixels per unit along x, then y, then the unit: 1 is the metre.
      if (bytes[at + 16] !== 1) return 1;
      const dpi = view.getUint32(at + 8) * 0.0254;
      return Math.min(3, Math.max(1, Math.round(dpi / 72)));
    }
    at += 12 + len;
  }
  return 1;
}

/** An image's size in the chat: its pixels over `density` (points, as it was on its screen), shrunk to fit IMAGE_MAX. */
export function imageFit(width: number, height: number, density = 1): { width: number; height: number } {
  if (!(width > 0 && height > 0)) return { ...IMAGE_MAX };
  const w = width / density;
  const h = height / density;
  const scale = Math.min(1, IMAGE_MAX.width / w, IMAGE_MAX.height / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}
