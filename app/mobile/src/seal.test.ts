// The sealed box and UTF-8 by hand, as Hermes has neither libsodium nor (always) TextEncoder and TextDecoder.
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { keyPairOf, openSealed, seal, utf8, utf8Encode } from "./seal";

describe("UTF-8", () => {
  it("encodes as TextEncoder does, and reads back", () => {
    for (const text of ["", "plain", "pässwörd", "€ 12", "😀 emoji", "日本語", "a\u0000b"]) {
      expect(utf8Encode(text)).toEqual(new TextEncoder().encode(text));
      expect(utf8(utf8Encode(text))).toBe(text);
    }
  });
});

describe("a sealed box", () => {
  it("opens only with its recipient's key", () => {
    const to = keyPairOf(nacl.randomBytes(32));
    const other = keyPairOf(nacl.randomBytes(32));
    const box = seal(utf8Encode('{"value":"s3cret"}'), to.publicKey, keyPairOf(nacl.randomBytes(32)));
    expect(utf8(openSealed(box, to)!)).toBe('{"value":"s3cret"}');
    expect(openSealed(box, other)).toBeNull();
    const tampered = box.slice();
    tampered[tampered.length - 1]! ^= 1;
    expect(openSealed(tampered, to)).toBeNull();
  });
});
