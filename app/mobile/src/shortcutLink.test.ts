import { describe, expect, it } from "vitest";
import { parseShortcutLink } from "./shortcutLink";

describe("parseShortcutLink", () => {
  it("opens the chat Open Chat names, as Actions.swift writes its link", () => {
    expect(parseShortcutLink("fleetd://chat?machine=m1&project=p2")).toEqual({ t: "chat", key: "m1/p2" });
    expect(parseShortcutLink(" fleetd://chat?machine=m%201&project=a%26b ")).toEqual({ t: "chat", key: "m 1/a&b" });
  });

  it("opens the Needs You list", () => {
    expect(parseShortcutLink("fleetd://approvals")).toEqual({ t: "approvals" });
  });

  it("leaves other links alone, and a damaged one goes nowhere", () => {
    for (const text of ["fleetd://pair?hub=x&code=y", "fleetd://", "https://example.com/chat?machine=m&project=p", "fleetd://chatroom", "fleetd://chat?machine=m1", "fleetd://chat?machine=%E0&project=p"]) {
      expect(parseShortcutLink(text)).toBeNull();
    }
  });
});

describe("a share link's sign-in page", () => {
  it("opens the link it names, at its path", () => {
    const url = encodeURIComponent("https://k7f3q9m2x8ab.preview.example.com/cart?x=1");
    expect(parseShortcutLink(`fleetd://preview?url=${url}`)).toEqual({ t: "preview", name: "k7f3q9m2x8ab", to: "/cart?x=1" });
    expect(parseShortcutLink(`fleetd://preview?url=${encodeURIComponent("http://k7f3q9m2x8ab.localhost:4790")}`)).toEqual({ t: "preview", name: "k7f3q9m2x8ab", to: "/" });
    for (const bad of ["https://short.example.com/", "javascript:alert(1)", "fleetd://k7f3q9m2x8ab.example.com/"]) {
      expect(parseShortcutLink(`fleetd://preview?url=${encodeURIComponent(bad)}`)).toBeNull();
    }
    // A path that would name another host lands on the preview's own root.
    expect(parseShortcutLink(`fleetd://preview?url=${encodeURIComponent("https://k7f3q9m2x8ab.example.com//evil.com")}`)).toEqual({ t: "preview", name: "k7f3q9m2x8ab", to: "/" });
  });
});
