// The text of an Office file a person sent (.docx, .xlsx, .pptx), which a lead's Read can't open:
// a Word document's paragraphs, an Excel workbook's sheets as CSV, a
// PowerPoint deck's slides. The hub writes it beside the file (attachments.ts `place`). Read from the file's zip by hand
// (stored or deflated entries only), and bounded however the file is built: each entry inflates to at most ENTRY_MAX (zip.ts) and
// the text stops at TEXT_MAX (UTF-8 bytes, as Rust counts).
import type { AttachmentMime } from "../../shared/contracts.ts";
import { DOCX, PPTX, XLSX } from "./mime.ts";
import { Zip } from "./zip.ts";

/** The most text written for one file. */
export const TEXT_MAX = 4 * 1024 * 1024;

/** The file's text, or undefined when it isn't an Office file or holds none. */
export async function officeText(mime: AttachmentMime, bytes: Uint8Array): Promise<string | undefined> {
  const zip = Zip.open(bytes);
  if (!zip) return undefined;
  let out: Out;
  if (mime === DOCX) {
    const doc = await zip.read("word/document.xml");
    if (doc === undefined) return undefined;
    out = paragraphs(doc);
  } else if (mime === PPTX) out = await slides(zip);
  else if (mime === XLSX) out = await sheets(zip);
  else return undefined;
  let text = out.text();
  if (text.trim() === "") return undefined;
  if (out.bytes > TEXT_MAX) {
    const utf8 = new TextEncoder().encode(text);
    let cut = TEXT_MAX;
    while (cut > 0 && (utf8[cut]! & 0xc0) === 0x80) cut--;
    text = `${new TextDecoder().decode(utf8.subarray(0, cut))}\n[cut: the rest of the file's text is longer than fleetd writes]\n`;
  }
  return text;
}

/** Text built up in pieces, with its UTF-8 length kept as it grows. */
class Out {
  private readonly parts: string[] = [];
  bytes = 0;

  push(s: string): void {
    if (!s) return;
    this.parts.push(s);
    this.bytes += Buffer.byteLength(s);
  }

  text(): string {
    return this.parts.join("");
  }
}

/** One piece of XML: a tag (its name without a prefix, and its attributes as written), a closing tag, or text. */
type Xml = { open: string; attrs: string } | { close: string } | { text: string };

/** The tags and text of an XML document, in order: enough to read Office's own XML, never a general parser. */
function* xml(doc: string): Generator<Xml> {
  let at = 0;
  while (at < doc.length) {
    if (doc[at] === "<") {
      const end = doc.indexOf(">", at + 1);
      if (end < 0) return;
      const tag = doc.slice(at + 1, end);
      at = end + 1;
      if (tag.startsWith("?") || tag.startsWith("!")) continue;
      if (tag.startsWith("/")) {
        yield { close: local(tag.slice(1).trim()) };
        continue;
      }
      const body = tag.endsWith("/") ? tag.slice(0, -1) : tag;
      // A self-closing tag (`<w:tab/>`) is an open one with no close: what matters is where it is.
      const space = body.search(/\s/);
      yield space < 0 ? { open: local(body), attrs: "" } : { open: local(body.slice(0, space)), attrs: body.slice(space + 1) };
      continue;
    }
    const next = doc.indexOf("<", at);
    const end = next < 0 ? doc.length : next;
    yield { text: doc.slice(at, end) };
    at = end;
  }
}

function local(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

const isOpen = (p: Xml, name: string): p is { open: string; attrs: string } => "open" in p && p.open === name;
const isClose = (p: Xml, name: string) => "close" in p && p.close === name;

function attr(attrs: string, key: string): string | undefined {
  let rest = attrs;
  for (;;) {
    const at = rest.indexOf(key);
    if (at < 0) return undefined;
    const beforeOk = at === 0 || /[\s:]$/.test(rest.slice(0, at));
    const after = rest.slice(at + key.length).trimStart();
    if (beforeOk && after.startsWith("=")) {
      const value = after.slice(1).trimStart();
      if (value === "") return undefined;
      const quote = value[0]!;
      const inner = value.slice(1);
      const end = inner.indexOf(quote);
      return end < 0 ? undefined : inner.slice(0, end);
    }
    rest = rest.slice(at + key.length);
  }
}

/** Text with XML's entities read: `&amp;`, `&lt;`, `&#233;`. */
function unescape(text: string): string {
  let out = "";
  let rest = text;
  for (;;) {
    const at = rest.indexOf("&");
    if (at < 0) break;
    out += rest.slice(0, at);
    const after = rest.slice(at + 1);
    const end = after.indexOf(";");
    if (end < 0 || end > 10) {
      out += "&";
      rest = after;
      continue;
    }
    const c = entity(after.slice(0, end));
    if (c === undefined) {
      out += "&";
      rest = after;
    } else {
      out += c;
      rest = after.slice(end + 1);
    }
  }
  return out + rest;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function entity(e: string): string | undefined {
  if (e in NAMED) return NAMED[e];
  let code: number | undefined;
  if (e.startsWith("#x") && /^\+?[0-9a-fA-F]+$/.test(e.slice(2))) code = parseInt(e.slice(2), 16);
  else if (e.startsWith("#") && /^\+?[0-9]+$/.test(e.slice(1))) code = parseInt(e.slice(1), 10);
  if (code === undefined || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  return String.fromCodePoint(code);
}

/** A Word document's or a slide's text: each paragraph a line, a table's cells split by tabs. */
function paragraphs(doc: string): Out {
  const out = new Out();
  let inText = false;
  for (const p of xml(doc)) {
    if (isOpen(p, "t")) inText = true;
    else if (isClose(p, "t")) inText = false;
    else if ("text" in p && inText) out.push(unescape(p.text));
    else if (isOpen(p, "tab") || isClose(p, "tc")) out.push("\t");
    else if (isOpen(p, "br") || isClose(p, "p") || isClose(p, "tr")) out.push("\n");
    if (out.bytes > TEXT_MAX) break;
  }
  return out;
}

/** A deck's slides in order, each under its number. */
async function slides(zip: Zip): Promise<Out> {
  const numbers = zip
    .names()
    .map((n) => /^ppt\/slides\/slide(\+?\d+)\.xml$/.exec(n)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .filter((n) => n <= 0xffff_ffff)
    .sort((a, b) => a - b);
  const out = new Out();
  for (const n of numbers) {
    const doc = await zip.read(`ppt/slides/slide${n}.xml`);
    if (doc === undefined) continue;
    out.push(`## Slide ${n}\n\n${paragraphs(doc).text().trimEnd()}\n\n`);
    if (out.bytes > TEXT_MAX) break;
  }
  return out;
}

/** A cell's column from its reference (`C7` is 2), counting from 0. */
function column(reference: string): number {
  let n = 0;
  for (const c of reference) {
    if (!/[A-Za-z]/.test(c)) break;
    n = n * 26 + (c.toUpperCase().charCodeAt(0) - 65 + 1);
  }
  return Math.max(0, n - 1);
}

const csvCell = (cell: string) => (/[,"\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);

/** A workbook's sheets in its own order, each under its name as CSV. */
async function sheets(zip: Zip): Promise<Out> {
  // The shared strings, which most text cells name by index.
  const shared: string[] = [];
  const strings = await zip.read("xl/sharedStrings.xml");
  if (strings !== undefined) {
    let inText = false;
    for (const p of xml(strings)) {
      if (isOpen(p, "si")) shared.push("");
      else if (isOpen(p, "t")) inText = true;
      else if (isClose(p, "t")) inText = false;
      else if ("text" in p && inText && shared.length > 0) shared[shared.length - 1] += unescape(p.text);
    }
  }
  // Each sheet's name and file, by the workbook and its relationships.
  const rels: [string, string][] = [];
  const relsDoc = await zip.read("xl/_rels/workbook.xml.rels");
  if (relsDoc !== undefined) {
    for (const p of xml(relsDoc)) {
      if (!isOpen(p, "Relationship")) continue;
      const id = attr(p.attrs, "Id");
      const target = attr(p.attrs, "Target");
      if (id !== undefined && target !== undefined) rels.push([id, target]);
    }
  }
  const listed: [string, string][] = [];
  const book = await zip.read("xl/workbook.xml");
  if (book !== undefined) {
    for (const p of xml(book)) {
      if (!isOpen(p, "sheet")) continue;
      const id = attr(p.attrs, "r:id") ?? attr(p.attrs, "id");
      if (id === undefined) continue;
      const rel = rels.find(([r]) => r === id);
      if (!rel) continue;
      const target = rel[1].replace(/^\/+/, "").replace(/^(xl\/)+/, "");
      const name = attr(p.attrs, "name");
      if (name === undefined) continue;
      listed.push([unescape(name), `xl/${target}`]);
    }
  }
  const out = new Out();
  for (const [name, path] of listed) {
    const doc = await zip.read(path);
    if (doc === undefined) continue;
    out.push(`## Sheet: ${name}\n\n`);
    let row: string[] = [];
    let col = 0;
    let kind = "";
    let value = "";
    let inValue = false;
    for (const p of xml(doc)) {
      if (isOpen(p, "row")) row = [];
      else if (isClose(p, "row")) out.push(`${row.map(csvCell).join(",")}\n`);
      else if (isOpen(p, "c")) {
        const r = attr(p.attrs, "r");
        col = r === undefined ? row.length : column(r);
        kind = attr(p.attrs, "t") ?? "";
        value = "";
      } else if (isOpen(p, "v") || isOpen(p, "t")) inValue = true;
      else if (isClose(p, "v") || isClose(p, "t")) inValue = false;
      else if ("text" in p && inValue) value += unescape(p.text);
      else if (isClose(p, "c")) {
        let cell: string;
        if (kind === "s") {
          const i = /^\+?\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
          cell = shared[i] ?? "";
        } else if (kind === "b") cell = value === "1" ? "TRUE" : "FALSE";
        else cell = value;
        // Rows hold a few thousand columns at most: one past that is a broken reference.
        if (col < 16_384) {
          while (row.length <= col) row.push("");
          row[col] = cell;
        }
      }
      if (out.bytes > TEXT_MAX) return out;
    }
    out.push("\n");
  }
  return out;
}
