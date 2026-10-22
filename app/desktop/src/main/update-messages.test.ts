import { describe, expect, it } from "vitest";
import { failureReason } from "./update-messages";

describe("failureReason", () => {
  it("puts known failures in plain words", () => {
    expect(failureReason(new Error("getaddrinfo ENOTFOUND github.com"))).toMatch(/didn't answer/u);
    expect(failureReason(new Error("net::ERR_INTERNET_DISCONNECTED"))).toMatch(/didn't answer/u);
    expect(failureReason(new Error('Cannot find channel "latest-mac.yml" update info: HttpError: 404'))).toMatch(/no update information/u);
    expect(failureReason(new Error("Code signature at URL file:///x did not pass validation"))).toMatch(/isn't signed/u);
    expect(failureReason(new Error("sha512 checksum mismatch, expected a, got b"))).toMatch(/damaged/u);
  });

  it("keeps only the first line of anything else, bounded", () => {
    expect(failureReason(new Error("disk full\n    at write (fs.js:1)"))).toBe("disk full");
    expect(failureReason(new Error("x".repeat(500)))).toHaveLength(200);
    expect(failureReason("")).toBe("Something went wrong. Try again later.");
  });
});
