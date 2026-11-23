// The rollout of numbered builds (D701): which build a hub picks (src/update/rollout.ts), how a version reads, and the
// release side's pure rules (.github/release/rollout.ts): what's new in plain words, which builds stay listed, the
// first ring's gate and the desktop app's stage feeds.
import { expect, test } from "bun:test";
import { absolute, cloudVerdict, feedBuild, gate, moving, plainNotes, prune, releaseNotes } from "../../.github/release/rollout.ts";
import { bucketOf, choose, parseRollout, parseSpeed, percentAt, pick, type Picker, type Rollout, type RolloutBuild } from "../src/update/rollout.ts";
import { buildNumber, versionLabel, versionShown } from "../src/update/version.ts";
import { versionLine } from "../src/cli/versions.ts";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const sha = "a".repeat(64);
const b = (n: number, more: Partial<RolloutBuild> = {}): RolloutBuild => ({
  build: `2026.11.23.${n}`,
  version: `0.0.0-edge.2026112310${String(n).padStart(2, "0")}.${n}+abc${n}def`,
  commit: String(n).repeat(40),
  publishedAt: ago(5 - n / 10),
  sha256: { "fleetd-bun-linux-x64": sha },
  ...more,
});
const fast = (bucket: number): Picker => ({ ring: "everyone", bucket, speed: "fast" });

test("a build's number reads from its version, in the hub's words and the CLI's", () => {
  const v = "0.0.0-edge.202611231406.4+5877c50";
  expect(buildNumber(v)).toBe("2026.11.23.4");
  expect(versionLabel(v)).toBe("2026.11.23.4");
  expect(versionShown(v)).toBe(`2026.11.23.4 (${v})`);
  expect(versionLine(v)).toBe(`fleetd 2026.11.23.4 (${v}, protocol 1)\n`);
  expect(buildNumber("0.0.0-edge.202602011406.12")).toBe("2026.2.1.12");
  // A build from before numbers reads as before.
  expect(buildNumber("0.0.0-edge.202610261056+1b563d7")).toBeUndefined();
  expect(versionLabel("0.0.0-edge.202610261056+1b563d7")).toBe("Edge · Oct 26, 10:56 UTC · 1b563d7");
});

test("the staged rollout reaches 10% at its pass, 50% an hour later, everyone after 3 hours", () => {
  expect(percentAt(b(1), NOW)).toBe(0);
  expect(percentAt(b(1, { passedAt: ago(0) }), NOW)).toBe(10);
  expect(percentAt(b(1, { passedAt: ago(1) }), NOW)).toBe(50);
  expect(percentAt(b(1, { passedAt: ago(2.99) }), NOW)).toBe(50);
  expect(percentAt(b(1, { passedAt: ago(3) }), NOW)).toBe(100);
  // Buckets are spread and stable.
  expect(bucketOf("a")).toBe(bucketOf("a"));
  const seen = new Set(Array.from({ length: 500 }, (_, i) => bucketOf(`hub-${i}`)));
  expect(seen.size).toBeGreaterThan(90);
});

test("a hub takes the newest build that reached its bucket, never an older one than it runs", () => {
  const r: Rollout = { builds: [b(3, { passedAt: ago(0.5) }), b(2, { passedAt: ago(1.5) }), b(1, { passedAt: ago(4) })] };
  const running = b(1).version;
  expect(pick(r, fast(5), running, NOW)).toMatchObject({ kind: "move", build: { build: "2026.11.23.3" }, back: false });
  expect(pick(r, fast(30), running, NOW)).toMatchObject({ kind: "move", build: { build: "2026.11.23.2" } });
  expect(pick(r, fast(80), running, NOW)).toMatchObject({ kind: "stay" });
  // On build 3 already (say by `fleetd update` by hand), a bucket 2 hasn't reached keeps it.
  expect(pick(r, fast(30), b(3).version, NOW)).toMatchObject({ kind: "stay", why: "it runs a newer build than the ones that reach it" });
  // A build that never passed the first ring reaches only fleetd's own hub.
  const fresh: Rollout = { builds: [b(4), ...r.builds] };
  expect(pick(fresh, fast(0), running, NOW)).toMatchObject({ kind: "move", build: { build: "2026.11.23.3" } });
  expect(pick(fresh, { ring: "first", bucket: 99, speed: "fast" }, running, NOW)).toMatchObject({ kind: "move", build: { build: "2026.11.23.4" } });
  // A hub on a build from before rollouts (not listed, older) moves; one on a newer unlisted build stays.
  expect(pick(r, fast(99), "0.0.0-edge.202611200000+abcdef0", NOW)).toMatchObject({ kind: "move", build: { build: "2026.11.23.1" } });
  expect(pick(r, fast(99), "0.0.0-edge.202611240000.1+abcdef0", NOW)).toMatchObject({ kind: "stay" });
});

test("halted builds go to nobody new; a pulled one sends its hubs back to the build before", () => {
  const halted: Rollout = { builds: [b(2, { passedAt: ago(4), haltedAt: ago(1) }), b(1, { passedAt: ago(5) })] };
  expect(pick(halted, fast(0), b(1).version, NOW)).toMatchObject({ kind: "stay" });
  // A hub already on the halted build keeps it.
  expect(pick(halted, fast(0), b(2).version, NOW)).toMatchObject({ kind: "stay" });
  const pulled: Rollout = { builds: [b(2, { passedAt: ago(4), pulledAt: ago(1) }), b(1, { passedAt: ago(5) })] };
  expect(pick(pulled, fast(70), b(2).version, NOW)).toMatchObject({ kind: "move", back: true, build: { build: "2026.11.23.1" } });
  expect(pick(pulled, fast(70), b(1).version, NOW)).toMatchObject({ kind: "stay" });
});

test("Update speed Steady takes only builds out 2 days and never halted; old channel names map to speeds", () => {
  const steady: Picker = { ring: "everyone", bucket: 0, speed: "steady" };
  const r: Rollout = {
    builds: [b(3, { passedAt: ago(5) }), b(2, { publishedAt: ago(49), passedAt: ago(48), haltedAt: ago(40) }), b(1, { publishedAt: ago(50), passedAt: ago(49) })],
  };
  expect(pick(r, steady, "0.0.0-edge.202611200000.1+abc", NOW)).toMatchObject({ kind: "move", build: { build: "2026.11.23.1" } });
  // Halted once and resumed: Fast hubs take it again, Steady ones never.
  const resumed: Rollout = { builds: [b(2, { publishedAt: ago(49), passedAt: ago(48), wasHalted: true }), b(1, { publishedAt: ago(50), passedAt: ago(49) })] };
  expect(pick(resumed, steady, "0.0.0-edge.202611200000.1+abc", NOW)).toMatchObject({ kind: "move", build: { build: "2026.11.23.1" } });
  expect(pick(resumed, fast(0), "0.0.0-edge.202611200000.1+abc", NOW)).toMatchObject({ kind: "move", build: { build: "2026.11.23.2" } });
  expect(parseSpeed("stable")).toBe("steady");
  expect(parseSpeed("edge")).toBe("fast");
  expect(parseSpeed("nightly")).toBe("fast");
  expect(parseSpeed("weird")).toBeUndefined();
});

test("choose reads rollout.json, and without one follows the release's newest build as before", async () => {
  const pinned = { "fleetd-bun-linux-x64": sha };
  const r = { builds: [b(1, { passedAt: ago(4), sha256: pinned })] };
  const feed = { get: async (name: string) => (name === "rollout.json" ? new TextEncoder().encode(JSON.stringify(r)) : new Uint8Array()) };
  const files = (build: string) => ({ get: async () => new TextEncoder().encode(build) });
  const c = await choose(feed, fast(50), "0.0.0-edge.202611200000.1+abc", NOW, files);
  expect(c).toMatchObject({ kind: "move", to: b(1).version, back: false });
  if (c.kind === "move") {
    expect((await c.sums()).pinned).toBe(true);
    expect(new TextDecoder().decode(await c.feed.get("x"))).toBe("2026.11.23.1");
  }
  const old = {
    get: async (name: string) => {
      if (name === "rollout.json") throw new Error("GET `rollout.json`: 404 Not Found");
      return new TextEncoder().encode(JSON.stringify({ cliVersion: "1.2.0", sha256: pinned }));
    },
  };
  expect(await choose(old, fast(50), "1.1.0", NOW)).toMatchObject({ kind: "move", to: "1.2.0" });
  expect(await choose(old, fast(50), "1.2.0", NOW)).toMatchObject({ kind: "stay" });
  // A listed build with a bad checksum is left out, not trusted.
  expect(parseRollout(JSON.stringify({ builds: [{ ...b(1), sha256: { x: "nope" } }] })).builds).toEqual([]);
});

test("what's new reads in plain words: no prefixes, workstreams or PR numbers, a batch split", () => {
  expect(
    plainNotes([
      "fix(mobile): a chat's live screens are one strip (W857) (#2132)",
      "Profiles live under their provider in Settings › Providers (W849) (#2127)",
      "batch: feat(hub): bots share a repo (W845) (#2106); A watcher no longer ends with \"0 more.\" (W791) (#2122)",
    ]),
  ).toEqual(["A chat's live screens are one strip", "Profiles live under their provider in Settings › Providers", "Bots share a repo", 'A watcher no longer ends with "0 more."']);
});

test("the list keeps every build up to the newest that reached everyone, one to go back to, and a few for Steady", () => {
  const builds = [
    b(9, { publishedAt: ago(0.2) }),
    b(8, { publishedAt: ago(1), passedAt: ago(0.5) }),
    b(7, { publishedAt: ago(4), passedAt: ago(3.5) }),
    b(6, { publishedAt: ago(5), passedAt: ago(4.5) }),
    b(5, { publishedAt: ago(5.5), passedAt: ago(5) }),
    b(4, { publishedAt: ago(29), passedAt: ago(28) }),
    b(3, { publishedAt: ago(29.5), passedAt: ago(28.5) }),
    b(2, { publishedAt: ago(100), passedAt: ago(99) }),
  ];
  expect(prune(builds, NOW).map((x) => x.build.split(".")[3])).toEqual(["9", "8", "7", "6", "4"]);
});

test("the first ring waits for the cloud, but a stale or silent cloud never holds everyone back", () => {
  const build = b(1, { hubPassedAt: ago(0.1) });
  const no = () => false;
  const fresh = () => NOW - 3_600_000;
  expect(cloudVerdict(build, { kind: "runs", fleetd: "f".repeat(40) }, NOW, () => true, fresh)).toEqual({ pass: true, words: "the cloud runs it" });
  expect(cloudVerdict(build, { kind: "runs", fleetd: "f".repeat(40) }, NOW, no, fresh)).toEqual({ pass: false });
  expect(cloudVerdict(build, { kind: "unsettled" }, NOW, no, fresh)).toEqual({ pass: false });
  expect(cloudVerdict(build, { kind: "runs", fleetd: "f".repeat(40) }, NOW, no, () => NOW - 7 * 3_600_000)).toMatchObject({ pass: true });
  expect(cloudVerdict(build, { kind: "silent", why: "doesn't say which fleetd it runs" }, NOW, no, fresh)).toMatchObject({ pass: true });
  expect(cloudVerdict(b(1, { hubPassedAt: ago(2) }), { kind: "unsettled" }, NOW, no, fresh)).toMatchObject({ pass: true });
  // Only builds fleetd's own hub passed go through the gate.
  const r: Rollout = { builds: [b(2), build] };
  expect(gate(r, () => ({ kind: "runs", fleetd: "f".repeat(40) }), NOW, () => true, fresh)).toBe(true);
  expect(r.builds.map((x) => x.passedAt !== undefined)).toEqual([false, true]);
  expect(releaseNotes(r, NOW)).toContain("### 2026.11.23.1 (10% of hubs)");
});

test("each stage feed is the newest build that reached it with an app, its files named in that build's release", () => {
  const r: Rollout = { builds: [b(3, { passedAt: ago(0.5) }), b(2, { passedAt: ago(1.5) }), b(1, { passedAt: ago(4) })] };
  const withApp = (build: string) => build !== "2026.11.23.2";
  expect(feedBuild(r, 10, NOW, withApp)).toBe("2026.11.23.3");
  expect(feedBuild(r, 50, NOW, withApp)).toBe("2026.11.23.1");
  expect(feedBuild(r, 100, NOW, withApp)).toBe("2026.11.23.1");
  expect(absolute("version: 1\nfiles:\n  - url: app-1234.zip\n    sha512: x\npath: app-1234.zip\n", "2026.11.23.1")).toBe(
    "version: 1\nfiles:\n  - url: https://github.com/unlaboredlabs/fleetd/releases/download/build-2026.11.23.1/app-1234.zip\n    sha512: x\n" +
      "path: https://github.com/unlaboredlabs/fleetd/releases/download/build-2026.11.23.1/app-1234.zip\n",
  );
});

test("the ticker ticks on while a build waits on the gate or hasn't reached everyone, and stops once none does", () => {
  expect(moving({ builds: [b(2, { hubPassedAt: ago(0.5) })] }, NOW)).toBe(true);
  expect(moving({ builds: [b(2, { passedAt: ago(2) })] }, NOW)).toBe(true);
  expect(moving({ builds: [b(2, { passedAt: ago(3.5) }), b(1, { passedAt: ago(9) })] }, NOW)).toBe(false);
  // Nothing passed fleetd's own hub yet, or what moved was halted: nothing for the ticker to do.
  expect(moving({ builds: [b(3)] }, NOW)).toBe(false);
  expect(moving({ builds: [b(3, { passedAt: ago(1), haltedAt: ago(0.5) })] }, NOW)).toBe(false);
});
