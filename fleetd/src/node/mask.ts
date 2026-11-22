// Masking a project's secret variables in what its agents' sessions report: every
// exact occurrence of a secret's value, its standard and URL-safe base64, its percent-encoding and its form encoding
// becomes `***NAME***` before the node keeps or sends any of it. A value of several lines is also masked line by
// line (each whole line of MIN_LINE characters or more, PEM armor excepted, and the line without its `=` padding, as
// `cut -d=` leaves it). Values under MIN_LEN are left alone. A private key's PEM block becomes HIDDEN whoever's it is.
export const MIN_LEN = 4;
export const MIN_LINE = 8;
export const HIDDEN = "[secret hidden]";

const pemArmor = (line: string) => (line.startsWith("-----BEGIN ") || line.startsWith("-----END ")) && line.endsWith("-----");
// A line break as printed, or as JSON escapes it.
const NL = String.raw`(?:\r?\n|(?:\\r)?\\n)`;
// What a tool may print before each line: indentation (a YAML block), a diff's `-` or `+`, a line number (`cat -n`,
// claude's Read with its arrow, `grep -n`), a file's name and line (`grep -rn`). Its whitespace runs never meet, so a
// long one is matched in linear time.
const WS = String.raw`(?:[ \t]|\\t)*`;
const MARK = String.raw`(?:[-+]|\d+(?:→|\t|\\t|:)|[^\s:"\\]+:\d+[:-])`;
const PREFIX = String.raw`${WS}(?:${MARK}${WS})?`;
const B64 = "[A-Za-z0-9+/=]";
/** A private key's PEM block: its header, the base64 lines after it (the first of 16 characters or more, so prose
 * that names the header isn't one), each after a line break and what a tool prints before it, or after spaces where
 * `echo $KEY` joined them (16 characters or more there, or the last before the END line), and its END line if the
 * text has it. */
const PRIVATE_KEY = new RegExp(
  [
    String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[ \t]+|${NL}${PREFIX})${B64}{16,}`,
    String.raw`(?:${NL}${PREFIX}${B64}+|[ \t]+${B64}{16,}|[ \t]+${B64}+(?=[ \t]+-----END ))*`,
    String.raw`(?:(?:${NL}${PREFIX}|[ \t]+)-----END [A-Z0-9 ]*PRIVATE KEY-----)?`,
  ].join(""),
  "g",
);
/** What could still become a private key's block as more text comes: its header so far, or the header with no END
 * after it and, after it, nothing yet, a line's prefix or a base64 run reaching the text's end, or a base64 run of 16
 * characters or more. */
const OPENING = new RegExp(
  String.raw`^-----BEGIN (?:[A-Z0-9 ]*-{0,5}|[A-Z0-9 ]*PRIVATE KEY-----(?![\s\S]*-----END [A-Z0-9 ]*PRIVATE KEY-----)(?:\s|\\[rnt])*(?:(?:${MARK}${WS})?(?:${B64}{16,}[\s\S]*|${B64}*)|[^\s:"\\]+(?::\d*)?)\\?)$`,
);
const BEGIN = "-----BEGIN ";
const utf8 = (s: string) => Buffer.from(s, "utf8");

const isAlnum = (b: number) => (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
function encodeBytes(value: string, keep: string, space?: string): string {
  let out = "";
  for (const b of utf8(value)) {
    if (space !== undefined && b === 32) out += space;
    else if (isAlnum(b) || keep.includes(String.fromCharCode(b))) out += String.fromCharCode(b);
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** `value` as HTML text or an attribute shows it. */
function htmlEscaped(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export class Masker {
  /** Each form and what it becomes, longest first. */
  readonly patterns: [form: string, shown: string][] = [];

  /**
   * `new Masker` plus the forms a web page or a recording's trace shows a value in: JSON- and HTML-escaped, as a
   * page's script posts it (`+` for a space), and its base64 inside a longer encoded string at any of the three byte
   * alignments (the characters that depend only on the value). For screens' recordings, where a page may echo or
   * encode what was typed into it.
   */
  static thorough(secrets: [name: string, value: string][] = []): Masker {
    const masker = new Masker(secrets);
    for (const [name, value] of secrets) {
      const bytes = utf8(value);
      if (bytes.length < MIN_LEN) continue;
      const shown = `***${name}***`;
      const forms = [JSON.stringify(value).slice(1, -1), htmlEscaped(value), encodeBytes(value, "-_.!~*'()").replaceAll("%20", "+")];
      for (let prefix = 0; prefix < 3; prefix++) {
        const encoded = Buffer.concat([Buffer.alloc(prefix), bytes]).toString("base64");
        // Character i covers bits 6i..6i+6; those wholly inside the value's bits depend on it alone.
        const start = Math.ceil((8 * prefix) / 6);
        const end = Math.floor((8 * (prefix + bytes.length)) / 6);
        if (end >= start + 6) {
          const inner = encoded.slice(start, end);
          forms.push(inner, inner.replace(/\+/g, "-").replace(/\//g, "_"));
        }
      }
      for (const form of forms) {
        if (utf8(form).length >= MIN_LEN && !masker.patterns.some(([p]) => p === form)) masker.patterns.push([form, shown]);
      }
    }
    masker.#sort();
    return masker;
  }

  constructor(secrets: [name: string, value: string][] = []) {
    for (const [name, value] of secrets) {
      if (utf8(value).length < MIN_LEN) continue;
      const shown = `***${name}***`;
      const b64 = utf8(value).toString("base64");
      const url = b64.replace(/\+/g, "-").replace(/\//g, "_");
      const forms = [
        value,
        b64,
        url,
        url.replace(/=+$/, ""),
        encodeBytes(value, "-_.!~*'()"),
        encodeBytes(value, "*-._", "+"),
        ...value
          .split(/\r?\n/)
          .map((l) => l.trim())
          .flatMap((l) => [l, l.replace(/=+$/, "")])
          .filter((l) => utf8(l).length >= MIN_LINE && !pemArmor(l) && l.length < value.length),
      ];
      for (const form of forms) if (!this.patterns.some(([p]) => p === form)) this.patterns.push([form, shown]);
    }
    this.#sort();
  }

  #sort() {
    this.patterns.sort((a, b) => utf8(b[0]).length - utf8(a[0]).length);
  }

  /** This masker with `other`'s forms too. */
  and(other: Masker): Masker {
    for (const [p, s] of other.patterns) if (!this.patterns.some(([q]) => q === p)) this.patterns.push([p, s]);
    this.#sort();
    return this;
  }

  get empty(): boolean {
    return this.patterns.length === 0;
  }

  text(text: string): string {
    let out = text;
    for (const [pattern, shown] of this.patterns) if (out.includes(pattern)) out = out.split(pattern).join(shown);
    return out.includes("PRIVATE KEY-----") ? out.replace(PRIVATE_KEY, HIDDEN) : out;
  }

  /** Every string in a JSON value, object keys included. */
  value<T>(value: T): T {
    if (typeof value === "string") return this.text(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.value(v)) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.text(k), this.value(v)])) as T;
    return value;
  }

  /** How many characters at the end of `text` could start a form not yet complete: live text holds them back. */
  held(text: string): number {
    // A private key's block not yet closed, or what could still become its header.
    const open = text.lastIndexOf(BEGIN);
    if (open >= 0 && OPENING.test(text.slice(open))) return text.length - open;
    let cut = text.length;
    for (let at = Math.max(0, text.length - (BEGIN.length - 1)); at < cut; at++) if (BEGIN.startsWith(text.slice(at))) cut = at;
    const longest = this.patterns[0]?.[0].length ?? 0;
    for (let at = Math.max(0, text.length - (longest - 1)); at < cut; at++) {
      const tail = text.slice(at);
      if (this.patterns.some(([p]) => p.length > tail.length && p.startsWith(tail))) cut = at;
    }
    // Never inside a form or a key's block whole in the text: the cut goes back to its start, so neither half goes out
    // unmasked (a value's end can be another form's start).
    const spans: [number, number][] = [...text.matchAll(PRIVATE_KEY)].map((m) => [m.index, m.index + m[0].length]);
    for (const [p] of this.patterns) for (let at = text.indexOf(p); at >= 0; at = text.indexOf(p, at + 1)) spans.push([at, at + p.length]);
    for (let moved = true; moved; ) {
      moved = false;
      for (const [start, end] of spans)
        if (start < cut && cut < end) {
          cut = start;
          moved = true;
        }
    }
    return text.length - cut;
  }
}

/**
 * What a screen's recording scrubs: its agent session's secrets,
 * and each value filled into it, in every form a page or a trace may show them (`Masker.thorough`). A value too short
 * to mask wherever it appears (a card's 3-digit code, under MIN_LEN) is masked where it is a field's value: a whole
 * JSON string, and an HTML `value` attribute.
 */
export class Scrub {
  private readonly masker: Masker;
  private readonly short: [shown: string, value: string][];

  constructor(secrets: [name: string, value: string][] = []) {
    this.masker = Masker.thorough(secrets);
    this.short = secrets.filter(([, v]) => v !== "" && utf8(v).length < MIN_LEN).map(([name, v]) => [`***${name}***`, v]);
  }

  text(text: string): string {
    let out = this.masker.text(text);
    for (const [shown, value] of this.short) {
      if (out === value) return shown;
      for (const [open, close] of [['"', '"'], ["'", "'"], ["&quot;", "&quot;"], ['\\"', '\\"']]) {
        out = out.replaceAll(`value=${open}${value}${close}`, `value=${open}${shown}${close}`);
      }
    }
    return out;
  }

  /** Every string in a JSON value, object keys included (the short values only where they are a whole value). */
  value<T>(value: T): T {
    const masked = this.masker.value(value);
    if (this.short.length === 0) return masked;
    const shortOnly = (v: unknown): unknown => {
      if (typeof v === "string") return this.text(v);
      if (Array.isArray(v)) return v.map(shortOnly);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shortOnly(x)]));
      return v;
    };
    return shortOnly(masked) as T;
  }
}
