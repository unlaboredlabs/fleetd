// `read_image` (crates/fleetd/src/node/sessions/files.rs `read_image`): a piece of an image or file an agent made in
// its own working directory, for the chat. The path must resolve inside that directory, the file is opened without
// following a last symlink and checked to be the one resolved, and its bytes must be what its name says
// (fleetd-contracts mcp.rs `AttachmentMime`).
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { ATTACHMENT_MAX_BYTES, type AttachmentMime } from "../../shared/contracts.ts";
import { IMAGE_PIECE_BYTES } from "../../shared/sessions.ts";

const IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT_EXTENSIONS = ["txt", "md", "markdown", "log", "json", "yaml", "yml", "toml", "xml", "ics", "vcf", "eml", "tsv", "srt", "vtt", "py", "js", "ts", "rs", "go", "sql"];
const HEAD = 64 * 1024;

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
    const head = bytes.subarray(0, HEAD);
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
  if (head.length !== HEAD) return false;
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
  const head = bytes.subarray(0, HEAD);
  return utf16Bom(head) || (isUtf8Head(head) && !head.includes(0)) ? "text/plain" : undefined;
}

export type Image = { name: string; mime: AttachmentMime; bytes: number; piece: Buffer };

/** The image (or, with `file`, any file the chat takes) at `path` in `root`, and its piece from `offset`. Throws a
 * person's words for what is wrong. */
export function readImage(root: string, path: string, offset: number, file: boolean): Image {
  const what = file ? "file" : "image";
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    throw new Error(`your working directory ${root} is not readable: ${(error as Error).message}`);
  }
  let real: string;
  try {
    real = realpathSync(join(realRoot, path));
  } catch (error) {
    throw new Error(`${path} is not readable here: ${(error as Error).message}`);
  }
  if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep))
    throw new Error(`${path} is outside your working directory ${realRoot}: only a${file ? "" : "n"} ${what} you made there can go in the chat`);
  const name = basename(real);
  const byName = ofName(name);
  if (!file && !(byName && IMAGES.includes(byName))) throw new Error(`${path} is not a .png, .jpg, .webp or .gif image`);
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${path} is not readable here: ${(error as Error).message}`);
  }
  try {
    const opened = fstatSync(fd);
    const named = lstatSync(real);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error(`${path} is not a plain file`);
    const bytes = opened.size;
    if (bytes > ATTACHMENT_MAX_BYTES) throw new Error(`${path} is ${bytes} bytes; a chat ${what} is at most ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB`);
    const head = Buffer.alloc(Math.min(HEAD, bytes));
    const got = readSync(fd, head, 0, head.length, 0);
    const start = head.subarray(0, got);
    let mime: AttachmentMime;
    if (file) {
      const m = ofFile(name, start);
      if (!m)
        throw new Error(
          `${path} is not a file the chat takes, or its bytes aren't what its name says: images, PDF, text and CSV, Word, Excel and PowerPoint (.docx, .xlsx, .pptx) and zip go in the chat`,
        );
      mime = m;
    } else {
      const m = ofImage(start);
      if (!m || m !== byName) throw new Error(`${path} does not hold the image its name says: only png, jpeg, webp and gif images go in the chat`);
      mime = m;
    }
    const piece = Buffer.alloc(Math.max(0, Math.min(IMAGE_PIECE_BYTES, bytes - offset)));
    const read = piece.length ? readSync(fd, piece, 0, piece.length, offset) : 0;
    return { name, mime, bytes, piece: piece.subarray(0, read) };
  } finally {
    closeSync(fd);
  }
}
