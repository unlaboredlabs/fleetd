// A file's type as the hub keeps attachments (crates/fleetd-contracts/src/mcp.rs `AttachmentMime`'s methods): which
// bytes fit which type, the extension a name gets, and text kept as UTF-8. The text conversion runs on chunks, so a
// 25 MiB CSV is re-encoded on its way to disk rather than held whole.
import type { AttachmentMime, KnownAttachmentMime } from "../../shared/contracts.ts";

export const KNOWN: readonly KnownAttachmentMime[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "application/pdf",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
];

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** A stored type string as a type the hub knows; undefined for one it doesn't (serde's refusal). */
export const mimeOf = (mime: string): KnownAttachmentMime | undefined =>
  (KNOWN as readonly string[]).includes(mime) ? (mime as KnownAttachmentMime) : undefined;

/** How much of a file's start decides whether it is text. */
export const TEXT_HEAD = 64 * 1024;

const startsWith = (b: Uint8Array, prefix: readonly number[]) => b.length >= prefix.length && prefix.every((x, i) => b[i] === x);

/** An image's type by its first bytes (png, jpeg, gif, webp); undefined for anything else. */
export function ofImage(head: Uint8Array): KnownAttachmentMime | undefined {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return "image/gif";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && head.length >= 12 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
    return "image/webp";
  }
  return undefined;
}

export const isImage = (mime: AttachmentMime) => mime === "image/png" || mime === "image/jpeg" || mime === "image/webp" || mime === "image/gif";

const isText = (mime: AttachmentMime) => mime === "text/plain" || mime === "text/csv";

/** Whether text starts with a UTF-16 byte-order mark: true for big-endian, false for little-endian. */
function utf16Bom(b: Uint8Array): boolean | undefined {
  if (b[0] === 0xfe && b[1] === 0xff) return true;
  if (b[0] === 0xff && b[1] === 0xfe) return false;
  return undefined;
}

/**
 * Whether a file whose first bytes are `head` (at least its first 64 KiB, or all of it) is of this type: an image's or
 * a PDF's own first bytes, a zip archive for an Office document, and for text UTF-16 with its byte-order mark, or any
 * 8-bit text with no NUL in its first 64 KiB.
 */
export function fits(mime: AttachmentMime, head: Uint8Array): boolean {
  if (isImage(mime)) return ofImage(head) === mime;
  switch (mime) {
    case "application/pdf":
      return startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case DOCX:
    case XLSX:
    case PPTX:
    case "application/zip":
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]);
    case "text/plain":
    case "text/csv": {
      const start = head.subarray(0, TEXT_HEAD);
      return utf16Bom(start) !== undefined || !start.includes(0);
    }
    default:
      return false;
  }
}

/** Names that say a file is text: notes, data, calendar invites, mail, code. */
const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "log", "json", "yaml", "yml", "toml", "xml", "ics", "vcf", "eml", "tsv", "srt", "vtt", "py",
  "js", "ts", "rs", "go", "sql",
];

/** The extensions a file of this type may carry, its usual one first. */
export function extensions(mime: AttachmentMime): readonly string[] {
  switch (mime) {
    case "image/png":
      return ["png"];
    case "image/jpeg":
      return ["jpg", "jpeg"];
    case "image/webp":
      return ["webp"];
    case "image/gif":
      return ["gif"];
    case "application/pdf":
      return ["pdf"];
    case "text/csv":
      return ["csv"];
    case DOCX:
      return ["docx"];
    case XLSX:
      return ["xlsx"];
    case PPTX:
      return ["pptx"];
    case "application/zip":
      return ["zip"];
    default:
      return TEXT_EXTENSIONS;
  }
}

/** `name` with an extension of this type: kept when it has one, else this type's usual one added. */
export function named(mime: AttachmentMime, name: string): string {
  const dot = name.lastIndexOf(".");
  const has = dot > 0 && extensions(mime).includes(asciiLower(name.slice(dot + 1)));
  return has ? name : `${name}.${extensions(mime)[0]}`;
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** What the file is, in a few words: "a PDF", "a Word document". */
export function kind(mime: AttachmentMime): string {
  if (isImage(mime)) return "an image";
  switch (mime) {
    case "application/pdf":
      return "a PDF";
    case "text/plain":
      return "a text file";
    case "text/csv":
      return "a CSV spreadsheet";
    case DOCX:
      return "a Word document";
    case XLSX:
      return "an Excel spreadsheet";
    case PPTX:
      return "a PowerPoint deck";
    case "application/zip":
      return "a zip archive";
    default:
      return "a file";
  }
}

/** A file's bytes, read as often as needed: each call starts again from its first chunk. */
export type Chunks = () => AsyncIterable<Uint8Array>;

/** How text is turned into UTF-8 ([`utf8Text`]'s choice), or `raw` for bytes kept as they are. */
export type TextPlan = "utf16be" | "utf16le" | "utf8" | "cp1252" | "raw";

/**
 * How `mime`'s file is kept (Rust `AttachmentMime::utf8_text`): text as UTF-8, by its UTF-16 byte-order mark, as UTF-8
 * when all of it is (a character cut at the end too) or when UTF-8's own multi-byte characters come before its first
 * bad byte, else as Windows-1252. Decided on the whole file, never its start alone. Anything that isn't text, or
 * "text" with a NUL in its first 64 KiB, is kept raw.
 */
export async function textPlan(mime: AttachmentMime, chunks: Chunks): Promise<TextPlan> {
  if (!isText(mime)) return "raw";
  const scan = new Utf8Scan();
  let head = new Uint8Array(0);
  for await (const chunk of chunks()) {
    if (head.length < TEXT_HEAD) head = concat(head, chunk.subarray(0, TEXT_HEAD - head.length)) as Uint8Array<ArrayBuffer>;
    if (head.length >= 2 && utf16Bom(head) !== undefined) break;
    if (!scan.feed(chunk)) break;
  }
  const big = utf16Bom(head);
  if (big !== undefined) return big ? "utf16be" : "utf16le";
  if (head.includes(0)) return "raw";
  return scan.utf8() ? "utf8" : "cp1252";
}

/** The file re-encoded as `plan` says, chunk by chunk. */
export async function* reencode(plan: TextPlan, chunks: Chunks): AsyncIterable<Uint8Array> {
  if (plan === "raw") {
    yield* chunks();
    return;
  }
  const encoder = new TextEncoder();
  if (plan === "cp1252") {
    for await (const chunk of chunks()) yield cp1252(chunk);
    return;
  }
  if (plan === "utf8") {
    // Lossy, as String::from_utf8_lossy, with a leading byte-order mark dropped.
    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
    for await (const chunk of chunks()) {
      const text = decoder.decode(chunk, { stream: true });
      if (text) yield encoder.encode(text);
    }
    const rest = decoder.decode();
    if (rest) yield encoder.encode(rest);
    return;
  }
  // UTF-16 after its mark, in whole code units: an odd last byte is dropped, an unpaired surrogate is U+FFFD.
  const decoder = new TextDecoder(plan === "utf16be" ? "utf-16be" : "utf-16le", { fatal: false, ignoreBOM: true });
  let skip = 2;
  let carry: Uint8Array = new Uint8Array(0);
  for await (const chunk of chunks()) {
    let bytes = chunk;
    if (skip > 0) {
      const cut = Math.min(skip, bytes.length);
      bytes = bytes.subarray(cut);
      skip -= cut;
    }
    if (carry.length) bytes = concat(carry, bytes);
    const even = bytes.length - (bytes.length % 2);
    carry = bytes.slice(even);
    const text = decoder.decode(bytes.subarray(0, even), { stream: true });
    if (text) yield encoder.encode(text);
  }
  const rest = decoder.decode();
  if (rest) yield encoder.encode(rest);
}

/** A whole file's text as the hub keeps it; undefined when it isn't text. */
export async function utf8Text(bytes: Uint8Array): Promise<string | undefined> {
  const chunks: Chunks = async function* () {
    yield bytes;
  };
  const plan = await textPlan("text/plain", chunks);
  if (plan === "raw") return undefined;
  const out: Uint8Array[] = [];
  for await (const piece of reencode(plan, chunks)) out.push(piece);
  return new TextDecoder().decode(concat(...out));
}

/** Windows-1252's printable marks at 0x80 to 0x9F; its five unassigned bytes stay as Latin-1's controls. */
const HIGH = [
  "€", "\u0081", "‚", "ƒ", "„", "…", "†", "‡", "ˆ", "‰", "Š", "‹", "Œ", "\u008D", "Ž", "\u008F",
  "\u0090", "‘", "’", "“", "”", "•", "–", "—", "˜", "™", "š", "›", "œ", "\u009D", "ž", "Ÿ",
];
/** Each byte's character as UTF-8. */
const CP1252: Uint8Array[] = Array.from({ length: 256 }, (_, b) =>
  new TextEncoder().encode(b >= 0x80 && b <= 0x9f ? HIGH[b - 0x80] : String.fromCharCode(b)),
);

function cp1252(bytes: Uint8Array): Uint8Array {
  let len = 0;
  for (const b of bytes) len += CP1252[b]!.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const b of bytes) {
    const c = CP1252[b]!;
    if (c.length === 1) out[at++] = c[0]!;
    else {
      out.set(c, at);
      at += c.length;
    }
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * UTF-8 validity over chunks, as `std::str::from_utf8` decides it: where the first bad byte is (if any), whether the
 * input only ends mid-character, and whether a multi-byte character came before the first bad byte.
 */
class Utf8Scan {
  /** Continuation bytes the current character still needs. */
  private need = 0;
  /** The range the next continuation byte must be in (E0, ED, F0 and F4 narrow it). */
  private lo = 0x80;
  private hi = 0xbf;
  private bad = false;
  private wide = false;

  /** Scans a chunk; false once a bad byte is found, after which nothing more is read. */
  feed(chunk: Uint8Array): boolean {
    if (this.bad) return false;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;
      if (this.need > 0) {
        if (b < this.lo || b > this.hi) return this.fail();
        this.lo = 0x80;
        this.hi = 0xbf;
        this.need--;
        if (this.need === 0) this.wide = true;
        continue;
      }
      if (b < 0x80) continue;
      if (b >= 0xc2 && b <= 0xdf) this.need = 1;
      else if (b >= 0xe0 && b <= 0xef) {
        this.need = 2;
        if (b === 0xe0) this.lo = 0xa0;
        if (b === 0xed) this.hi = 0x9f;
      } else if (b >= 0xf0 && b <= 0xf4) {
        this.need = 3;
        if (b === 0xf0) this.lo = 0x90;
        if (b === 0xf4) this.hi = 0x8f;
      } else return this.fail();
    }
    return true;
  }

  private fail(): false {
    this.bad = true;
    return false;
  }

  /** Read as UTF-8: all of it is (a character cut at the end too), or wide characters came before the bad byte. */
  utf8(): boolean {
    return !this.bad || this.wide;
  }
}
