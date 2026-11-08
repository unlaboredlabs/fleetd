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

export class Masker {
  /** Each form and what it becomes, longest first. */
  readonly patterns: [form: string, shown: string][] = [];

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
