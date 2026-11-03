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
