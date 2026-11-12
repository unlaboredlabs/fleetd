import { expect, test } from "bun:test";
import { nextNight, refreshedSummary } from "../src/hub/memory/refresh_rules.ts";
import { linesOf, nameOf, projectDirName, projectTarget, youTarget } from "../src/hub/memory/target.ts";
import { markShadowed } from "../src/hub/skills/kept.ts";
import { isLocal, parse, sourceOf } from "../src/hub/skills/source.ts";

test("which memory file a target is, a project's directory name, and a file's lines", () => {
  expect(nameOf({})).toBe("user.md");
  expect(nameOf(projectTarget({ machineId: "m", projectId: "p" }))).toBe("MEMORY.md");
  expect(nameOf(projectTarget({ machineId: "m", projectId: "p" }, "deploys"))).toBe("deploys.md");
  expect(youTarget({ kind: "person", person: "p_1" as never })).toEqual({ person: "p_1" });
  expect(youTarget({ kind: "nobody" })).toBeUndefined();
  expect(projectDirName({ machineId: "m", projectId: "site" })).toBe("site");
  expect(projectDirName({ machineId: "m", projectId: "a/b" })).toMatch(/^p-[0-9a-f]{16}$/);
  expect(linesOf("a\r\nb\n")).toEqual(["a", "b"]);
});

test("a refresh's next night and its summary line", () => {
  const at = { hour: 4, minute: 0 };
  expect(nextNight(Date.parse("2026-11-03T05:00:00Z"), "UTC", at)).toBe(Date.parse("2026-11-04T04:00:00Z"));
  expect(nextNight(Date.parse("2026-11-03T03:00:00Z"), "UTC", at)).toBe(Date.parse("2026-11-03T04:00:00Z"));
  expect(refreshedSummary([{ text: "a" }, { text: "b", replaced: "x" }, { text: "c", forgotten: true }, { text: "d" }] as never)).toBe(
    "Memory refreshed: +2 ~1 −1",
  );
});

test("a skill's source as skills.sh writes it, and which skill of a name wins", () => {
  const s = parse("acme/tools@lint");
  expect(s).toMatchObject({ skill: "lint" });
  expect(isLocal(s)).toBe(false);
  expect(isLocal({ url: "/home/me/skills", gitRef: "HEAD", path: "" })).toBe(true);
  expect(sourceOf({ source: "x", url: "u", ref: "r", commit: "c", path: "p", installedAt: "t" })).toEqual({ url: "u", gitRef: "r", path: "p" });
  const list = [
    { name: "lint", origin: "global" },
    { name: "lint", origin: "project" },
    { name: "a", origin: "global" },
  ] as never as { name: string; origin: string; shadowedBy?: string }[];
  markShadowed(list as never);
  expect(list.map((s) => [s.name, s.origin, s.shadowedBy])).toEqual([
    ["lint", "project", undefined],
    ["a", "global", undefined],
    ["lint", "global", "project"],
  ]);
});
