import { PROTOCOL_VERSION } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { checkHubHello } from "./handshake.ts";

const frame = (protocolVersion: unknown) =>
  JSON.stringify({ _tag: "HubHello", protocolVersion, hubVersion: "0.0.0", t3Pin: "abc" });

describe("checkHubHello", () => {
  it("accepts a hub on the same protocol", () => {
    expect(checkHubHello(frame(PROTOCOL_VERSION))).toMatchObject({ ok: true, hello: { t3Pin: "abc" } });
  });

  it("refuses a hub on another protocol and says why", () => {
    expect(checkHubHello(frame(PROTOCOL_VERSION + 1))).toEqual({
      ok: false,
      reason: `hub speaks protocol ${PROTOCOL_VERSION + 1}, this node speaks ${PROTOCOL_VERSION}`,
    });
  });

  it("refuses frames that are not a hello", () => {
    expect(checkHubHello("{}")).toEqual({ ok: false, reason: "malformed hello" });
    expect(checkHubHello("not json")).toEqual({ ok: false, reason: "malformed hello" });
  });
});
