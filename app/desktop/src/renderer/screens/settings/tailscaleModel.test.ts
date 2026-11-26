import { describe, expect, it } from "vitest";
import { canConnect, lineOf, waiting, wordOf } from "./tailscaleModel";

describe("Tailscale's row", () => {
  it("says nothing at rest, the tailnet once connected, and what it waits on", () => {
    expect(wordOf({ status: "off" })).toBeNull();
    expect(lineOf({ status: "off" }, true)).toBeNull();
    expect(wordOf({ status: "connected", tailnet: "example.com", device: "fleetd" })).toEqual({ text: "Connected", tone: "quiet", hint: "example.com" });
    expect(lineOf({ status: "connected", tailnet: "example.com" }, true)).toBeNull();
    expect(wordOf({ status: "login", loginUrl: "https://login.tailscale.com/a/x" })).toEqual({ text: "Waiting for sign-in", tone: "warning" });
    expect(lineOf({ status: "approve" }, true)?.text).toBe("An admin of your tailnet approves the device in Tailscale's admin console.");
    expect(wordOf({ status: "failed", problem: "it ended" })?.tone).toBe("danger");
    expect(lineOf({ status: "failed", problem: "it ended" }, true)).toEqual({ text: "it ended.", tone: "danger" });
  });

  it("says what to do when it's connected but its sign-in can't be kept (a locked vault)", () => {
    const s = { status: "connected", tailnet: "example.com", problem: "Its sign-in isn't kept: unlock the vault" };
    expect(lineOf(s, true)).toEqual({ text: "Its sign-in isn't kept: unlock the vault.", tone: "warning" });
  });

  it("is off with why where the hub can't run it, and Connect off there; a member is told an admin connects it", () => {
    const mac = { status: "off", problem: "Tailscale isn't running on the workspace's computer" };
    expect(lineOf(mac, true)?.text).toBe("Tailscale isn't running on the workspace's computer.");
    expect(canConnect(mac)).toBe(false);
    expect(canConnect({ status: "off" })).toBe(true);
    expect(canConnect({ status: "failed", problem: "x" })).toBe(true);
    expect(canConnect({ status: "connected" })).toBe(false);
    expect(lineOf({ status: "off" }, false)?.text).toBe("An admin connects Tailscale.");
  });

  it("reads its state again only while it waits on a sign-in", () => {
    expect(waiting({ status: "login" })).toBe(true);
    expect(waiting({ status: "connected" })).toBe(false);
    expect(waiting(undefined)).toBe(false);
  });
});
