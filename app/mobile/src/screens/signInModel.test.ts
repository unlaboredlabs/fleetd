import { describe, expect, it } from "vitest";
import { codeOnly, signInAsks, signInOutcome } from "./signInModel";

describe("a sign-in form", () => {
  it("asks for a whole login, or the code alone", () => {
    expect(signInAsks(["password"])).toEqual(["username", "password"]);
    expect(signInAsks(["username", "otp"])).toEqual(["username", "password", "otp"]);
    expect(signInAsks(["otp"])).toEqual(["otp"]);
    expect(codeOnly(["otp"])).toBe(true);
    expect(codeOnly(["password", "otp"])).toBe(false);
  });
  it("folds to what was filled, and whether it went in the vault", () => {
    expect(signInOutcome(["username", "password"], true)).toBe("Filled in, saved to Vault");
    expect(signInOutcome(["username", "password"], false)).toBe("Filled in");
    expect(signInOutcome(["otp"], true)).toBe("Code filled in");
  });
});
