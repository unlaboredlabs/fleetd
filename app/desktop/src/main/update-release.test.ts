import { describe, expect, it } from "vitest";
import { fetchRelease, parseApp, parseCli } from "./update-release";

describe("the release file", () => {
  it("has no CLI or app for a release.json without it", () => {
    expect(parseCli({ channel: "edge", version: "0.6.0" })).toBeNull();
    expect(parseCli({ cliVersion: "0.6.0-edge.202610221107+333368c" })).toBe("0.6.0-edge.202610221107+333368c");
    expect(parseApp({ cliVersion: "0.6.0" })).toBeNull();
    expect(parseApp({ appVersion: "0.6.0-edge.202610221021+7b6779f" })).toBe("0.6.0-edge.202610221021+7b6779f");
  });

  it("reads it beside the feed, and never rejects when it can't be read", async () => {
    const asked: string[] = [];
    const found = ((url: string) => {
      asked.push(url);
      return Promise.resolve(Response.json({ cliVersion: "0.6.0", appVersion: "0.5.1" }));
    }) as typeof fetch;
    expect(await fetchRelease("https://example.com/feed", found)).toEqual({ cli: "0.6.0", app: "0.5.1" });
    expect(asked).toEqual(["https://example.com/feed/release.json"]);

    const missing = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
    expect(await fetchRelease("https://example.com/feed", missing)).toEqual({ cli: null, app: null });
    const offline = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(await fetchRelease("https://example.com/feed", offline)).toEqual({ cli: null, app: null });
    } finally {
      console.warn = warn;
    }
  });
});
