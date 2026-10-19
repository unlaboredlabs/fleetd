import { describe, expect, it } from "vitest";
import { NotifyRequest, parseDeepLink } from "./app";

describe("parseDeepLink", () => {
  it("reads the pairing link `fleetd pair` prints", () => {
    expect(parseDeepLink("fleetd://pair?hub=http%3A%2F%2F100.64.0.1%3A4790&code=ABCD-2345")).toEqual({
      kind: "pair",
      hub: "http://100.64.0.1:4790",
      code: "ABCD-2345",
    });
    expect(parseDeepLink(" fleetd://pair/?code=ABCD-2345&hub=https%3A%2F%2Fhub.example ")).toEqual({
      kind: "pair",
      hub: "https://hub.example",
      code: "ABCD-2345",
    });
  });

  it("ignores other links and anything that isn't a plain hub address and code", () => {
    for (const link of [
      "fleetd://pair?hub=http%3A%2F%2Fh",
      "fleetd://other?hub=http%3A%2F%2Fh&code=ABCD-2345",
      "https://pair?hub=http%3A%2F%2Fh&code=ABCD-2345",
      "fleetd://pair?hub=javascript%3Aalert(1)&code=ABCD-2345",
      "fleetd://pair?hub=http%3A%2F%2Fu%3Ap%40h&code=ABCD-2345",
      "fleetd://pair?hub=http%3A%2F%2Fh&code=%3Cscript%3E",
      "not a url",
    ]) {
      expect(parseDeepLink(link)).toBeNull();
    }
  });
});

describe("NotifyRequest", () => {
  it("never carries a pairing target", () => {
    const base = { tag: "needs-you", title: "fleetd needs you", body: "A1" };
    expect(NotifyRequest.safeParse({ ...base, target: { kind: "chat", machineId: "devbox", projectId: "storefront", messageId: "m-1" } }).success).toBe(true);
    expect(NotifyRequest.safeParse({ ...base, target: { kind: "pair", hub: "http://h", code: "ABCD-2345" } }).success).toBe(false);
  });
});
