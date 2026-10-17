import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { HubHello, PROTOCOL_VERSION } from "./index.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(HubHello));
const encode = Schema.encodeSync(Schema.fromJsonString(HubHello));

describe("HubHello", () => {
  it("round-trips through JSON", () => {
    const wire = JSON.stringify({ _tag: "HubHello", protocolVersion: PROTOCOL_VERSION, hubVersion: "0.0.0", t3Pin: "2fbd4318fc" });
    const hello = decode(wire);
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(JSON.parse(encode(hello))).toEqual(JSON.parse(wire));
  });

  it("rejects a non-integer or zero protocol version", () => {
    for (const protocolVersion of [0, 1.5, "1"]) {
      expect(() => decode(JSON.stringify({ _tag: "HubHello", protocolVersion, hubVersion: "x", t3Pin: "x" }))).toThrow();
    }
  });
});
