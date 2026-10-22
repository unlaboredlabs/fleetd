import { describe, expect, it } from "vitest";
import { fetchNotes, parseNotes } from "./update-notes";

const release = {
  channel: "nightly",
  version: "0.6.0-nightly.202610231030+aaa1111",
  appVersion: "0.6.0-nightly.202610231030+aaa1111",
  changes: [
    { version: "0.6.0-nightly.202610231030+aaa1111", text: "Updates show in the app" },
    { version: "0.6.0-nightly.202610221030+bbb2222", text: "Status loads faster" },
  ],
};

describe("release notes", () => {
  it("lists the changes since this app's version", () => {
    expect(parseNotes(release, "0.6.0-nightly.202610221030+bbb2222")).toEqual(["Updates show in the app"]);
  });

  it("has none for a release.json from before changes were kept, or a broken one", () => {
    expect(parseNotes({ channel: "nightly", version: "0.6.0" }, "0.5.0")).toEqual([]);
    expect(parseNotes({ changes: "not a list" }, "0.5.0")).toEqual([]);
  });

  it("never rejects when the file can't be read", async () => {
    const offline = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    const missing = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
    const found = (() => Promise.resolve(Response.json(release))) as typeof fetch;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(await fetchNotes("https://example.com/feed", "0.5.0", offline)).toEqual([]);
    } finally {
      console.warn = warn;
    }
    expect(await fetchNotes("https://example.com/feed", "0.5.0", missing)).toEqual([]);
    expect(await fetchNotes("https://example.com/feed", "0.5.0", found)).toHaveLength(2);
  });
});
