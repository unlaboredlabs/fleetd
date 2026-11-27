// An Excel workbook's sheets as rows of text, read from its zip (zip.ts) by range: the workbook's sheet list, its
// shared strings and date styles, then one sheet's rows as they inflate, stopping at the cap. Cells show their
// values as Excel last saved them (a formula's result, not the formula), dates as dates. Pure but for the reads.
import type { Rows } from "./csv";
import { entryText, readEntryText, zipEntries, ZipError, type Ranged, type ZipEntry } from "./zip";

export interface Sheet {
  readonly name: string;
  readonly entry: ZipEntry;
}

export interface Workbook {
  readonly sheets: readonly Sheet[];
  readonly strings: readonly string[];
  /** The cell styles (`s`) that show a number as a date or time. */
  readonly dates: ReadonlySet<number>;
  /** The cell styles that show a number as a percentage, with how many decimals. */
  readonly percents: ReadonlyMap<number, number>;
}

/** Shared strings past this many characters aren't read: a sheet that big shows its cells' numbers only. */
const STRINGS_CAP = 32 * 1024 * 1024;
/** The columns a row shows at most. */
export const MAX_COLUMNS = 500;

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML text as it reads: its entities, and OOXML's `_x000D_` escapes. */
export const xmlText = (s: string): string =>
  s
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (m, e: string) => {
      if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
      return ENTITIES[e] ?? m;
    })
    .replace(/_x([0-9A-Fa-f]{4})_/gu, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/gu)) out[m[1] as string] = xmlText(m[2] as string);
  return out;
};

/** The text of every `<t>` in a string item or an inline string, without its phonetic guide. */
const runs = (xml: string): string => {
  let out = "";
  for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/gu, "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/gu)) out += m[1] as string;
  return xmlText(out);
};

/** The built-in number formats that are dates or times (ECMA-376 18.8.30). */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** A format code without its quoted text, colours and conditions, and escaped characters. */
const bare = (code: string) => code.replace(/"[^"]*"|\[[^\]]*\]|\\./gu, "");

/** Whether a custom format code shows a date or time: a d, m, y, h or s outside its quoted and bracketed parts. */
export const isDateCode = (code: string): boolean => /[dmyhs]/iu.test(bare(code));

/** The decimals a percentage format shows (`0.00%` two), or undefined for a code that isn't one. */
export const percentDecimals = (code: string): number | undefined => {
  const b = bare(code).split(";")[0] ?? "";
  if (!b.includes("%")) return undefined;
  return /\.(0+)/u.exec(b)?.[1]?.length ?? 0;
};

/** The built-in percentage formats (ECMA-376 18.8.30): 9 is `0%`, 10 `0.00%`. */
const PERCENT_FORMATS: ReadonlyMap<number, number> = new Map([
  [9, 0],
  [10, 2],
]);

const resolve = (target: string): string => (target.startsWith("/") ? target.slice(1) : `xl/${target}`).replace(/\/\.\//gu, "/");

export async function openWorkbook(file: Ranged): Promise<Workbook> {
  const entries = await zipEntries(file);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const workbook = byName.get("xl/workbook.xml");
  if (workbook === undefined) throw new ZipError("This isn't a spreadsheet fleetd can read.");
  const rels = byName.get("xl/_rels/workbook.xml.rels");
  const [book, links, strings, styles] = await Promise.all([
    entryText(file, workbook),
    rels === undefined ? "" : entryText(file, rels),
    byName.has("xl/sharedStrings.xml") ? entryText(file, byName.get("xl/sharedStrings.xml") as ZipEntry, STRINGS_CAP) : "",
    byName.has("xl/styles.xml") ? entryText(file, byName.get("xl/styles.xml") as ZipEntry) : "",
  ]);
  const targets = new Map<string, string>();
  for (const m of links.matchAll(/<Relationship\b[^>]*>/gu)) {
    const a = attrs(m[0]);
    if (a.Id !== undefined && a.Target !== undefined) targets.set(a.Id, resolve(a.Target));
  }
  const sheets: Sheet[] = [];
  for (const m of book.matchAll(/<sheet\b[^>]*>/gu)) {
    const a = attrs(m[0]);
    const path = targets.get(a["r:id"] ?? "") ?? `xl/worksheets/sheet${String(sheets.length + 1)}.xml`;
    const entry = byName.get(path);
    if (entry !== undefined && a.state !== "hidden" && a.state !== "veryHidden") sheets.push({ name: a.name ?? `Sheet ${String(sheets.length + 1)}`, entry });
  }
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/gu)) {
    const a = attrs(m[0]);
    custom.set(Number(a.numFmtId), a.formatCode ?? "");
  }
  const dates = new Set<number>();
  const percents = new Map<number, number>();
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/u.exec(styles)?.[1] ?? "";
  let n = 0;
  for (const m of xfs.matchAll(/<xf\b[^>]*>/gu)) {
    const id = Number(attrs(m[0]).numFmtId ?? 0);
    const code = custom.get(id);
    const percent = code === undefined ? PERCENT_FORMATS.get(id) : percentDecimals(code);
    if (percent !== undefined) percents.set(n, percent);
    else if (DATE_FORMATS.has(id) || (code !== undefined && isDateCode(code))) dates.add(n);
    n++;
  }
  return { sheets, strings: [...strings.matchAll(/<si>([\s\S]*?)<\/si>/gu)].map((m) => runs(m[1] as string)), dates, percents };
}

/** A column's letters as its index: A is 0, AA 26. */
export const columnOf = (ref: string): number => {
  let n = 0;
  for (const c of ref) {
    const code = c.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** An Excel date (days since 1899-12-30, the time as its fraction) as it reads: the date, the time, or both. */
export const excelDate = (serial: number): string => {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const day = `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (serial >= 0 && serial < 1) return time;
  return Number.isInteger(serial) ? day : `${day} ${time}`;
};

/** A number as Excel shows it in a general cell: no float noise (0.1 + 0.2 reads 0.3). */
const numberText = (v: string): string => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v;
};

const cellText = (book: Workbook, a: Record<string, string>, body: string): string => {
  const t = a.t;
  if (t === "inlineStr") return runs(/<is>([\s\S]*?)<\/is>/u.exec(body)?.[1] ?? "");
  const v = /<v>([^<]*)<\/v>/u.exec(body)?.[1];
  if (v === undefined) return "";
  if (t === "s") return book.strings[Number(v)] ?? "";
  if (t === "b") return v === "1" ? "TRUE" : "FALSE";
  if (t === "str" || t === "e" || t === "d") return xmlText(v);
  const style = a.s === undefined ? 0 : Number(a.s);
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const percent = book.percents.get(style);
  if (percent !== undefined) return `${(n * 100).toFixed(percent)}%`;
  return book.dates.has(style) ? excelDate(n) : numberText(v);
};

/** One `<row>`'s cells, placed by their column. */
const rowCells = (book: Workbook, xml: string): string[] => {
  const out: string[] = [];
  let next = 0;
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
    const a = attrs(m[1] as string);
    const col = a.r === undefined ? next : columnOf(a.r);
    next = col + 1;
    if (col < 0 || col >= MAX_COLUMNS) continue;
    const text = cellText(book, a, m[2] ?? "");
    if (text === "") continue;
    while (out.length < col) out.push("");
    out[col] = text;
  }
  return out;
};

/** A sheet's first `max` rows, read as its bytes inflate and no further: blank rows between kept, trailing ones not. */
export async function readSheet(file: Ranged, book: Workbook, sheet: Sheet, max: number): Promise<Rows> {
  const rows: string[][] = [];
  let buffer = "";
  let more = false;
  let next = 0;
  const place = (index: number, cells: string[]) => {
    if (index >= max) {
      more = true;
      return;
    }
    while (rows.length < index) rows.push([]);
    rows[index] = cells;
  };
  await readEntryText(file, sheet.entry, (part) => {
    buffer += part;
    let at = 0;
    for (;;) {
      const open = buffer.indexOf("<row", at);
      if (open < 0) break;
      const close = buffer.indexOf(">", open);
      if (close < 0) break;
      // `<rowBreaks>` after the rows is no row.
      if (!/[\s>/]/u.test(buffer[open + 4] ?? "")) {
        at = close + 1;
        continue;
      }
      const tag = buffer.slice(open, close + 1);
      const r = attrs(tag).r;
      const index = r === undefined ? next : Number(r) - 1;
      if (tag.endsWith("/>")) {
        at = close + 1;
        next = index + 1;
        continue;
      }
      const end = buffer.indexOf("</row>", close);
      if (end < 0) break;
      place(index, rowCells(book, buffer.slice(close + 1, end)));
      next = index + 1;
      at = end + "</row>".length;
      if (more) return false;
    }
    buffer = buffer.slice(at);
    return true;
  });
  while (rows.length > 0 && (rows[rows.length - 1] as string[]).length === 0) rows.pop();
  return { rows, more };
}
