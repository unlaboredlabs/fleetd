// A hosted start's steps as the apps draw them (W792): its computer, its files, getting ready.
import { expect, test } from "bun:test";
import { startStep } from "../../src/node/place/hosted_steps.ts";

test("each hosted step is the start step the apps draw it as", () => {
  expect(["computer", "template", "again", { older: "2026-11-20", building: true }].map((s) => startStep(s as never))).toEqual(["box", "box", "box", "box"]);
  expect(startStep("clone")).toBe("files");
  expect(startStep("files")).toBe("files");
  expect(startStep("setup")).toBe("session");
});
