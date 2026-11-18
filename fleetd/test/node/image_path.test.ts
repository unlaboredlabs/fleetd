// chat_file's file (src/node/actions/image.ts readImage): relative to the agent's working directory, or absolute
// inside it, as the tool says; never outside it.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readImage } from "../../src/node/actions/image.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-image-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a chat file is read by a path relative to the working directory, or absolute inside it, never outside", () => {
  const wt = join(root, "wt");
  mkdirSync(join(wt, "shots"), { recursive: true });
  writeFileSync(join(wt, "shots/a.csv"), "a,b\n1,2\n");
  writeFileSync(join(root, "outside.csv"), "x\n");
  expect(readImage(wt, "shots/a.csv", 0, true).name).toBe("a.csv");
  expect(readImage(wt, join(wt, "shots/a.csv"), 0, true).name).toBe("a.csv");
  expect(() => readImage(wt, join(root, "outside.csv"), 0, true)).toThrow("is outside your working directory");
  expect(() => readImage(wt, "../outside.csv", 0, true)).toThrow("is outside your working directory");
});
