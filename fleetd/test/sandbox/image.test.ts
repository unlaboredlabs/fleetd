// The sandbox image's recipe (sandbox/image/): its key follows every part of it, its Dockerfile stays buildable by
// hosted providers with no context, and its pins are fleetd's own.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYWRIGHT_VERSION } from "../../src/node/browser/chrome.ts";
import { DOCKERFILE, IMAGE, imageKey, INIT, SOURCES } from "../../src/sandbox/image/recipe.ts";
import { hosted } from "../../src/sandbox/providers/recipe.ts";
import { TESTED } from "../../src/node/runner/claude.ts";

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
  expect(DOCKERFILE).toContain(`/playwright-core-${PLAYWRIGHT_VERSION}.tgz`);
  expect(DOCKERFILE).toContain(`bun-v${IMAGE.pins.bun}/`);
  expect(DOCKERFILE).toContain(`gh_${IMAGE.pins.gh}_linux_amd64`);
  const ci = readFileSync(join(import.meta.dir, "../../../.github/workflows/ci.yml"), "utf8");
  expect(ci).toContain(`bun-version: ${IMAGE.pins.bun}`);
});

test("a box has what fleetd's own lockfile installs run (a box sees nothing of its machine's home): real Node, npm, pnpm at the desktop app's pin, Yarn", () => {
  expect(DOCKERFILE).toContain(`node-v${IMAGE.pins.node}-linux-x64.tar.xz`);
  const desktop = JSON.parse(readFileSync(join(import.meta.dir, "../../../app/desktop/package.json"), "utf8")) as { packageManager: string };
  expect(desktop.packageManager).toBe(`pnpm@${IMAGE.pins.pnpm}`);
  expect(DOCKERFILE).toContain(`/exe.linux-x64-${IMAGE.pins.pnpm}.tgz`);
  expect(DOCKERFILE).toContain(`/yarn-${IMAGE.pins.yarn}.tgz`);
  for (const b of ["node", "npm", "npx", "pnpm", "yarn"]) expect(DOCKERFILE).toContain(` ${b} `);
  // `node` is Node.js itself, never Bun (a test of fleetd-cloud runs `node --input-type=module`).
  expect(DOCKERFILE).not.toContain("ln -sf bun /usr/local/bin/node");
});

// What goes into an image is fleetd's to say (W756): a source that changes under a build broke the hosted template on
// 2026-11-20 (a PPA boat.dev's base image carries). So every download is checked against a SHA-256 written here, and
// every package comes from Ubuntu's own archive on one day.
test("every download into an image is checked against its pinned SHA-256, and apt reads Ubuntu's archive on one day", () => {
  const hostedText = hosted(DOCKERFILE, { claude: TESTED });
  for (const text of [DOCKERFILE, hostedText]) {
    const flat = text.replace(/\\\n/gu, " ");
    const fetched = [...flat.matchAll(/curl [^&]*?-o (\S+)/gu)].map((m) => m[1]!);
    expect(fetched.length).toBeGreaterThan(0);
    for (const file of fetched) expect(flat).toMatch(new RegExp(`[0-9a-f]{64}  ${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u"));
    // Nothing installed by a registry's or an installer's own latest word.
    for (const word of ["npx --", "npm install", "install.sh", "pip install", "add-apt-repository"]) expect(text).not.toContain(word);
  }
  expect(DOCKERFILE).toMatch(/URIs: https:\/\/snapshot\.ubuntu\.com\/ubuntu\/\d{8}T\d{6}Z\//u);
  // The sources the base image came with go before the first apt-get update reads the archive.
  const first = DOCKERFILE.indexOf("&& apt-get update && apt-get install");
  expect(DOCKERFILE.indexOf("rm -f /etc/apt/sources.list.d/")).toBeLessThan(first);
  expect(DOCKERFILE.indexOf("snapshot.ubuntu.com")).toBeLessThan(first);
});

test("the init parses, and starts sandbox-guest on the link socket", () => {
  const ran = Bun.spawnSync(["bash", "-n", join(dir, "init.sh")], { stderr: "pipe" });
  expect(ran.stderr.toString()).toBe("");
  expect(ran.exitCode).toBe(0);
  expect(INIT).toContain('"$exe" sandbox-guest --listen "$link" --dir /run/fleetd/guest');
});

// scripts/check.sh desktop and site, which every writer runs before a push, pass in a box as on its machine.
test("a box has what the pre-push checks need: GTK for Electron, and CHROME naming the headless shell", () => {
  expect(DOCKERFILE).toContain("install -y --no-install-recommends dbus-x11 libgtk-3-0t64 ");
  const chrome = /^ENV CHROME=(\S+)$/mu.exec(DOCKERFILE)?.[1];
  expect(chrome).toBe("/usr/local/bin/chrome-headless-shell");
  // The link, and guest.env naming it for sessions sandbox-guest starts.
  expect(DOCKERFILE).toContain('/chrome-headless-shell-linux64/chrome-headless-shell "$CHROME"');
  expect(DOCKERFILE).toContain(String.raw`CHROME=%s\n' "$CHROME" > /etc/fleetd/guest.env`);
  // build.sh checks both in the image it builds.
  const build = readFileSync(join(dir, "build.sh"), "utf8");
  expect(build).toContain("ldd /usr/lib/x86_64-linux-gnu/libgtk-3.so.0");
  expect(build).toContain('"$CHROME" --version');
});

test("the init gives each box a machine id of its own, as systemd's: 32 hex digits, new each boot", () => {
  const lines = INIT.split("\n").filter((l) => l.includes("/etc/machine-id") && !l.trim().startsWith("#"));
  expect(lines.length).toBeGreaterThan(0);
  const tmp = mkdtempSync(join(tmpdir(), "machine-id-"));
  try {
    const file = join(tmp, "machine-id");
    const ids = [1, 2].map(() => {
      const ran = Bun.spawnSync(["bash", "-euc", lines.join("\n").replaceAll("/etc/machine-id", file)], { stderr: "pipe" });
      expect(ran.stderr.toString()).toBe("");
      return readFileSync(file, "utf8");
    });
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}\n$/u);
    expect(ids[0]).not.toBe(ids[1]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
