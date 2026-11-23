// .github/release/rollout.ts run for real against a stand-in `gh` that keeps each release as a directory: a build
// added by publish, its pass on fleetd's own hub and the first ring's gate (the cloud saying nothing), the desktop
// app's stage feeds, and a halt, a pull and a resume, each read back from rollout.json as hubs read it.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseRollout, percentAt } from "../src/update/rollout.ts";
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
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const root = ${JSON.stringify(releases)};
const [, , group, cmd, tag, ...rest] = process.argv;
const dir = join(root, tag ?? "");
const fail = (why) => { process.stderr.write(why + "\\n"); process.exit(1); };
if (group !== "release") fail("only release");
const flag = (f) => { const i = rest.indexOf(f); return i < 0 ? undefined : rest[i + 1]; };
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

const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FLEETD_CLOUD_VERSION_URL: `http://127.0.0.1:${cloud.port}/version`, GITHUB_REPOSITORY: "unlaboredlabs/fleetd" };
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
  // A tick before fleetd's own hub passed it moves nothing.
  await rollout(["tick"]);
  expect(listed()[0]!.passedAt).toBeUndefined();
  expect(existsSync(join(releases, "edge/stage10-mac.yml"))).toBe(false);

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
  expect(existsSync(join(releases, "edge/latest-mac.yml"))).toBe(false);
  expect(readFileSync(join(releases, "edge/.notes"), "utf8")).toContain("### 2026.11.23.4 (10% of hubs)");

  await rollout(["halt", "2026.11.23.4"]);
  expect(listed()[0]!.haltedAt).toBeDefined();
  await rollout(["pull", "2026.11.23.4"]);
  expect(listed()[0]!.pulledAt).toBeDefined();
  await rollout(["resume", "2026.11.23.4"]);
  expect(listed()[0]).not.toHaveProperty("haltedAt");
  expect(listed()[0]).not.toHaveProperty("pulledAt");
  // A build that isn't listed is refused, naming the ones that are.
  await expect(rollout(["halt", "2026.1.1.1"])).rejects.toThrow("2026.1.1.1 isn't in rollout.json (builds listed: 2026.11.23.4)");
});
