import { describe, expect, it } from "vitest";
import { MAX_NOTES, notesSince, versionLabel } from "./updates";

describe("notesSince", () => {
  const changes = [
    { version: "0.6.0-nightly.202610231030+aaa1111", text: "Updates show in the app" },
    { version: "0.6.0-nightly.202610231030+aaa1111", text: "The chat keeps your draft" },
    { version: "0.6.0-nightly.202610221030+bbb2222", text: "Status loads faster" },
    { version: "0.5.0", text: "First release" },
  ];

  it("lists what came after this version, newest first", () => {
    expect(notesSince(changes, "0.6.0-nightly.202610221030+bbb2222")).toEqual(["Updates show in the app", "The chat keeps your draft"]);
  });

  it("matches the version without its build hash", () => {
    expect(notesSince(changes, "0.6.0-nightly.202610221030+ccc3333")).toHaveLength(2);
  });

  it("lists everything for a version older than the list, at most MAX_NOTES", () => {
    expect(notesSince(changes, "0.4.0")).toHaveLength(4);
    const many = Array.from({ length: 30 }, (_, i) => ({ version: "0.9.0", text: `Change ${String(i)}` }));
    expect(notesSince(many, "0.4.0")).toHaveLength(MAX_NOTES);
  });

  it("has nothing new for the newest version", () => {
    expect(notesSince(changes, "0.6.0-nightly.202610231030+aaa1111")).toEqual([]);
  });
});

describe("versionLabel", () => {
  it("drops the build hash and reads a nightly by its date", () => {
    expect(versionLabel("0.6.0-nightly.202610221030+abc1234", "UTC")).toBe("0.6.0 nightly, Oct 22, 10:30");
    expect(versionLabel("v0.6.0")).toBe("0.6.0");
    expect(versionLabel("0.6.0-rc.1+abc1234")).toBe("0.6.0-rc.1");
  });
});
