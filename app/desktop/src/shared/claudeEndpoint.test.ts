import { describe, expect, it } from "vitest";
import { ANTHROPIC_ENDPOINT, endpointShown, endpointToSave, hostOf, onTailnet, tailnetLine } from "./claudeEndpoint";

describe("the hub's Claude endpoint", () => {
  it("keeps nothing for Anthropic's own, as prefilled or emptied", () => {
    expect(endpointToSave(ANTHROPIC_ENDPOINT)).toBeUndefined();
    expect(endpointToSave("https://api.anthropic.com/ ")).toBeUndefined();
    expect(endpointToSave("HTTPS://API.ANTHROPIC.COM")).toBeUndefined();
    expect(endpointToSave("  ")).toBeUndefined();
    expect(endpointToSave("http://100.101.102.103:8317/")).toBe("http://100.101.102.103:8317");
  });

  it("shows Anthropic's own until one is saved", () => {
    expect(endpointShown(undefined)).toBe(ANTHROPIC_ENDPOINT);
    expect(endpointShown("https://gateway.example.com")).toBe("https://gateway.example.com");
  });

  it("reads the host of an http or https URL", () => {
    expect(hostOf("http://100.101.102.103:8317")).toBe("100.101.102.103");
    expect(hostOf("https://user:pw@Claude.Tail1234.TS.NET./v1")).toBe("claude.tail1234.ts.net");
    expect(hostOf("http://[fd7a:115c:a1e0::1]:8317")).toBe("fd7a:115c:a1e0::1");
    expect(hostOf("ftp://100.100.1.1")).toBeUndefined();
    expect(hostOf("100.100.1.1")).toBeUndefined();
  });

  it("knows a tailnet endpoint: 100.64.0.0/10, fd7a:115c:a1e0::/48 and *.ts.net", () => {
    for (const url of ["http://100.101.102.103:8317", "http://100.64.0.1", "http://100.127.255.255", "https://gw.tail1234.ts.net", "http://[fd7a:115c:a1e0:ab12::1]:80"]) {
      expect(onTailnet(url), url).toBe(true);
    }
    for (const url of [ANTHROPIC_ENDPOINT, "http://100.63.255.255", "http://100.128.0.1", "http://10.0.0.2:8317", "https://ts.network.example", "http://[fd7a:115d::1]", "not a url"]) {
      expect(onTailnet(url), url).toBe(false);
    }
  });

  it("says so beside a tailnet endpoint only while Tailscale isn't connected", () => {
    expect(tailnetLine("http://100.101.102.103:8317", false)).toMatch(/Tailscale is connected/u);
    expect(tailnetLine("http://100.101.102.103:8317", true)).toBeNull();
    expect(tailnetLine(ANTHROPIC_ENDPOINT, false)).toBeNull();
  });
});
