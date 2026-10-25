import { describe, expect, it } from "vitest";
import { externalUrl, MAX_EXTERNAL_URL_LENGTH } from "./external";

const opens = (url: string) => externalUrl(url).ok;

describe("externalUrl", () => {
  it("opens https links of any host", () => {
    expect(externalUrl("https://docs.capy.ai/secrets")).toEqual({ ok: true, url: "https://docs.capy.ai/secrets" });
    expect(externalUrl("https://github.com/acme/storefront/pull/12")).toEqual({ ok: true, url: "https://github.com/acme/storefront/pull/12" });
    expect(opens("https://GITHUB.com:443/acme")).toBe(true);
    expect(opens("https://fleetd.sh/docs/status#machines")).toBe(true);
    expect(opens("https://github.com:8443/acme")).toBe(true);
  });

  it("opens http links, local dev servers included", () => {
    expect(externalUrl("http://localhost:3000")).toEqual({ ok: true, url: "http://localhost:3000/" });
    expect(opens("http://127.0.0.1:8080/health")).toBe(true);
  });

  it("refuses other schemes", () => {
    expect(externalUrl("file:///etc/passwd")).toEqual({ ok: false, message: "Only http and https links open in the browser." });
    for (const url of ["javascript:alert(1)", "ssh://github.com/acme", "x-github-client://openRepo", "data:text/html,hi", "mailto:a@b.c"]) {
      expect(opens(url), url).toBe(false);
    }
  });

  it("refuses credentials, non-URLs and over-long links, saying why", () => {
    expect(externalUrl("https://user:pw@github.com/acme")).toEqual({ ok: false, message: "Links carrying a user name or password don't open." });
    expect(opens("https://token@github.com/acme")).toBe(false);
    expect(opens("http://github.com@evil.example/")).toBe(false);
    expect(externalUrl("github.com/acme")).toEqual({ ok: false, message: "That isn't a link." });
    expect(opens(`https://github.com/${"a".repeat(MAX_EXTERNAL_URL_LENGTH)}`)).toBe(false);
  });
});
