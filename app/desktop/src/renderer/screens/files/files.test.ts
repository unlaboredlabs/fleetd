// A chat file shown inside fleetd: which view a file gets, its bytes read in ranges (never the whole file to show a
// name), CSV as a spreadsheet reads it, and an Excel workbook read from its zip by range, stopping at the cap.
import { describe, expect, it } from "vitest";
import { toBase64 } from "../../../shared/base64";
import type { Call } from "../../../shared/contracts";
import { parseDelimited, toTsv } from "./csv";
import { hasHeader, letters, rangeName, selectedText, summary } from "./grid";
import { langForPath } from "../../ui/markdown/highlighter";
import { CODE, showOf, showsInside } from "./kind";
import { fileSource } from "./source";
import { columnOf, excelDate, isDateCode, openWorkbook, percentDecimals, readSheet, xmlText } from "./xlsx";
import { entryText, zipEntries, type Ranged } from "./zip";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("showOf", () => {
  it("shows tables, sheets, notes, JSON, PDFs, text and code inside; Word, slides and zips in their app", () => {
    expect(showOf("temps.csv", "text/csv")).toEqual({ as: "table", sep: "," });
    expect(showOf("temps.tsv", "text/plain")).toEqual({ as: "table", sep: "\t" });
    expect(showOf("q3.xlsx", XLSX)).toEqual({ as: "sheet" });
    expect(showOf("summary.md", "text/plain")).toEqual({ as: "markdown" });
    expect(showOf("hub.json", "text/plain")).toEqual({ as: "json" });
    expect(showOf("dummy.pdf", "application/pdf")).toEqual({ as: "pdf" });
    expect(showOf("main.py", "text/plain")).toEqual({ as: "code", lang: "python" });
    expect(showOf("build.log", "text/plain")).toEqual({ as: "text" });
    expect(showOf("chart.png", "image/png")).toEqual({ as: "image" });
    expect(showsInside("notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
    expect(showsInside("all.zip", "application/zip")).toBe(false);
  });
  it("names code's language as the highlighter does", () => {
    for (const [ext, lang] of Object.entries(CODE)) expect(langForPath(`a.${ext}`)).toBe(lang);
    // And it knows every extension the highlighter does that the workspace takes as text.
    for (const ext of ["py", "js", "ts", "rs", "go", "sql", "yaml", "yml", "toml"]) expect(CODE[ext]).toBe(langForPath(`a.${ext}`));
  });
});

describe("parseDelimited", () => {
  it("reads quoted fields with separators, quotes and line breaks, and drops a BOM and the final break", () => {
    const text = '﻿city,note\r\n"Paris, FR","said ""hi"""\n"Oslo","two\nlines"\n';
    expect(parseDelimited(text, ",", 100)).toEqual({ rows: [["city", "note"], ["Paris, FR", 'said "hi"'], ["Oslo", "two\nlines"]], more: false });
  });
  it("stops at the cap, and drops a cut file's half line", () => {
    expect(parseDelimited("a\nb\nc\n", ",", 2)).toEqual({ rows: [["a"], ["b"]], more: true });
    expect(parseDelimited("a\tb\nc\td\ne\tf", "\t", 100, true)).toEqual({ rows: [["a", "b"], ["c", "d"]], more: true });
  });
  it("copies cells as a spreadsheet pastes them", () => {
    expect(toTsv([["a", "b\tc"], ["say \"x\"", ""]])).toBe('a\t"b\tc"\n"say ""x"""\t');
  });
});

/** A call that serves one file as the workspace does, counting the bytes it sent. */
const serving = (bytes: Uint8Array, name = "big.csv", mime = "text/csv", ranges = true) => {
  const asked: { offset: number | undefined; length: number | undefined }[] = [];
  const call = ((_tool: string, input: { offset?: number; length?: number }) => {
    asked.push({ offset: input.offset, length: input.length });
    const at = input.offset ?? 0;
    const piece = ranges ? bytes.subarray(at, at + (input.length ?? 524288)) : bytes;
    return Promise.resolve({ ok: true, output: { attachmentId: "F1", name, mime, bytes: bytes.length, dataB64: toBase64(piece), ...(ranges ? { offset: at } : {}) } });
  }) as unknown as Call;
  const sent = () => asked.reduce((n, a) => n + (ranges ? Math.min(a.length ?? 524288, Math.max(0, bytes.length - (a.offset ?? 0))) : bytes.length), 0);
  return { call, asked, sent };
};

const REF = { machineId: "devbox", projectId: "p1" };
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe("fileSource", () => {
  it("reads only the ranges asked for, in pieces a call carries, never the whole file", async () => {
    const bytes = new Uint8Array(6 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
    const s = serving(bytes);
    const src = fileSource(s.call, REF, "F1");
    const head = await src.head();
    expect(head).toMatchObject({ name: "big.csv", mime: "text/csv", size: bytes.length });
    const tail = await src.range(bytes.length - 1000, 5000);
    expect(same(tail, bytes.subarray(bytes.length - 1000))).toBe(true);
    const mid = await src.range(1_000_000, 1_200_000);
    expect(same(mid, bytes.subarray(1_000_000, 2_200_000))).toBe(true);
    expect(Math.max(...s.asked.map((a) => a.length ?? 0))).toBeLessThanOrEqual(524288);
    expect(s.sent()).toBeLessThan(1.6 * 1024 * 1024);
  });
  it("keeps the whole file an older workspace sends, and cuts every range from it", async () => {
    const bytes = new Uint8Array(3000).map((_, i) => i % 7);
    const s = serving(bytes, "a.csv", "text/csv", false);
    const src = fileSource(s.call, REF, "F1");
    expect(await src.range(2000, 10)).toEqual(bytes.subarray(2000, 2010));
    expect(s.asked).toHaveLength(1);
  });
});

// A zip as Excel writes one: deflated entries (stored for `stored`), a central directory and its end record.
const deflate = async (data: Uint8Array) => new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
const zip = async (files: Record<string, string>, stored: readonly string[] = []): Promise<Uint8Array> => {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let at = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const method = stored.includes(name) ? 0 : 8;
    const data = method === 0 ? raw : await deflate(raw);
    const n = enc.encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, method, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, n.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(10, method, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, raw.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, at, true);
    parts.push(new Uint8Array(local.buffer), n, data);
    central.push(new Uint8Array(c.buffer), n);
    at += 30 + n.length + data.length;
  }
  const dirLength = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, dirLength, true);
  end.setUint32(16, at, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const ranged = (bytes: Uint8Array) => {
  let read = 0;
  const file: Ranged = {
    size: bytes.length,
    range: (offset, length) => {
      const piece = bytes.subarray(offset, Math.min(bytes.length, offset + length));
      read += piece.length;
      return Promise.resolve(piece);
    },
  };
  return { file, read: () => read };
};

const sheetXml = (rows: string) => `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData><rowBreaks count="1"><brk id="3"/></rowBreaks></worksheet>`;

const BOOK = {
  "[Content_Types].xml": "<Types/>",
  "xl/workbook.xml": '<workbook><sheets><sheet name="Temps &amp; rain" sheetId="1" r:id="rId1"/><sheet name="Old" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Notes" sheetId="3" r:id="rId3"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="ws" Target="/xl/worksheets/sheet3.xml"/></Relationships>',
  "xl/sharedStrings.xml": '<sst><si><t>City</t></si><si><t>Day</t></si><si><r><t>Pa</t></r><r><t>ris</t></r><rPh><t>パ</t></rPh></si><si><t xml:space="preserve">Line_x000D_ two</t></si></sst>',
  "xl/styles.xml":
    '<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="2"/><xf numFmtId="9"/><xf numFmtId="165"/></cellXfs></styleSheet>',
  "xl/worksheets/sheet1.xml": sheetXml(
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Max &lt;°C&gt;</t></is></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45992</v></c><c r="C2"><f>A1+1</f><v>0.30000000000000004</v></c></row>' +
      '<row r="3" spans="1:3"/>' +
      '<row r="4"><c r="A4" t="s"><v>3</v></c><c r="D4" t="b"><v>1</v></c><c r="E4" t="e"><v>#DIV/0!</v></c><c r="F4" s="3"><v>0.13</v></c><c r="G4" s="4"><v>0.1234</v></c></row>',
  ),
  "xl/worksheets/sheet2.xml": sheetXml(""),
  "xl/worksheets/sheet3.xml": sheetXml('<row r="2"><c r="B2" t="str"><v>hi</v></c></row>'),
};

describe("zip and xlsx", () => {
  it("lists a zip's entries from its end and reads one, stored or deflated", async () => {
    const { file } = ranged(await zip({ "a.txt": "stored text", "b.txt": "deflated text ".repeat(50) }, ["a.txt"]));
    const entries = await zipEntries(file);
    expect(entries.map((e) => [e.name, e.method])).toEqual([
      ["a.txt", 0],
      ["b.txt", 8],
    ]);
    expect(await entryText(file, entries[0] as never)).toBe("stored text");
    expect(await entryText(file, entries[1] as never)).toBe("deflated text ".repeat(50));
  });

  it("reads a workbook's visible sheets, shared strings, dates, numbers, booleans and errors", async () => {
    const { file } = ranged(await zip(BOOK));
    const book = await openWorkbook(file);
    expect(book.sheets.map((s) => s.name)).toEqual(["Temps & rain", "Notes"]);
    const first = await readSheet(file, book, book.sheets[0] as never, 100);
    expect(first).toEqual({
      rows: [["City", "Day", "Max <°C>"], ["Paris", "2025-12-01", "0.3"], [], ["Line\r two", "", "", "TRUE", "#DIV/0!", "13%", "12.3%"]],
      more: false,
    });
    expect(await readSheet(file, book, book.sheets[1] as never, 100)).toEqual({ rows: [[], ["", "hi"]], more: false });
  });

  it("stops reading a big sheet at the cap, long before its end", async () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => `<row r="${String(i + 1)}"><c r="A${String(i + 1)}"><v>${String(i * 7919 + (i % 13))}</v></c><c r="B${String(i + 1)}" t="inlineStr"><is><t>row ${String(i)} ${"x".repeat(i % 40)}</t></is></c></row>`).join("");
    const bytes = await zip({ ...BOOK, "xl/worksheets/sheet1.xml": sheetXml(rows) });
    const { file, read } = ranged(bytes);
    const book = await openWorkbook(file);
    const got = await readSheet(file, book, book.sheets[0] as never, 100);
    expect(got.rows).toHaveLength(100);
    expect(got.more).toBe(true);
    expect(got.rows[99]).toEqual(["783989", `row 99 ${"x".repeat(19)}`]);
    expect(bytes.length).toBeGreaterThan(2_000_000);
    expect(read()).toBeLessThan(bytes.length / 3);
  });

  it("reads columns, dates and XML text as Excel means them", () => {
    expect([columnOf("A1"), columnOf("Z9"), columnOf("AA10"), columnOf("XFD1")]).toEqual([0, 25, 26, 16383]);
    expect(excelDate(45992)).toBe("2025-12-01");
    expect(excelDate(45992.5)).toBe("2025-12-01 12:00");
    expect(excelDate(0.75)).toBe("18:00");
    expect(isDateCode("dd/mm/yyyy")).toBe(true);
    expect(isDateCode('#,##0.00 "days"')).toBe(false);
    expect(isDateCode("[Red]0.00")).toBe(false);
    expect([percentDecimals("0%"), percentDecimals("0.00%;[Red]-0.00%"), percentDecimals("0.00")]).toEqual([0, 2, undefined]);
    expect(xmlText("a &amp; b &#233; &#x41;")).toBe("a & b é A");
  });
});

describe("grid", () => {
  const rows = [
    ["city", "max_c", "rain"],
    ["Oslo", "1,200", "3"],
    ["Lisbon", "7.5", ""],
  ];
  it("names columns and ranges as a spreadsheet does", () => {
    expect([letters(0), letters(25), letters(26), letters(701), letters(702)]).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    expect(rangeName({ anchor: [2, 2], focus: [1, 1] })).toBe("B2:C3");
    expect(rangeName({ anchor: [0, 0], focus: [0, 0] })).toBe("A1");
  });
  it("holds a first row of names, never one of numbers", () => {
    expect(hasHeader(rows)).toBe(true);
    expect(hasHeader([["1", "2"], ["3", "4"]])).toBe(false);
    expect(hasHeader([["only"]])).toBe(false);
  });
  it("sums and averages the numbers selected, and copies them as cells", () => {
    expect(summary(rows, { anchor: [1, 1], focus: [2, 2] })).toEqual({ cells: 4, sum: 1210.5, average: 1210.5 / 3 });
    expect(summary(rows, { anchor: [0, 0], focus: [1, 0] })).toEqual({ cells: 2 });
    expect(selectedText(rows, { anchor: [1, 0], focus: [2, 2] })).toBe("Oslo\t1,200\t3\nLisbon\t7.5\t");
  });
});
