// Base64 and UTF-8 by hand: Hermes may have no TextDecoder or Buffer. Pure, so the package exports the push reader that
// uses them (pushPayload.ts); seal.ts gives them on to its importers.
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

export const fromBase64 = (text: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

/** UTF-8 bytes of a string, by hand as `utf8` reads them. */
export const utf8Encode = (text: string): Uint8Array => {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
};

/** Strict UTF-8, or null: Hermes may have no TextDecoder. */
export const utf8 = (bytes: Uint8Array): string | null => {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    const n = b < 0x80 ? 0 : b >> 5 === 6 ? 1 : b >> 4 === 14 ? 2 : b >> 3 === 30 ? 3 : -1;
    if (n < 0 || i + n >= bytes.length) return null;
    let cp = n === 0 ? b : b & (0x3f >> n);
    for (let k = 1; k <= n; k++) {
      const c = bytes[i + k]!;
      if (c >> 6 !== 2) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if ((n === 1 && cp < 0x80) || (n === 2 && cp < 0x800) || (n === 3 && cp < 0x10000) || cp > 0x10ffff || (cp >= 0xd800 && cp < 0xe000)) return null;
    out += String.fromCodePoint(cp);
    i += n + 1;
  }
  return out;
};
