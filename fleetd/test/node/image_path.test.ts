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

test("a chat file may be in the session's own scratch dir too, so a screenshot taken as proof needn't go into the repo", () => {
  const wt = join(root, "wt2");
  const scratch = join(root, "scratch");
  mkdirSync(wt, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "shot.png"), Buffer.from("89504e470d0a1a0a0000", "hex"));
  writeFileSync(join(root, "elsewhere.png"), Buffer.from("89504e470d0a1a0a0000", "hex"));
  expect(readImage(wt, join(scratch, "shot.png"), 0, false, scratch)).toMatchObject({ name: "shot.png", mime: "image/png" });
  // Without it, or past it, still refused; a scratch dir not made yet holds nothing.
  expect(() => readImage(wt, join(scratch, "shot.png"), 0, false)).toThrow("is outside your working directory");
  expect(() => readImage(wt, join(root, "elsewhere.png"), 0, false, scratch)).toThrow("and your $TMPDIR");
  expect(() => readImage(wt, join(scratch, "../elsewhere.png"), 0, false, scratch)).toThrow("is outside your working directory");
  expect(() => readImage(wt, join(scratch, "shot.png"), 0, false, join(root, "none"))).toThrow("is outside your working directory");
});
