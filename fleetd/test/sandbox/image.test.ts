// The sandbox image's recipe (sandbox/image/): its key follows every part of it, its Dockerfile stays buildable by
// hosted providers with no context, and its pins are fleetd's own.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAYWRIGHT_VERSION } from "../../src/node/browser/chrome.ts";
import { DOCKERFILE, IMAGE, imageKey, INIT, SOURCES } from "../../src/sandbox/image/recipe.ts";

const dir = join(import.meta.dir, "../../src/sandbox/image");

test("the key is the recipe's hash, and any part of it changes it", () => {
  const parts = { dockerfile: DOCKERFILE, init: INIT, build: readFileSync(join(dir, "build.sh"), "utf8"), sources: SOURCES };
  expect(imageKey(parts)).toBe(IMAGE.key);
  expect(IMAGE.tag).toBe(`vm-${IMAGE.key.slice(0, 12)}`);
  for (const changed of [
    { ...parts, dockerfile: `${parts.dockerfile}\n` },
    { ...parts, init: `${parts.init}#` },
    { ...parts, build: `${parts.build} ` },
    { ...parts, sources: { ...SOURCES, passt: { ...SOURCES.passt, commit: "0".repeat(40) } } },
  ]) {
    expect(imageKey(changed)).not.toBe(IMAGE.key);
  }
});

test("the Dockerfile is one FROM, by digest, then RUN and ENV lines only", () => {
  const steps = DOCKERFILE.replace(/\\\n/gu, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  expect(steps[0]).toMatch(/^FROM ubuntu@sha256:[0-9a-f]{64}$/u);
  for (const step of steps.slice(1)) expect(step).toMatch(/^(RUN|ENV) /u);
  expect(DOCKERFILE).not.toContain("<<");
});

test("its pins are fleetd's own: Playwright's and bun's", () => {
  expect(IMAGE.pins.playwright).toBe(PLAYWRIGHT_VERSION);
  expect(DOCKERFILE).toContain(`playwright@${PLAYWRIGHT_VERSION} `);
  expect(DOCKERFILE).toContain(`bun-v${IMAGE.pins.bun}/`);
  expect(DOCKERFILE).toContain(`gh_${IMAGE.pins.gh}_linux_amd64`);
  const ci = readFileSync(join(import.meta.dir, "../../../.github/workflows/ci.yml"), "utf8");
  expect(ci).toContain(`bun-version: ${IMAGE.pins.bun}`);
});

test("the init parses, and starts sandbox-guest on the link socket", () => {
  const ran = Bun.spawnSync(["bash", "-n", join(dir, "init.sh")], { stderr: "pipe" });
  expect(ran.stderr.toString()).toBe("");
  expect(ran.exitCode).toBe(0);
  expect(INIT).toContain('"$exe" sandbox-guest --listen "$link" --dir /run/fleetd/guest');
});
