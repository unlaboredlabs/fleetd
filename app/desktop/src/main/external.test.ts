import { describe, expect, it } from "vitest";
import { externalUrl, MAX_EXTERNAL_URL_LENGTH } from "./external";

const opens = (url: string) => externalUrl(url).ok;

describe("externalUrl", () => {
  it("opens https links to GitHub, its subdomains and fleetd.sh", () => {
    expect(externalUrl("https://github.com/acme/storefront/pull/12")).toEqual({ ok: true, url: "https://github.com/acme/storefront/pull/12" });
    expect(opens("https://gist.github.com/x")).toBe(true);
    expect(opens("https://GITHUB.com:443/acme")).toBe(true);
    expect(opens("https://fleetd.sh/docs/status#machines")).toBe(true);
  });

  it("refuses other schemes", () => {
    for (const url of ["http://github.com/acme", "file:///etc/passwd", "javascript:alert(1)", "ssh://github.com/acme", "x-github-client://openRepo"]) {
      expect(opens(url)).toBe(false);
    }
  });

  it("refuses look-alike and other hosts", () => {
    for (const url of [
      "https://evilgithub.com/",
      "https://github.com.evil.example/",
      "https://github.com@evil.example/",
      "https://github.com./acme",
      "https://docs.fleetd.sh/",
      "https://fleetd.sh.evil.example/",
      "https://127.0.0.1/",
    ]) {
      expect(opens(url), url).toBe(false);
    }
  });

  it("refuses credentials, odd ports, non-URLs and over-long links, saying why", () => {
    expect(externalUrl("https://user:pw@github.com/acme")).toEqual({ ok: false, message: "Links carrying a user name or password don't open." });
    expect(opens("https://token@github.com/acme")).toBe(false);
    expect(opens("https://github.com:8443/acme")).toBe(false);
    expect(externalUrl("github.com/acme")).toEqual({ ok: false, message: "That isn't a link." });
    expect(opens(`https://github.com/${"a".repeat(MAX_EXTERNAL_URL_LENGTH)}`)).toBe(false);
  });
});
