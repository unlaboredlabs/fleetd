import { describe, expect, it } from "vitest";
import { MAX_CHANGES } from "../shared/updates";
import { fetchRelease, parseChanges, parseCli } from "./update-release";

const change = { commit: "1f9b7c9b137435766ee6b052884ef2b1d79b640c", date: "2026-10-22T15:10:57Z", subject: "ci(release): changes.json (#276)", areas: ["other"] };

describe("the release files", () => {
  it("reads changes.json's entries, at most MAX_CHANGES", () => {
    expect(parseChanges({ changes: [change] })).toEqual([change]);
    expect(parseChanges({ changes: Array.from({ length: 300 }, () => change) })).toHaveLength(MAX_CHANGES);
  });

  it("has none for a broken changes.json, and no CLI for a release.json without it", () => {
    expect(parseChanges({ changes: "not a list" })).toEqual([]);
    expect(parseChanges(null)).toEqual([]);
    expect(parseCli({ channel: "nightly", version: "0.6.0" })).toBeNull();
    expect(parseCli({ cliVersion: "0.6.0-nightly.202610221107+333368c" })).toBe("0.6.0-nightly.202610221107+333368c");
  });

  it("reads both beside the feed, and never rejects when they can't be read", async () => {
    const asked: string[] = [];
    const found = ((url: string) => {
      asked.push(url);
      return Promise.resolve(Response.json(url.endsWith("changes.json") ? { changes: [change] } : { cliVersion: "0.6.0" }));
    }) as typeof fetch;
    expect(await fetchRelease("https://example.com/feed", found)).toEqual({ changes: [change], cli: "0.6.0" });
    expect(asked.sort()).toEqual(["https://example.com/feed/changes.json", "https://example.com/feed/release.json"]);

    const missing = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
    expect(await fetchRelease("https://example.com/feed", missing)).toEqual({ changes: [], cli: null });
    const offline = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(await fetchRelease("https://example.com/feed", offline)).toEqual({ changes: [], cli: null });
    } finally {
      console.warn = warn;
    }
  });
});
