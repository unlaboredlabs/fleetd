import { describe, expect, it } from "vitest";
import { aboutVersions, splitLabels, buildCommit, knownVersion, MAX_NOTES, notesSince, subjectLines, versionLabel, type Change } from "./updates";

const change = (commit: string, subject: string, areas: string[] = ["app"]): Change => ({ commit, date: "2026-10-22T10:30:00Z", subject, areas });

describe("notesSince", () => {
  const changes = [
    change("aaa1111aaaa", "feat(desktop): updates show in the app (#268)"),
    change("ccc3333cccc", "fix(hub): the hub reports its version (#277)", ["hub"]),
    change("ddd4444dddd", "batch: fix(desktop): the chat keeps your draft (#250); test(lab): the lead chat end to end (#226)", ["app", "other"]),
    change("bbb2222bbbb", "feat(desktop): status loads faster (#240)"),
    change("eee5555eeee", "feat: first release (#1)"),
  ];

  it("lists what came after this version's commit in one area, a line per PR, newest first", () => {
    expect(notesSince(changes, "0.6.0-edge.202610221030+bbb2222", "app")).toEqual({
      lines: ["Updates show in the app", "The chat keeps your draft", "The lead chat end to end"],
      more: false,
    });
    expect(notesSince(changes, "0.6.0-edge.202610221030+bbb2222", "hub")).toEqual({ lines: ["The hub reports its version"], more: false });
  });

  it("has nothing new for the newest commit", () => {
    expect(notesSince(changes, "0.6.0-edge.202610231030+aaa1111", "app")).toEqual({ lines: [], more: false });
  });

  it("gives the newest lines and says there is more for a version not in the list, or without a commit", () => {
    expect(notesSince(changes, "0.4.0+fff6666", "app").more).toBe(true);
    expect(notesSince(changes, "0.0.0", "app").lines[0]).toBe("Updates show in the app");
    const many = Array.from({ length: 30 }, (_, i) => change(`f${String(i).padStart(6, "0")}`, `feat: change ${String(i)} (#${String(i)})`));
    expect(notesSince(many, "0.4.0+abcdef0", "app")).toMatchObject({ more: true, lines: { length: MAX_NOTES } });
  });
});

describe("subjectLines", () => {
  it("drops the conventional prefix and the PR number, and splits a batch", () => {
    expect(subjectLines("fix(cli): fleetd status says \"1 item\" (#249)")).toEqual(['fleetd status says "1 item"']);
    expect(subjectLines("batch: a (#1); feat!: b (#2)")).toEqual(["A", "B"]);
    expect(subjectLines("Merge branch 'main'")).toEqual([]);
  });
});

describe("versions", () => {
  it("reads the build commit", () => {
    expect(buildCommit("0.6.0-edge.202610221030+ABC1234")).toBe("abc1234");
    expect(buildCommit("0.6.0")).toBeNull();
  });

  it("knows a released version, and not a local build's 0.0.0 or something that doesn't parse", () => {
    expect(knownVersion("0.6.0-edge.202610221030+abc1234")).toBe(true);
    expect(knownVersion("0.0.0")).toBe(false);
    expect(knownVersion("0.0.0+abc1234")).toBe(false);
    expect(knownVersion("0.0.0-edge.202610221030+abc1234")).toBe(true);
    expect(knownVersion("devel")).toBe(false);
    expect(knownVersion(undefined)).toBe(false);
  });

  it("reads an Edge build by when and from which commit it was built, and any other version as itself", () => {
    expect(versionLabel("0.0.0-edge.202610261056+1b563d7")).toBe("Edge · Oct 26, 10:56 UTC · 1b563d7");
    expect(versionLabel("0.6.0-edge.202601020304+ABCDEF0123")).toBe("Edge · Jan 2, 03:04 UTC · abcdef0");
    expect(versionLabel("0.6.0-edge.202610221030")).toBe("Edge · Oct 22, 10:30 UTC");
    expect(versionLabel("v0.6.0")).toBe("0.6.0");
    expect(versionLabel("0.6.0+abc1234")).toBe("0.6.0");
    expect(versionLabel("0.6.0-rc.1+abc1234")).toBe("0.6.0-rc.1");
    // Not a real month: shown as it is, never as a made-up date.
    expect(versionLabel("0.6.0-edge.202613221030+abc1234")).toBe("0.6.0-edge.202613221030");
  });

  it("reads a nightly build, from before Edge had its name, as Edge", () => {
    expect(versionLabel("0.0.0-nightly.202610261056+1b563d7")).toBe("Edge · Oct 26, 10:56 UTC · 1b563d7");
    expect(splitLabels(`runs ${versionLabel("0.0.0-nightly.202610251000")}`)).toEqual(["runs ", "Edge · Oct 25, 10:00 UTC", ""]);
    expect(knownVersion("0.0.0-nightly.202610221030+abc1234")).toBe(true);
  });

  it("finds the Edge labels in a line, and only them", () => {
    const line = `Put back: ${versionLabel("0.0.0-edge.202610261056+1b563d7")} didn't come up healthy, so ${versionLabel("0.0.0-edge.202610251000")} runs again`;
    expect(splitLabels(line)).toEqual([
      "Put back: ",
      "Edge · Oct 26, 10:56 UTC · 1b563d7",
      " didn't come up healthy, so ",
      "Edge · Oct 25, 10:00 UTC",
      " runs again",
    ]);
    expect(splitLabels("checksum mismatch (expected 9f2c1ab7, got 41ab0c9d)")).toEqual(["checksum mismatch (expected 9f2c1ab7, got 41ab0c9d)"]);
  });

  it("gives the About panel the label and the raw version to copy", () => {
    const edge = "0.0.0-edge.202610231259+bdd3566";
    expect(aboutVersions(edge, true)).toEqual({ applicationVersion: "Edge · Oct 23, 12:59 UTC · bdd3566", version: edge });
    expect(aboutVersions(edge, false)).toEqual({ applicationVersion: `Edge · Oct 23, 12:59 UTC · bdd3566 (${edge})` });
    expect(aboutVersions("0.6.0", true)).toEqual({ applicationVersion: "0.6.0", version: "0.6.0" });
    expect(aboutVersions("0.6.0", false)).toEqual({ applicationVersion: "0.6.0" });
  });
});

