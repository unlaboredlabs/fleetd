// The ATS rules, and app.config.ts's settings under them: plain HTTP to a hub at any address, raw IPs included.
import type { ConfigContext } from "expo/config";
import { describe, expect, it } from "vitest";
import config from "../app.config";
import { allowsHttp, CANCELS_ARBITRARY, HUBS, problems } from "./ats";

const infoPlist = config({ projectRoot: process.cwd() } as ConfigContext).ios?.infoPlist ?? {};

describe("app.config.ts", () => {
  it("lets plain HTTP reach a hub at any address", () => {
    expect(problems(infoPlist)).toEqual([]);
  });
});

describe("problems", () => {
  it("names each key that cancels arbitrary loads", () => {
    for (const k of CANCELS_ARBITRARY) {
      expect(problems({ NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, [k]: false } })).toContain(
        `${k} makes iOS ignore NSAllowsArbitraryLoads`,
      );
    }
  });

  it("finds the settings that blocked tailnet hubs", () => {
    expect(problems({ NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true } })).toEqual([
      "NSAllowsLocalNetworking makes iOS ignore NSAllowsArbitraryLoads",
      "ATS blocks plain HTTP to the hub at 100.101.102.103",
      "ATS blocks plain HTTP to the hub at devbox.tail1234.ts.net",
      "ATS blocks plain HTTP to the hub at fd7a:115c:a1e0::1",
      "ATS blocks plain HTTP to the hub at 192.168.1.20",
      "ATS blocks plain HTTP to the hub at hub.example.com",
      "ATS blocks plain HTTP to the hub at 203.0.113.7",
    ]);
  });

  it("finds a missing ATS dictionary", () => {
    expect(problems({})).toHaveLength(HUBS.length);
  });
});

describe("allowsHttp", () => {
  it("allows every host, raw IPs included, with arbitrary loads alone", () => {
    for (const h of [...HUBS, "[fd7a:115c:a1e0::1]"]) expect(allowsHttp({ NSAllowsArbitraryLoads: true }, h)).toBe(true);
  });

  it("ignores arbitrary loads once a cancelling key is present, whatever its value", () => {
    for (const k of CANCELS_ARBITRARY) expect(allowsHttp({ NSAllowsArbitraryLoads: true, [k]: false }, "hub.example.com")).toBe(false);
  });

  it("lets local networking allow only unqualified and .local names", () => {
    const ats = { NSAllowsLocalNetworking: true };
    expect(allowsHttp(ats, "devbox")).toBe(true);
    expect(allowsHttp(ats, "devbox.local")).toBe(true);
    expect(allowsHttp(ats, "devbox.tail1234.ts.net")).toBe(false);
    expect(allowsHttp(ats, "100.101.102.103")).toBe(false);
  });

  it("lets an exception domain override arbitrary loads for its hosts, never for an IP", () => {
    const ats = {
      NSAllowsArbitraryLoads: true,
      NSExceptionDomains: { "example.com": { NSIncludesSubdomains: true }, "100.64.0.0/10": { NSExceptionAllowsInsecureHTTPLoads: false } },
    };
    expect(allowsHttp(ats, "hub.example.com")).toBe(false);
    expect(allowsHttp(ats, "example.org")).toBe(true);
    expect(allowsHttp(ats, "100.101.102.103")).toBe(true);
  });
});
