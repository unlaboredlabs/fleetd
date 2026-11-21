// What a chat file or image is, told from its name and its first bytes, and the person's words for one the chat
// doesn't take: no disk (image.ts reads the file by these). A hosted box's files are told the same way
// (fleetd/box/chat_file).
import { ATTACHMENT_MAX_BYTES, type AttachmentMime } from "../../shared/contracts.ts";

export const IMAGES: readonly AttachmentMime[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT_EXTENSIONS = ["txt", "md", "markdown", "log", "json", "yaml", "yml", "toml", "xml", "ics", "vcf", "eml", "tsv", "srt", "vtt", "py", "js", "ts", "rs", "go", "sql"];
/** How much of a file's start its type is told by. */
export const HEAD_BYTES = 64 * 1024;

const starts = (b: Uint8Array, bytes: number[]) => bytes.every((v, i) => b[i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** An image's type by its first bytes (png, jpeg, gif, webp). */
export function ofImage(head: Uint8Array): AttachmentMime | undefined {
  if (starts(head, [0x89, ...ascii("PNG\r\n"), 0x1a, 0x0a])) return "image/png";
  if (starts(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(head, ascii("GIF8")) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return "image/gif";
  if (head.length >= 12 && starts(head, ascii("RIFF")) && starts(head.subarray(8), ascii("WEBP"))) return "image/webp";
  return undefined;
}

/** The type a file's name says, by its extension. */
export function ofName(name: string): AttachmentMime | undefined {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  const known: Record<string, AttachmentMime> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
  };
  return known[ext] ?? (TEXT_EXTENSIONS.includes(ext) ? "text/plain" : undefined);
}

const utf16Bom = (b: Uint8Array) => (b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0xff && b[1] === 0xfe);

/** Whether `bytes` hold a file of type `mime`. */
function fits(mime: AttachmentMime, bytes: Uint8Array): boolean {
  if (IMAGES.includes(mime)) return ofImage(bytes) === mime;
  if (mime === "application/pdf") return starts(bytes, ascii("%PDF-"));
  if (mime === "text/plain" || mime === "text/csv") {
    const head = bytes.subarray(0, HEAD_BYTES);
    return utf16Bom(head) || !head.includes(0);
  }
  return starts(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

/** UTF-8, a character cut at the 64 KiB mark counting. */
function isUtf8Head(head: Uint8Array): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    decoder.decode(head);
    return true;
  } catch {}
  if (head.length !== HEAD_BYTES) return false;
  for (let cut = 1; cut <= 3; cut++) {
    try {
      decoder.decode(head.subarray(0, head.length - cut));
      return true;
    } catch {}
  }
  return false;
}

/** A file's type by its name and bytes together: what its name says when its bytes agree, an image by its bytes
 * whatever its name, and text for any other name whose start is UTF-8, or UTF-16 with its byte-order mark. */
export function ofFile(name: string, bytes: Uint8Array): AttachmentMime | undefined {
  const image = ofImage(bytes);
  if (image) return image;
  const named = ofName(name);
  if (named) return fits(named, bytes) ? named : undefined;
  const head = bytes.subarray(0, HEAD_BYTES);
  return utf16Bom(head) || (isUtf8Head(head) && !head.includes(0)) ? "text/plain" : undefined;
}

/** The type a chat file has, or an image with `file` false: an image is the one its name says, by its bytes. */
export function chatMime(name: string, head: Uint8Array, file: boolean): AttachmentMime | undefined {
  if (file) return ofFile(name, head);
  const m = ofImage(head);
  return m && m === ofName(name) ? m : undefined;
}

const what = (file: boolean) => (file ? "file" : "image");

/** A person's words for why a chat file or image can't go in the chat. */
export const refused = {
  rootUnreadable: (root: string, why: string) => `your working directory ${root} is not readable: ${why}`,
  unreadable: (path: string, why: string) => `${path} is not readable here: ${why}`,
  outside: (path: string, root: string, file: boolean) => `${path} is outside your working directory ${root}: only a${file ? "" : "n"} ${what(file)} you made there can go in the chat`,
  notImageName: (path: string) => `${path} is not a .png, .jpg, .webp or .gif image`,
  notPlain: (path: string) => `${path} is not a plain file`,
  tooLarge: (path: string, bytes: number, file: boolean) => `${path} is ${bytes} bytes; a chat ${what(file)} is at most ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB`,
  notWhatItSays: (path: string, file: boolean) =>
    file
      ? `${path} is not a file the chat takes, or its bytes aren't what its name says: images, PDF, text and CSV, Word, Excel and PowerPoint (.docx, .xlsx, .pptx) and zip go in the chat`
      : `${path} does not hold the image its name says: only png, jpeg, webp and gif images go in the chat`,
};
