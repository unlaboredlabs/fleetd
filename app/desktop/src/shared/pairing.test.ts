import { describe, expect, it } from "vitest";
import { compareVersions, hubOrigin, normalizeCode, olderNodes, parseDeepLink, protocolFit, readAppPair } from "./pairing";

describe("normalizeCode", () => {
  it("takes any case, spacing and hyphens, and Crockford look-alikes, as the hub does", () => {
    expect(normalizeCode(" abcd-2345 ")).toBe("ABCD-2345");
    expect(normalizeCode("ABCD2345")).toBe("ABCD-2345");
    expect(normalizeCode("ab cd 23 45")).toBe("ABCD-2345");
    expect(normalizeCode("I0LO-ABCD")).toBe("1010-ABCD");
  });

  it("refuses what can't be a code", () => {
    expect(normalizeCode("ABCD-234")).toBeNull();
    expect(normalizeCode("ABCD-23!5")).toBeNull();
    expect(normalizeCode("ABCD-U345")).toBeNull();
    expect(normalizeCode("")).toBeNull();
  });
});

describe("hubOrigin", () => {
  it("accepts bare hosts, http(s) and the ws URL a key was saved with", () => {
    expect(hubOrigin("127.0.0.1:4790")).toEqual({ ok: true, origin: "http://127.0.0.1:4790" });
    expect(hubOrigin(" http://hub.tail1234.ts.net:4790/ ")).toEqual({ ok: true, origin: "http://hub.tail1234.ts.net:4790" });
    expect(hubOrigin("wss://hub.example.com/app")).toEqual({ ok: true, origin: "https://hub.example.com" });
    expect(hubOrigin("ws://[::1]:4790/app")).toEqual({ ok: true, origin: "http://[::1]:4790" });
  });

  it("says how to fix anything else", () => {
    for (const bad of ["", "ftp://hub", "http://"]) {
      const result = hubOrigin(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.fix).toContain("127.0.0.1:4790");
    }
  });
});

describe("parseDeepLink", () => {
  it("reads the url-encoded hub and the code", () => {
    expect(parseDeepLink("fleetd://pair?hub=http%3A%2F%2F100.64.0.1%3A4790&code=ABCD-2345")).toEqual({
      hub: "http://100.64.0.1:4790",
      code: "ABCD-2345",
    });
    expect(parseDeepLink("fleetd://pair/?code=X&hub=h")).toEqual({ hub: "h", code: "X" });
  });

  it("ignores other links and missing parts", () => {
    expect(parseDeepLink("fleetd://pair?hub=h")).toBeNull();
    expect(parseDeepLink("fleetd://other?hub=h&code=X")).toBeNull();
    expect(parseDeepLink("https://pair?hub=h&code=X")).toBeNull();
  });
});

describe("readAppPair", () => {
  const text = JSON.stringify({ hub: "http://127.0.0.1:4790", code: "ABCD-2345", expiresAt: "2026-10-18T10:15:00Z" });
  const at = Date.parse("2026-10-18T10:15:00Z");

  it("reads the file and decides expiry", () => {
    expect(readAppPair(text, at - 1)).toEqual({ hub: "http://127.0.0.1:4790", code: "ABCD-2345", expired: false });
    expect(readAppPair(text, at)?.expired).toBe(true);
  });

  it("ignores a file it can't use", () => {
    expect(readAppPair("not json", 0)).toBeNull();
    expect(readAppPair(JSON.stringify({ hub: "", code: "X", expiresAt: "2026-10-18T10:15:00Z" }), 0)).toBeNull();
    expect(readAppPair(JSON.stringify({ hub: "h", code: "X", expiresAt: "soon" }), 0)?.expired).toBe(true);
  });
});

describe("versions", () => {
  it("says which side of the protocol is behind", () => {
    expect(protocolFit(1)).toBe("ok");
    expect(protocolFit(2)).toBe("app-older");
  });

  it("orders versions numerically and refuses to guess", () => {
    expect(compareVersions("0.10.0", "0.9.3")).toBe(1);
    expect(compareVersions("v0.4.2", "0.4.2")).toBe(0);
    expect(compareVersions("0.5.0-nightly.3", "0.5.0")).toBe(-1);
    expect(compareVersions("dev", "0.5.0")).toBeNull();
  });

  it("names the machines whose node is older than the hub", () => {
    const machines = [
      { name: "devbox", nodeVersion: "0.5.0" },
      { name: "buildbox", nodeVersion: "0.4.9" },
      { name: "laptop", nodeVersion: "unknown" },
    ];
    expect(olderNodes(machines, "0.5.0")).toEqual(["buildbox"]);
  });
});
