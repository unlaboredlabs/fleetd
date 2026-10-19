import { describe, expect, it } from "vitest";
import { IPC } from "../shared/channels";
import { parseRequest } from "../shared/ipc";
import { shouldClaim, type ClaimInputs } from "./linkHandler";

const base: ClaimInputs = { packaged: true, reason: "first-run", claimedBefore: false, isHandler: false };

describe("shouldClaim", () => {
  it("claims once on first run, never on later launches", () => {
    expect(shouldClaim(base)).toBe(true);
    expect(shouldClaim({ ...base, claimedBefore: true })).toBe(false);
    expect(shouldClaim({ ...base, claimedBefore: true, isHandler: false })).toBe(false);
  });

  it("claims whenever you ask, even after the first run", () => {
    expect(shouldClaim({ ...base, reason: "user", claimedBefore: true, isHandler: true })).toBe(true);
  });

  it("claims after a failed pairing link only when another app holds the scheme", () => {
    expect(shouldClaim({ ...base, reason: "pair-failed", claimedBefore: true, isHandler: false })).toBe(true);
    expect(shouldClaim({ ...base, reason: "pair-failed", claimedBefore: true, isHandler: true })).toBe(false);
  });

  it("never claims from a dev build", () => {
    for (const reason of ["first-run", "user", "pair-failed"] as const) {
      expect(shouldClaim({ ...base, packaged: false, reason })).toBe(false);
    }
  });
});

describe("the page's link-handler request", () => {
  it("reads, or claims for Settings or a failed pairing link, but can't fake a first run", () => {
    expect(parseRequest(IPC.appLinkHandler, [null]).ok).toBe(true);
    expect(parseRequest(IPC.appLinkHandler, ["user"]).ok).toBe(true);
    expect(parseRequest(IPC.appLinkHandler, ["pair-failed"]).ok).toBe(true);
    expect(parseRequest(IPC.appLinkHandler, ["first-run"]).ok).toBe(false);
    expect(parseRequest(IPC.appLinkHandler, []).ok).toBe(false);
  });
});
