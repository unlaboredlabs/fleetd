import { describe, expect, it } from "vitest";
import { failureReason, updateMessage } from "./update-messages";

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

describe("updateMessage", () => {
  it("says which version the user has when nothing is newer", () => {
    expect(updateMessage({ kind: "current", version: "0.4.0" }, "0.4.0").detail).toBe("You have version 0.4.0.");
  });

  it("offers a restart only once the update is downloaded", () => {
    expect(updateMessage({ kind: "downloading", version: "0.5.0" }, "0.4.0").buttons).toEqual(["OK"]);
    expect(updateMessage({ kind: "ready", version: "0.5.0" }, "0.4.0").buttons).toEqual(["Restart Now", "Later"]);
  });

  it("tells deb users the exact install command", () => {
    expect(updateMessage({ kind: "deb", version: "0.5.0" }, "0.4.0").detail).toContain("sudo apt install ./fleetd-desktop-linux-amd64.deb");
  });
});
