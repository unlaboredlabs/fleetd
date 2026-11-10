// The files a chat carries, as the hub takes them (AttachmentMime in crates/fleetd-contracts/src/mcp.rs): a file's
// type by its name, what to call it, and a name safe to open it under. Pure, shared by the desktop's main process and
// renderer and by the phone app.
import type { AttachmentMime } from "./contracts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Names that say text, as the hub's: notes, data, invites, mail, code. */
const TEXT = ["txt", "md", "markdown", "log", "json", "yaml", "yml", "toml", "xml", "ics", "vcf", "eml", "tsv", "srt", "vtt", "py", "js", "ts", "rs", "go", "sql"];

const BY_EXTENSION: Readonly<Record<string, AttachmentMime>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  csv: "text/csv",
  docx: DOCX,
  xlsx: XLSX,
  pptx: PPTX,
  zip: "application/zip",
  ...Object.fromEntries(TEXT.map((e) => [e, "text/plain" as const])),
};

const extensionOf = (name: string): string => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

/**
 * The type the hub takes a file as: what its name says, or text for any other name whose bytes are text. Undefined
 * for a file it doesn't take. The hub checks the bytes again.
 */
export const mimeOfFile = (name: string, looksText: boolean): AttachmentMime | undefined => BY_EXTENSION[extensionOf(name)] ?? (looksText ? "text/plain" : undefined);

/** What the hub takes, in words, for a refusal. */
export const TAKES = "images, PDFs, text and CSV, Word, Excel and PowerPoint files, and zips";

/** A file's kind in a word or two, for its card: "PDF", "Word document". */
export const kindOf = (mime: string): string => {
  switch (mime) {
    case "application/pdf":
      return "PDF";
    case "text/csv":
      return "CSV";
    case DOCX:
      return "Word document";
    case XLSX:
      return "Excel spreadsheet";
    case PPTX:
      return "PowerPoint";
    case "application/zip":
      return "Zip archive";
    case "text/plain":
      return "Text";
    default:
      return mime.startsWith("image/") ? "Image" : "File";
  }
};

/** Which glyph a file's card shows. */
export type FileGlyph = "pdf" | "sheet" | "doc" | "slides" | "zip" | "text" | "image" | "file";

export const glyphOf = (mime: string): FileGlyph => {
  switch (mime) {
    case "application/pdf":
      return "pdf";
    case "text/csv":
    case XLSX:
      return "sheet";
    case DOCX:
      return "doc";
    case PPTX:
      return "slides";
    case "application/zip":
      return "zip";
    case "text/plain":
      return "text";
    default:
      return mime.startsWith("image/") ? "image" : "file";
  }
};

/**
 * A name to keep a file under on this computer: no folders in it, and an extension of its type, so opening it never
 * runs it (a text file named `run.command` opens as `run.command.txt`).
 */
export const safeFileName = (name: string, mime: string): string => {
  const cleaned = name.replace(/[/\\:]/gu, "_").replace(/\p{Cc}/gu, "_");
  const base = cleaned.replace(/^\.+/u, "").trim() || "file";
  const ext = extensionOf(base);
  const fits = ext !== "" && BY_EXTENSION[ext] === mime;
  if (fits) return base;
  const usual = Object.entries(BY_EXTENSION).find(([, m]) => m === mime)?.[0] ?? "bin";
  return `${base}.${usual}`;
};

/** Text a computer runs, rather than shows, when asked to open it: macOS's Python Launcher takes a .py. */
const RUNS_WHEN_OPENED: ReadonlySet<string> = new Set(["py", "js"]);

/** The name a file is opened under: safeFileName's, and code that would run opens as text (`tool.py.txt`). */
export const openedFileName = (name: string, mime: string): string => {
  const safe = safeFileName(name, mime);
  return RUNS_WHEN_OPENED.has(extensionOf(safe)) ? `${safe}.txt` : safe;
};

/**
 * The name a download is kept under when `name` is taken, as a browser numbers a second one: `pebble (1).png`. The
 * number goes before the extension; 0 is the name itself.
 */
export const numberedName = (name: string, n: number): string => {
  if (n === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${String(n)})${name.slice(dot)}` : `${name} (${String(n)})`;
};
