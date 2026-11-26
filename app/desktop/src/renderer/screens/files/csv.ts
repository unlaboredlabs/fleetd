// A CSV or TSV file's rows, as spreadsheets read them (RFC 4180): fields in double quotes may hold the separator, line
// breaks and "" for a quote; a byte-order mark and the last line's break are dropped. Pure.

export interface Rows {
  readonly rows: readonly (readonly string[])[];
  /** Rows past the cap, or past the bytes read: there are more than shown. */
  readonly more: boolean;
}

/**
 * The first `max` rows of `text`. `cut`: the text is the file's start, not all of it, so its last line may be half of
 * one and is dropped.
 */
export function parseDelimited(text: string, sep: string, max: number, cut = false): Rows {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  while (i < n) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      endRow();
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (rows.length > max) return { rows: rows.slice(0, max), more: true };
    } else field += c;
    i++;
  }
  // The text's last line: whole unless the text was cut, and nothing at all after a final line break.
  if (cut) return { rows: rows.slice(0, max), more: true };
  if (field !== "" || row.length > 0) endRow();
  return { rows: rows.slice(0, max), more: rows.length > max };
}

/** A grid's cells as text to paste into a spreadsheet: tabs between cells, a line per row, quoted where needed. */
export function toTsv(rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => (/[\t\n\r"]/u.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return rows.map((r) => r.map(cell).join("\t")).join("\n");
}
