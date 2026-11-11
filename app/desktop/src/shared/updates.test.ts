import { describe, expect, it } from "vitest";
import { aboutVersions, knownVersion, shortLabels, versionLabel } from "./updates";

describe("versions", () => {
  it("knows a released version, and not a local build's 0.0.0 or something that doesn't parse", () => {
    expect(knownVersion("0.6.0-edge.202610221030+abc1234")).toBe(true);
    expect(knownVersion("0.0.0")).toBe(false);
    expect(knownVersion("0.0.0+abc1234")).toBe(false);
    expect(knownVersion("0.0.0-edge.202610221030+abc1234")).toBe(true);
    expect(knownVersion("devel")).toBe(false);
    expect(knownVersion(undefined)).toBe(false);
  });

  it("reads an Edge build by when it was built, and any other version as itself", () => {
    expect(versionLabel("0.0.0-edge.202610261056+1b563d7")).toBe("Edge · Oct 26, 10:56");
    expect(versionLabel("0.6.0-edge.202601020304+ABCDEF0123")).toBe("Edge · Jan 2, 03:04");
    expect(versionLabel("0.6.0-edge.202610221030")).toBe("Edge · Oct 22, 10:30");
    expect(versionLabel("v0.6.0")).toBe("0.6.0");
    expect(versionLabel("0.6.0+abc1234")).toBe("0.6.0");
    expect(versionLabel("0.6.0-rc.1+abc1234")).toBe("0.6.0-rc.1");
    // Not a real month: shown as it is, never as a made-up date.
    expect(versionLabel("0.6.0-edge.202613221030+abc1234")).toBe("0.6.0-edge.202613221030");
  });

  it("reads a nightly build, from before Edge had its name, as Edge", () => {
    expect(versionLabel("0.0.0-nightly.202610261056+1b563d7")).toBe("Edge · Oct 26, 10:56");
    expect(knownVersion("0.0.0-nightly.202610221030+abc1234")).toBe(true);
  });

  it("says the hub's longer Edge labels in a line as this app does, and leaves the rest", () => {
    expect(shortLabels("Edge · Oct 26, 10:56 UTC · 1b563d7 didn't come up healthy, so Edge · Oct 25, 10:00 UTC runs again")).toBe(
      "Edge · Oct 26, 10:56 didn't come up healthy, so Edge · Oct 25, 10:00 runs again",
    );
    expect(shortLabels("checksum mismatch (expected 9f2c1ab7, got 41ab0c9d)")).toBe("checksum mismatch (expected 9f2c1ab7, got 41ab0c9d)");
  });

  it("gives the About panel the label and the raw version to copy", () => {
    const edge = "0.0.0-edge.202610231259+bdd3566";
    expect(aboutVersions(edge, true)).toEqual({ applicationVersion: "Edge · Oct 23, 12:59", version: edge });
    expect(aboutVersions(edge, false)).toEqual({ applicationVersion: `Edge · Oct 23, 12:59 (${edge})` });
    expect(aboutVersions("0.6.0", true)).toEqual({ applicationVersion: "0.6.0", version: "0.6.0" });
    expect(aboutVersions("0.6.0", false)).toEqual({ applicationVersion: "0.6.0" });
  });
});
