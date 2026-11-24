// A login's verification codes on the phone: RFC 6238's vectors, the setup keys the hub refuses refused here too, and
// a link read without URL.searchParams, which Hermes lacks.
import { describe, expect, it } from "vitest";
import { groupCode, totpKeyProblem, totpNow, totpParse } from "./totp";

// RFC 6238's test keys: "12345678901234567890" for SHA-1, 32 and 64 bytes of it for SHA-256 and SHA-512, in base32.
const SHA1_KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SHA256_KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
const SHA512_KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";

describe("codes", () => {
  it("makes RFC 6238's codes from a link, each algorithm", () => {
    const at = (key: string, alg: string, s: number) => totpNow(`otpauth://totp/x?secret=${key}&digits=8&algorithm=${alg}`, s * 1000)?.code;
    expect(at(SHA1_KEY, "SHA1", 59)).toBe("94287082");
    expect(at(SHA256_KEY, "SHA256", 59)).toBe("46119246");
    expect(at(SHA512_KEY, "SHA512", 59)).toBe("90693936");
    expect(at(SHA1_KEY, "SHA1", 1_111_111_109)).toBe("07081804");
    expect(at(SHA1_KEY, "SHA1", 20_000_000_000)).toBe("65353130");
  });

  it("makes six digits from a bare key, and says how long the code has left", () => {
    expect(totpNow(SHA1_KEY, 59_000)).toEqual({ code: "287082", left: 1 });
    expect(totpNow(SHA1_KEY.toLowerCase().replace(/(.{4})/gu, "$1 "), 31_000)).toMatchObject({ left: 29 });
    expect(groupCode("287082")).toBe("287 082");
    expect(groupCode("94287082")).toBe("9428 7082");
  });

  it("makes none from a key the hub would refuse", () => {
    expect(totpNow("3", 59_000)).toBeUndefined();
  });
});

describe("setup keys", () => {
  it("refuses what makes no codes, in the person's words", () => {
    expect(totpKeyProblem("")).toBeUndefined();
    expect(totpKeyProblem("3")).toBe("That setup key is too short: a site's has at least 16 letters and digits.");
    expect(totpKeyProblem("JBSWY3DPEHPK3PX")).toContain("too short");
    expect(totpKeyProblem("JBSWY3DPEHPK3PX1")).toContain("letters A to Z and digits 2 to 7");
    expect(totpKeyProblem("otpauth://totp/x")).toContain("too short");
    expect(totpKeyProblem(`otpauth://hotp/x?secret=${SHA1_KEY}&counter=1`)).toContain("counted codes");
    expect(totpKeyProblem(`otpauth://totp/x?secret=${SHA1_KEY}&algorithm=MD5`)).toContain("algorithm");
    expect(totpKeyProblem(`otpauth://totp/x?secret=${SHA1_KEY}&digits=4`)).toContain("length or period");
    expect(totpKeyProblem("otpauth://totp/x?secret=%E0%A4%A")).toBe("That isn't an otpauth:// link.");
  });

  it("reads a link's settings, names in any case, with an issuer and a label", () => {
    const p = totpParse(`OTPAUTH://TOTP/Shop:ada%40shop.example?Secret=${SHA1_KEY}&issuer=Shop&Period=60&digits=7`);
    expect(p).toMatchObject({ ok: true, value: { digits: 7, period: 60, algorithm: "sha1" } });
    expect(p.ok && p.value.key.length).toBe(20);
  });

  it("works without URL.searchParams, as on Hermes", () => {
    const URLBefore = globalThis.URL;
    // @ts-expect-error: React Native's URL has no searchParams; none at all is stricter still.
    delete globalThis.URL;
    try {
      expect(totpNow(`otpauth://totp/x?secret=${SHA1_KEY}`, 59_000)?.code).toBe("287082");
    } finally {
      globalThis.URL = URLBefore;
    }
  });
});
