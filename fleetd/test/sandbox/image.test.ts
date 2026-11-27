// The base of a hosted box's template (sandbox/image/Dockerfile, sandbox/providers/recipe.ts): it stays buildable by
// hosted providers with no context, and its pins are fleetd's own.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAYWRIGHT_VERSION } from "../../src/node/browser/chrome.ts";
import { hosted } from "../../src/sandbox/providers/recipe.ts";
import { TESTED } from "../../src/node/runner/claude.ts";
import { BOX_FFMPEG } from "../../src/node/desktop/box_frames.ts";
import { PACKAGES } from "../../src/node/device/pins.ts";

const DOCKERFILE = readFileSync(join(import.meta.dir, "../../src/sandbox/image/Dockerfile"), "utf8");
const pin = (re: RegExp): string => {
  const m = re.exec(DOCKERFILE);
  if (!m?.[1]) throw new Error(`no pin ${String(re)} in the Dockerfile`);
  return m[1];
};

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
  expect(pin(/\/playwright-core-([0-9.]+)\.tgz/u)).toBe(PLAYWRIGHT_VERSION);
  const ci = readFileSync(join(import.meta.dir, "../../../.github/workflows/ci.yml"), "utf8");
  expect(ci).toContain(`bun-version: ${pin(/bun-v([0-9.]+)\//u)}`);
  expect(pin(/gh_([0-9.]+)_linux_amd64/u)).toMatch(/^\d+\.\d+\.\d+$/u);
});

test("a box has what fleetd's own lockfile installs run (a box sees nothing of its machine's home): real Node, npm, pnpm at the desktop app's pin, Yarn", () => {
  expect(pin(/node-v([0-9.]+)-linux-x64\.tar\.xz/u)).toMatch(/^24\./u);
  const desktop = JSON.parse(readFileSync(join(import.meta.dir, "../../../app/desktop/package.json"), "utf8")) as { packageManager: string };
  expect(desktop.packageManager).toBe(`pnpm@${pin(/\/exe\.linux-x64-([0-9.]+)\.tgz/u)}`);
  expect(pin(/\/yarn-([0-9.]+)\.tgz/u)).toMatch(/^\d+\.\d+\.\d+$/u);
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
    // The hosted recipe quotes each path (sandbox/providers/recipe.ts `word`); its checksum line names it bare.
    const fetched = [...flat.matchAll(/curl [^&]*?-o (\S+)/gu)].map((m) => m[1]!.replace(/^'(.*)'$/u, "$1"));
    expect(fetched.length).toBeGreaterThan(0);
    for (const file of fetched) expect(flat).toMatch(new RegExp(`[0-9a-f]{64}  ${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u"));
    // Nothing installed by a registry's or an installer's own latest word.
    for (const word of ["npx --", "npm install", "install.sh", "pip install", "add-apt-repository"]) expect(text).not.toContain(word);
  }
  expect(DOCKERFILE).toMatch(/URIs: https:\/\/snapshot\.ubuntu\.com\/ubuntu\/\d{8}T\d{6}Z\//u);
  // The sources the base image came with go before the first apt-get update reads the archive.
  const first = DOCKERFILE.indexOf("&& apt-get update && tries apt-get install");
  expect(first).toBeGreaterThan(0);
  expect(DOCKERFILE.indexOf("rm -f /etc/apt/sources.list.d/")).toBeLessThan(first);
  expect(DOCKERFILE.indexOf("snapshot.ubuntu.com")).toBeLessThan(first);
});

// The mirror served a broken .deb on 2026-11-27 (a hash mismatch, which apt never retries itself) and sank the build.
test("every apt install is tried up to 3 times, and the last try's own error fails the step", () => {
  const runs = DOCKERFILE.replace(/\\\n/gu, " ").split("\n").filter((l) => l.startsWith("RUN "));
  const installs = runs.filter((l) => /apt-get install|install-deps/u.test(l));
  expect(installs).toHaveLength(3);
  const tries = /^RUN (tries\(\) \{.*?done; \})/u.exec(installs[0]!)?.[1];
  expect(tries).toContain("for t in 1 2 3;");
  for (const l of installs) {
    expect(l.startsWith(`RUN ${tries} `)).toBe(true);
    expect(l.replace(/tries (apt-get install|node \S+ install-deps)/gu, "")).not.toMatch(/apt-get install|install-deps/u);
  }
  // Run as the build runs a step (bash -c with set -e at fleetd's computers, sh -c in Docker), with no pause.
  const step = (shell: string, rest: string) => {
    const r = Bun.spawnSync([shell, "-c", `set -e; cd / && ${tries!.replace("sleep 15", "sleep 0")} && ${rest}`]);
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString().trim().split("\n") };
  };
  for (const shell of ["bash", "sh"]) {
    const flaky = step(shell, `n=0 && flaky() { n=$((n + 1)); [ "$n" -ge 3 ]; } && tries flaky && echo "in after $n"`);
    expect(flaky).toEqual({ code: 0, out: "in after 3\n", err: [1, 2].map((t) => `fleetd: an apt install failed (try ${t} of 3), trying again in 15 s`) });
    const broken = step(shell, `tries sh -c 'echo "E: Unable to fetch some archives" >&2; exit 100' && echo past`);
    expect(broken.code).toBe(100);
    expect(broken.out).toBe("");
    expect(broken.err).toHaveLength(5);
    expect(broken.err.at(-1)).toBe("E: Unable to fetch some archives");
  }
});

// scripts/check.sh desktop and site, which every writer runs before a push, pass in a box as on its machine.
test("a box's desktop encodes with the node's own ffmpeg, where box-frames looks for it", () => {
  const ffmpeg = PACKAGES.find((p) => p.dest === "ffmpeg")!;
  expect(DOCKERFILE).toContain(ffmpeg.url);
  expect(DOCKERFILE).toContain(`${ffmpeg.sha256}  /tmp/ffmpeg.txz`);
  expect(DOCKERFILE).toContain(`install -m 0755 /tmp/ffmpeg/ffmpeg ${BOX_FFMPEG}`);
});

test("a box has what the pre-push checks need: GTK for Electron, and CHROME naming the headless shell", () => {
  expect(DOCKERFILE).toContain("install -y --no-install-recommends dbus-x11 libgtk-3-0t64 ");
  const chrome = /^ENV CHROME=(\S+)$/mu.exec(DOCKERFILE)?.[1];
  expect(chrome).toBe("/usr/local/bin/chrome-headless-shell");
  // The link, and guest.env naming it for sessions sandbox-guest starts.
  expect(DOCKERFILE).toContain('/chrome-headless-shell-linux64/chrome-headless-shell "$CHROME"');
  expect(DOCKERFILE).toContain(String.raw`CHROME=%s\n' "$CHROME" > /etc/fleetd/guest.env`);
});
