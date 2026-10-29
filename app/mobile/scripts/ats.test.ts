// The ATS rules, and app.config.ts's settings under them: the app's tailnet and local hubs over plain HTTP, nothing else.
import type { ConfigContext } from "expo/config";
import { describe, expect, it } from "vitest";
import config from "../app.config";
import { allowsHttp, HUBS, OTHERS, problems } from "./ats";

const infoPlist = config({ projectRoot: process.cwd() } as ConfigContext).ios?.infoPlist ?? {};

describe("app.config.ts", () => {
  it("lets plain HTTP reach tailnet and local hubs only", () => {
    expect(problems(infoPlist)).toEqual([]);
  });
});

describe("allowsHttp", () => {
  it("ignores arbitrary loads once local networking is present, which blocked every tailnet hub", () => {
    const ats = { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true };
    expect(allowsHttp(ats, "devbox.tail1234.ts.net")).toBe(false);
    expect(allowsHttp(ats, "100.101.102.103")).toBe(false);
    expect(allowsHttp(ats, "devbox")).toBe(true);
    expect(problems({ NSAppTransportSecurity: ats })).toContain("ATS blocks plain HTTP to the hub at 100.101.102.103");
  });

  it("allows everything with arbitrary loads alone", () => {
    for (const h of [...HUBS, ...OTHERS]) expect(allowsHttp({ NSAllowsArbitraryLoads: true }, h)).toBe(true);
  });

  it("blocks everything without settings", () => {
    for (const h of [...HUBS, ...OTHERS]) expect(allowsHttp(undefined, h)).toBe(false);
  });

  it("matches exception domains by subdomain and addresses by range", () => {
    const ats = {
      NSExceptionDomains: {
        "ts.net": { NSIncludesSubdomains: true, NSExceptionAllowsInsecureHTTPLoads: true },
        "example.com": { NSExceptionAllowsInsecureHTTPLoads: true },
        "100.64.0.0/10": { NSExceptionAllowsInsecureHTTPLoads: true },
        "fd7a:115c:a1e0::/48": { NSExceptionAllowsInsecureHTTPLoads: true },
      },
    };
    expect(allowsHttp(ats, "a.b.ts.net")).toBe(true);
    expect(allowsHttp(ats, "notts.net")).toBe(false);
    expect(allowsHttp(ats, "example.com")).toBe(true);
    expect(allowsHttp(ats, "www.example.com")).toBe(false);
    expect(allowsHttp(ats, "100.127.255.255")).toBe(true);
    expect(allowsHttp(ats, "100.128.0.0")).toBe(false);
    expect(allowsHttp(ats, "[FD7A:115C:A1E0:AB12::1]")).toBe(true);
    expect(allowsHttp(ats, "fd7a:115c:a1e1::1")).toBe(false);
  });

  it("lets an exception refuse what a global key allows", () => {
    const ats = { NSAllowsArbitraryLoads: true, NSExceptionDomains: { "example.com": {} } };
    expect(allowsHttp(ats, "example.com")).toBe(false);
    expect(allowsHttp(ats, "example.org")).toBe(true);
  });
});
