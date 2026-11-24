import { describe, expect, it } from "vitest";
import { explainAbandon, explainLoss } from "./explain";

const lan = "http://devbox:4790";
const tailnet = "http://100.101.102.103:4790";
const err = (code: string | undefined, message = "x") => ({ code, message });

describe("explainLoss", () => {
  it("names the cause of a failed connect, never a bare close code", () => {
    const refused = explainLoss(lan, 1006, "", err("ECONNREFUSED"), false);
    expect(refused.reason).toBe("Nothing is listening at devbox:4790");
    expect(refused.fix).toContain("fleetd doctor");
    expect(explainLoss(lan, 1006, "", err("ENOTFOUND"), false).reason).toBe("devbox can't be found");
    expect(explainLoss(lan, 1006, "", err("ETIMEDOUT"), false).reason).toContain("doesn't answer");
    expect(explainLoss("wss://hub.example.com/app", 1006, "", err("CERT_HAS_EXPIRED", "certificate has expired"), false)).toMatchObject({
      reason: "The secure connection to hub.example.com failed (certificate has expired)",
    });
    expect(explainLoss(lan, 1006, "", err(undefined, "Unexpected server response: 404"), false).fix).toContain("fleetd update");
    expect(explainLoss(lan, 1006, "", err(undefined, "Unexpected server response: 502"), false).reason).toContain("HTTP 502");
    for (const loss of [explainLoss(lan, 1006, "", undefined, true), explainLoss(lan, 1006, "", undefined, false)]) {
      expect(loss.reason).not.toMatch(/1006/u);
    }
  });

  it("says another program answered, never the HTTP parser's words, when the port speaks no HTTP", () => {
    // Node's exact error when the hub's port is held by a program that isn't a web server.
    const parse = err("HPE_INVALID_CONSTANT", "Parse Error: Expected HTTP/, RTSP/ or ICE/");
    for (const known of [false, true]) {
      const loss = explainLoss(lan, 1006, "", parse, false, known);
      expect(loss.reason).toBe("Something other than a fleetd hub answered at devbox:4790");
      expect(`${loss.reason} ${loss.fix}`).not.toMatch(/Parse Error|HTTP\/|HPE_/u);
      expect(loss.fix).toContain("fleetd doctor");
    }
    expect(explainLoss(lan, 1006, "", parse, false, true).fix).not.toContain("Check the address");
  });

  it("points a tailnet address at Tailscale", () => {
    expect(explainLoss(tailnet, 1006, "", err("EHOSTUNREACH"), false).fix).toContain("Tailscale");
    expect(explainLoss("http://devbox.tail1234.ts.net:4790", 1006, "", err("ENOTFOUND"), false).fix).toContain("Tailscale");
    expect(explainLoss(lan, 1006, "", err("EHOSTUNREACH"), false).fix).not.toContain("Tailscale");
  });

  it("reads the hub's own close reason and codes, with no doubled period", () => {
    expect(explainLoss(lan, 1000, "shutting down.", undefined, true).reason).toBe("The hub closed the connection: shutting down");
    expect(explainLoss(lan, 1001, "", undefined, true).reason).toBe("The hub is restarting or shutting down");
    // A restart says so whatever its words; an update's build reads as a version, not a raw build string.
    expect(explainLoss(lan, 1012, "hub restarting", undefined, true).reason).toBe("The hub is restarting or shutting down");
    expect(explainLoss(lan, 1001, "updating to 0.0.0-edge.202611082014+90e7a07", undefined, true).reason).toBe("The hub is restarting into a new build");
    expect(explainLoss(lan, 1006, "", undefined, true).reason).toBe("The connection to devbox:4790 dropped");
  });
});

describe("explainAbandon", () => {
  it("says which way the link went quiet", () => {
    expect(explainAbandon(lan, "not-ready").reason).toContain("never finished");
    expect(explainAbandon(tailnet, "silent").fix).toContain("Tailscale");
  });
});
