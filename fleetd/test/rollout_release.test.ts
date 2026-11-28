// .github/release/rollout.ts run for real against a stand-in `gh` that keeps each release as a directory: a build
// added by publish, its pass on fleetd's own hub and the first ring's gate (the cloud saying nothing), the desktop
// app's stage feeds, and a halt, a pull and a resume, each read back from rollout.json as hubs read it; an urgent fix
// sent to everyone at once, and launch day's drill: a dry-run halt, then a real halt and resume.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseRollout, percentAt, pick } from "../src/update/rollout.ts";
import { tempHome } from "./helpers.ts";

// Each write waits 3 s and reads rollout.json back.
setDefaultTimeout(60_000);

const home = tempHome();
afterAll(home.done);
const ROOT = resolve(import.meta.dir, "../..");
const releases = join(home.dir, "releases");
const bin = join(home.dir, "bin");

/** `gh release …` over `releases/<tag>/<file>`: what rollout.ts asks of it. */
const GH = `#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const root = ${JSON.stringify(releases)};
const [, , group, cmd, tag, ...rest] = process.argv;
const dir = join(root, tag ?? "");
const fail = (why) => { process.stderr.write(why + "\\n"); process.exit(1); };
if (group !== "release") fail("only release");
const flag = (f) => { const i = rest.indexOf(f); return i < 0 ? undefined : rest[i + 1]; };
// GH_FAIL="<cmd> <status> <times>": that many of <cmd>'s calls answer HTTP <status> first; each call is counted.
const [failCmd, failStatus, failTimes] = (process.env.GH_FAIL ?? "").split(" ");
if (cmd === failCmd) {
  const counter = join(root, ".calls-" + cmd);
  const calls = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
  writeFileSync(counter, String(calls));
  if (calls <= Number(failTimes)) fail("HTTP " + failStatus + ": (https://api.github.com/repos/unlaboredlabs/fleetd/releases/426013942)");
}
if (cmd === "view") {
  if (!existsSync(dir)) fail("release not found");
  const names = readdirSync(dir).filter((n) => !n.startsWith("."));
  if (flag("-q") === ".assets[].name") console.log(names.join("\\n"));
  else console.log(JSON.stringify(names.map((name) => ({ name, createdAt: statSync(join(dir, name)).mtime.toISOString() }))));
} else if (cmd === "download") {
  const name = flag("-p");
  if (!existsSync(join(dir, name))) fail("no assets match the file pattern");
  mkdirSync(flag("-D"), { recursive: true });
  copyFileSync(join(dir, name), join(flag("-D"), name));
} else if (cmd === "upload") {
  if (!existsSync(dir)) fail("release not found");
  for (const f of rest.filter((a) => !a.startsWith("--"))) copyFileSync(f, join(dir, basename(f)));
} else if (cmd === "edit") {
  writeFileSync(join(dir, ".notes"), flag("--notes") ?? "");
} else if (cmd === "create") {
  mkdirSync(dir, { recursive: true });
} else if (cmd === "delete-asset") {
  rmSync(join(dir, rest[0]), { force: true });
} else fail("unknown " + cmd);
`;

mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "gh"), GH);
chmodSync(join(bin, "gh"), 0o755);
// The cloud's /version: not there yet, as before fleetd-cloud ships it.
const cloud = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not found", { status: 404 }) });
afterAll(() => cloud.stop(true));

const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FLEETD_CLOUD_VERSION_URL: `http://127.0.0.1:${cloud.port}/version`, GITHUB_REPOSITORY: "unlaboredlabs/fleetd", ROLLOUT_GH_RETRY_MS: "10" };
/** Run apart from this process, whose fake cloud answers meanwhile. */
const rollout = async (args: string[], cwd = ROOT, more: Record<string, string> = {}) => {
  const child = Bun.spawn(["bun", join(ROOT, ".github/release/rollout.ts"), ...args], { cwd, env: { ...env, ...more }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if ((await child.exited) !== 0) throw new Error(`rollout.ts ${args.join(" ")}: ${out}${err}`);
  return out;
};
const listed = () => parseRollout(readFileSync(join(releases, "edge/rollout.json"), "utf8")).builds;

test("a build goes from publish through fleetd's own hub to everyone's stages, and a halt, a pull and a resume reach hubs", async () => {
  mkdirSync(join(releases, "edge"), { recursive: true });
  // Edge's feed from before rollouts, which every app reads until a build reaches its stage.
  const before = "version: 0.0.0-edge.202611230900+aaaaaaa\nfiles:\n  - url: app-old.zip\npath: app-old.zip\n";
  writeFileSync(join(releases, "edge/latest-mac.yml"), before);
  // The build's own release, as publish.sh leaves it: its pinned CLI and its desktop feed.
  mkdirSync(join(releases, "build-2026.11.23.4"), { recursive: true });
  writeFileSync(join(releases, "build-2026.11.23.4/latest-mac.yml"), "version: 0.0.0-edge.202611231406.4\nfiles:\n  - url: app-1234.zip\npath: app-1234.zip\n");
  const dist = join(home.dir, "dist");
  mkdirSync(dist, { recursive: true });
  const sha = "b".repeat(64);
  writeFileSync(join(dist, "release.json"), JSON.stringify({ sha256: { "fleetd-bun-linux-x64": sha, "fleetd-linux-x64": sha, "fleetd-desktop-macos-universal.zip": sha }, appVersion: "0.0.0-edge.202611231406.4+5877c50" }));
  writeFileSync(join(dist, "changes.json"), JSON.stringify({ changes: [{ commit: "c".repeat(40), subject: "fix(hub): a lead's turn ends cleanly (W1) (#2)" }] }));
  await rollout(["add"], dist, { BUILD: "2026.11.23.4", VERSION: "0.0.0-edge.202611231406.4+5877c50", RELEASE_SHA: "d".repeat(40) });
  let [b] = listed();
  // Only the Bun CLI's builds: the Rust-era names and the app are read elsewhere.
  expect(b).toMatchObject({ build: "2026.11.23.4", sha256: { "fleetd-bun-linux-x64": sha }, notes: ["A lead's turn ends cleanly"] });
  expect(Object.keys(b!.sha256)).toEqual(["fleetd-bun-linux-x64"]);
  expect(b!.passedAt).toBeUndefined();
  expect(readFileSync(join(releases, "build-2026.11.23.4/.notes"), "utf8")).toContain("- A lead's turn ends cleanly");
  // From the first build on, every stage feed is there, so an app from before it fell back to latest by itself never
  // gets a 404: before a build reaches a stage, its feed is edge's latest as it stands.
  for (const stage of ["stage10", "stage50"]) expect(readFileSync(join(releases, `edge/${stage}-mac.yml`), "utf8")).toBe(before);
  // A tick before fleetd's own hub passed it moves nothing.
  await rollout(["tick"]);
  expect(listed()[0]!.passedAt).toBeUndefined();
  expect(readFileSync(join(releases, "edge/stage10-mac.yml"), "utf8")).toBe(before);

  // fleetd's own hub passed; the cloud doesn't say what it runs, so the gate passes it without the cloud.
  await rollout(["pass", "2026.11.23.4"]);
  [b] = listed();
  expect(b!.passedAt).toBeDefined();
  expect(b!.cloud).toBe("skipped: the cloud doesn't say which fleetd it runs");
  expect(percentAt(b!, Date.now())).toBe(10);
  // The first stage's apps get its feed, named in the build's own release; everyone's waits.
  expect(readFileSync(join(releases, "edge/stage10-mac.yml"), "utf8")).toContain(
    "url: https://github.com/unlaboredlabs/fleetd/releases/download/build-2026.11.23.4/app-1234.zip",
  );
  expect(readFileSync(join(releases, "edge/stage50-mac.yml"), "utf8")).toBe(before);
  expect(readFileSync(join(releases, "edge/latest-mac.yml"), "utf8")).toBe(before);
  expect(readFileSync(join(releases, "edge/.notes"), "utf8")).toContain("### 2026.11.23.4 (10% of hubs)");

  await rollout(["halt", "2026.11.23.4"]);
  expect(listed()[0]!.haltedAt).toBeDefined();
  await rollout(["pull", "2026.11.23.4"]);
  expect(listed()[0]!.pulledAt).toBeDefined();
  await rollout(["resume", "2026.11.23.4"]);
  expect(listed()[0]).not.toHaveProperty("haltedAt");
  expect(listed()[0]).not.toHaveProperty("pulledAt");
  // Steady never takes it now.
  expect(listed()[0]!.wasHalted).toBe(true);
  // A build that isn't listed is refused, naming the ones that are.
  await expect(rollout(["halt", "2026.1.1.1"])).rejects.toThrow("2026.1.1.1 isn't in rollout.json (builds listed: 2026.11.23.4)");
});

test("a GitHub 5xx on a write is tried again until it passes, and a 4xx fails at once", async () => {
  mkdirSync(join(releases, "edge"), { recursive: true });
  const calls = join(releases, ".calls-edit");
  rmSync(calls, { force: true });
  rmSync(join(releases, "edge/.notes"), { force: true });
  // Edge's notes edit, as on Nov 25: GitHub answers 500, then takes it.
  const out = await rollout(["tick"], ROOT, { GH_FAIL: "edit 500 1" });
  expect(out).toContain("gh release edit failed (try 1 of 5)");
  expect(readFileSync(calls, "utf8")).toBe("2");
  expect(existsSync(join(releases, "edge/.notes"))).toBe(true);

  // A refusal of what was asked isn't GitHub's blip: one try, and the tick fails with GitHub's answer.
  rmSync(calls, { force: true });
  await expect(rollout(["tick"], ROOT, { GH_FAIL: "edit 422 1" })).rejects.toThrow("HTTP 422");
  expect(readFileSync(calls, "utf8")).toBe("1");
});

test("a build number listed for one commit is never listed for another: the publish fails, rollout.json stays", async () => {
  mkdirSync(join(releases, "edge"), { recursive: true });
  mkdirSync(join(releases, "build-0.9.12"), { recursive: true });
  const dist = join(home.dir, "dist-reused");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "release.json"), JSON.stringify({ sha256: { "fleetd-bun-linux-x64": "e".repeat(64) } }));
  await rollout(["add"], dist, { BUILD: "0.9.12", VERSION: "0.9.12+20261125.274dd98", RELEASE_SHA: "1".repeat(40) });
  const before = readFileSync(join(releases, "edge/rollout.json"), "utf8");
  // This publish run again: nothing new.
  await rollout(["add"], dist, { BUILD: "0.9.12", VERSION: "0.9.12+20261125.274dd98", RELEASE_SHA: "1".repeat(40) });
  expect(readFileSync(join(releases, "edge/rollout.json"), "utf8")).toBe(before);
  // As on Nov 27: a later build that got 0.9.12 again.
  await expect(rollout(["add"], dist, { BUILD: "0.9.12", VERSION: "0.9.12+20261127.6c77787", RELEASE_SHA: "2".repeat(40) })).rejects.toThrow(
    `0.9.12 is already listed as ${"1".repeat(40)}'s build, not ${"2".repeat(40)}'s`,
  );
  expect(readFileSync(join(releases, "edge/rollout.json"), "utf8")).toBe(before);
});

test("launch day's commands: an urgent fix is everyone's at once; a dry-run halt says what would move and writes nothing; a halt takes a build off its stage and hubs, a resume puts it back", async () => {
  rmSync(releases, { recursive: true, force: true });
  mkdirSync(join(releases, "edge"), { recursive: true });
  // Apps from before Edge's rename read the nightly release's copy of everyone's feed.
  mkdirSync(join(releases, "nightly"), { recursive: true });
  writeFileSync(join(releases, "edge/latest-mac.yml"), "version: 0.9.1\nfiles:\n  - url: app-old.zip\npath: app-old.zip\n");
  const sha = "f".repeat(64);
  /** Publishes a build that built its own app, as publish.sh leaves it. */
  const publish = async (build: string, commit: string) => {
    mkdirSync(join(releases, `build-${build}`), { recursive: true });
    writeFileSync(join(releases, `build-${build}/latest-mac.yml`), `version: ${build}\nfiles:\n  - url: app-${build}.zip\npath: app-${build}.zip\n`);
    const dist = join(home.dir, `dist-${build}`);
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "release.json"), JSON.stringify({ sha256: { "fleetd-bun-linux-x64": sha }, appVersion: `${build}+20261128.${commit.slice(0, 7)}` }));
    await rollout(["add"], dist, { BUILD: build, VERSION: `${build}+20261128.${commit.slice(0, 7)}`, RELEASE_SHA: commit });
  };
  const feed = (stage: string) => readFileSync(join(releases, `edge/${stage}-mac.yml`), "utf8").match(/build-([\d.]+)\//)?.[1];
  const edge = () => Object.fromEntries(["rollout.json", "stage10-mac.yml", "stage50-mac.yml", "latest-mac.yml", ".notes"].map((n) => [n, readFileSync(join(releases, "edge", n), "utf8")]));
  const hub = (running: string) => pick({ builds: listed() }, { ring: "everyone", bucket: 5, speed: "fast" }, running, Date.now());

  // A security fix, sent straight to everyone: no wait on fleetd's own hub, the cloud or the stages.
  await publish("0.9.20", "2".repeat(40));
  const urgent = await rollout(["urgent", "0.9.20"]);
  expect(urgent).toContain("0.9.20: sent to everyone at once");
  let [b] = listed();
  expect(b!.urgentAt).toBeDefined();
  expect(b!.cloud).toBe("skipped: sent to everyone at once, as an urgent fix");
  // A hub from before urgentAt reads its share from passedAt alone: 100% there too.
  expect(percentAt(b!, Date.now())).toBe(100);
  expect([feed("stage10"), feed("stage50"), feed("latest")]).toEqual(["0.9.20", "0.9.20", "0.9.20"]);
  expect(readFileSync(join(releases, "edge/.notes"), "utf8")).toMatch(/### 0\.9\.20 · \w+ \d+ \(sent to everyone at once\)/);
  // Nothing left to move: the ticker ends.
  await expect(rollout(["moving"])).rejects.toThrow();

  // The next build, the usual way: its first stage only.
  await publish("0.9.21", "3".repeat(40));
  await rollout(["pass", "0.9.21"]);
  expect([feed("stage10"), feed("stage50"), feed("latest")]).toEqual(["0.9.21", "0.9.20", "0.9.20"]);
  expect(hub("0.9.20+20261128.2222222")).toMatchObject({ kind: "move", build: { build: "0.9.21" } });

  // The drill: a dry-run halt reads edge as it is, says each write it would make, and changes nothing.
  const was = edge();
  const dry = await rollout(["halt", "0.9.21"], ROOT, { ROLLOUT_DRY_RUN: "1" });
  expect(dry).toContain("0.9.21: halted");
  expect(dry).toContain("dry run, not written: rollout.json");
  // The halted build's stage goes back to the one before, as a real halt would.
  expect(dry).toContain("stage10-mac.yml: 0.9.20");
  expect(dry).toContain("dry run, not done: gh release upload edge");
  expect(edge()).toEqual(was);

  // The real halt: nobody new takes it, its stage serves the build before, and a hub on it keeps it.
  await rollout(["halt", "0.9.21"]);
  expect(listed()[0]!.haltedAt).toBeDefined();
  expect(feed("stage10")).toBe("0.9.20");
  expect(hub("0.9.20+20261128.2222222")).toMatchObject({ kind: "stay" });
  expect(hub("0.9.21+20261128.3333333")).toMatchObject({ kind: "stay" });
  // A halted build can't be sent to everyone before it's resumed.
  await expect(rollout(["urgent", "0.9.21"])).rejects.toThrow("0.9.21 is halted: resume it first");
  // The resume: its stage gets it again, and the hubs in it move on.
  await rollout(["resume", "0.9.21"]);
  expect(listed()[0]).not.toHaveProperty("haltedAt");
  expect(feed("stage10")).toBe("0.9.21");
  expect(hub("0.9.20+20261128.2222222")).toMatchObject({ kind: "move", build: { build: "0.9.21" } });
}, 180_000);
