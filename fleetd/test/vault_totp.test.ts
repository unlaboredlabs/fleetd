// A login's one-time code setup key (src/hub/vault/fields.ts totpParams): the hub keeps only one it can make codes
// from. "3" passed as base32 once, and the phone then showed the raw key as the login's "Verification code".
import { afterEach, beforeEach, expect, test } from "bun:test";
import { totpCode, totpParams } from "../src/hub/vault/fields.ts";
import { ToolError } from "../src/shared/errors.ts";
import { vaultHub, type VaultHub } from "./vault-kit.ts";

// RFC 6238's SHA-1 test key, "12345678901234567890", in base32.
const RFC_KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const refusal = (f: () => unknown): ToolError => {
  try {
    f();
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};

test("RFC 6238's vectors, from a bare key and from an otpauth:// link", () => {
  expect(totpCode(`otpauth://totp/x?secret=${RFC_KEY}&digits=8`, 59_000)).toBe("94287082");
  expect(totpCode(`otpauth://totp/x?secret=${RFC_KEY}&digits=8`, 1_111_111_109_000)).toBe("07081804");
  expect(totpCode(RFC_KEY, 59_000)).toBe("287082");
  // As sites print it: lowercase, in groups.
  expect(totpCode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", 59_000)).toBe("287082");
});

test("a key too short to be a site's, one that isn't base32, and an hotp link are refused, saying what to do", () => {
  for (const key of ["3", "ABCDEFGH", "JBSWY3DPEHPK3PX", "otpauth://totp/x?secret=MADEUP", "otpauth://totp/x"]) {
    const e = refusal(() => totpParams(key));
    expect(e.code).toBe("invalid");
    expect(e.message).toContain("too short");
    expect(e.fix).toContain("two-factor settings");
  }
  expect(refusal(() => totpParams("hello world 1890")).message).toContain("letters A to Z and digits 2 to 7");
  expect(refusal(() => totpParams(`otpauth://hotp/x?secret=${RFC_KEY}&counter=1`)).message).toContain("time-based");
  // The shortest in use: 16 letters, 80 bits.
  expect(totpParams("JBSWY3DPEHPK3PXP").key.length).toBe(10);
});

let k: VaultHub;
beforeEach(async () => {
  k = vaultHub();
  await k.v.load();
});
afterEach(() => k.done());

test("vault_save refuses a login whose setup key makes no codes, and an edit can take it away", async () => {
  const save = (input: Record<string, unknown>) => k.call<{ item: { itemId: string } }>(k.ownerDevice, "vault_save", input);
  const bad = await save({ kind: "login", label: "Shop", sites: ["shop.example"], sealed: k.sealToHub({ username: "ada", totp: "3" }) }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(bad).toBeInstanceOf(ToolError);
  expect((bad as ToolError).message).toContain("too short");

  const ok = await save({ kind: "login", label: "Shop", sites: ["shop.example"], sealed: k.sealToHub({ username: "ada", totp: "JBSWY3DPEHPK3PXP" }) });
  const id = ok.item.itemId;
  await save({ itemId: id, sealed: k.sealToHub({ totp: "" }) });
  const left = await save({ itemId: id, label: "Shop again" });
  expect(left.item.itemId).toBe(id);
});
