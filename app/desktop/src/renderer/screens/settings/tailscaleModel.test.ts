import { describe, expect, it } from "vitest";
import { canConnect, lineOf, markOf, waiting } from "./tailscaleModel";

describe("Tailscale's row", () => {
  it("says nothing at rest, and only what the person needs now otherwise", () => {
    expect(lineOf({ status: "off" })).toBeNull();
    expect(lineOf({ status: "connected", tailnet: "example.com", device: "fleetd" })).toEqual({ text: "example.com · as fleetd", tone: "quiet" });
    expect(lineOf({ status: "login", loginUrl: "https://login.tailscale.com/a/x" })?.text).toBe("Waiting for you to sign in to Tailscale and approve the device.");
    expect(lineOf({ status: "approve" })?.tone).toBe("warning");
    expect(lineOf({ status: "failed", problem: "it ended" })).toEqual({ text: "it ended", tone: "danger" });
  });

  it("is off with why where the hub can't run it, and Connect off there", () => {
    const mac = { status: "off", problem: "Tailscale's gateway runs on Linux hubs, and this hub runs on darwin (arm64)" };
    expect(lineOf(mac)?.text).toBe("Tailscale's gateway runs on Linux hubs, and this hub runs on darwin (arm64).");
    expect(canConnect(mac)).toBe(false);
    expect(canConnect({ status: "off" })).toBe(true);
    expect(canConnect({ status: "failed", problem: "x" })).toBe(true);
    expect(canConnect({ status: "connected" })).toBe(false);
  });

  it("marks its state as a dot, and reads it again only while it waits on a sign-in", () => {
    expect(markOf({ status: "connected" })).toBe("ready");
    expect(markOf({ status: "login" })).toBe("needs");
    expect(markOf({ status: "failed" })).toBe("failed");
    expect(markOf({ status: "off" })).toBe("off");
    expect(waiting({ status: "login" })).toBe(true);
    expect(waiting({ status: "connected" })).toBe(false);
    expect(waiting(undefined)).toBe(false);
  });
});
