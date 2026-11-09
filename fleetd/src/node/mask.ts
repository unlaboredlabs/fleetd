// Masking a project's secret variables in what its agents' sessions report (crates/fleetd/src/node/mask.rs): every
// exact occurrence of a secret's value, its standard and URL-safe base64, its percent-encoding and its form encoding
// becomes `***NAME***` before the node keeps or sends any of it. A value of several lines is also masked line by
// line (each whole line of MIN_LINE characters or more, PEM armor excepted). Values under MIN_LEN are left alone.
export const MIN_LEN = 4;
export const MIN_LINE = 8;

const pemArmor = (line: string) => (line.startsWith("-----BEGIN ") || line.startsWith("-----END ")) && line.endsWith("-----");
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
    return out;
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
    const longest = this.patterns[0]?.[0].length ?? 0;
    for (let at = Math.max(0, text.length - (longest - 1)); at < text.length; at++) {
      const tail = text.slice(at);
      if (this.patterns.some(([p]) => p.length > tail.length && p.startsWith(tail))) return text.length - at;
    }
    return 0;
  }
}

/**
 * What a screen's recording scrubs (crates/fleetd/src/node/browser/record.rs `Scrub`): its agent session's secrets,
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
