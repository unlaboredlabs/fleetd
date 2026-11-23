// Which build a machine runs (D701): every green build of main is a release numbered 0.MINOR.PATCH (0.9.4,
// release.version-scheme), and reaches machines in rings. fleetd's own hub takes each build first (ring `first`) and checks itself on it; once
// that and the cloud passed (`passedAt`, .github/release/rollout.ts), the build goes to everyone in stages, each hub
// by the bucket its own id falls in: 10% at once, 50% after an hour, everyone after 3 hours. A hub on Update speed
// Steady takes only builds that have been out 2 days and were never halted.
//
// It all comes from one static file on the edge release, rollout.json, which publish.sh adds each build to and
// .github/release/rollout.ts flags: a halted build goes to nobody new, and a pulled one sends the hubs on it back to
// the newest build before it that they may run. Each build's files are in a release of its own, `build-<number>`,
// under names that never change, so a reader never gets half a build. A hub reads it and decides alone; it never tells
// anyone what it runs. A release without rollout.json (a fork's) is followed as before: its newest build.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Failure, type Feed, HttpFeed, release, REPO, replaceFile, type Sums, sums as releaseSums } from "./index.ts";
import { versionCmp } from "./version.ts";

export type Speed = "fast" | "steady";
export type Ring = "first" | "everyone";

/** One build in rollout.json, newest first. */
export type RolloutBuild = {
  /** Its number, `<year>.<month>.<day>.<nth build that UTC day>`. */
  build: string;
  /** The CLI's version: what `fleetd --version` and hubs report. */
  version: string;
  commit: string;
  publishedAt: string;
  /** Its CLI builds' SHA-256s, by asset: each stays on the edge release under its pinned name while the build is listed. */
  sha256: Record<string, string>;
  /** The desktop app it ships (an earlier build's when this one didn't change the app). */
  appVersion?: string;
  /** What's new since the build before, in plain words, one line per merged change. */
  notes?: string[];
  /** fleetd's own hub updated to it and passed its self-check. */
  hubPassedAt?: string;
  /** How the cloud's check went, in words ("the cloud runs it", or why it was skipped). */
  cloud?: string;
  /** It passed the first ring: the staged rollout to everyone counts from here. */
  passedAt?: string;
  /** Nobody new takes it. */
  haltedAt?: string;
  /** It was halted or pulled once: a resume lets Fast hubs take it again, never Steady ones. */
  wasHalted?: boolean;
  /** Everyone on it goes back to the build before. */
  pulledAt?: string;
};

export type Rollout = { builds: RolloutBuild[] };

const HOUR = 3_600_000;
/** The staged rollout after the first ring: share of hubs (by bucket) from that long after `passedAt`. */
export const STAGES: readonly { afterMs: number; percent: number }[] = [
  { afterMs: 0, percent: 10 },
  { afterMs: HOUR, percent: 50 },
  { afterMs: 3 * HOUR, percent: 100 },
];
/** How long a build is out before Update speed Steady takes it. */
export const STEADY_MS = 48 * HOUR;

const ms = (iso: string | undefined) => (iso === undefined ? Number.NaN : Date.parse(iso));

/** The share of hubs `b` has reached at `now`: 0 before it passed the first ring. */
export function percentAt(b: RolloutBuild, now: number): number {
  const since = now - ms(b.passedAt);
  if (!(since >= 0)) return 0;
  let percent = 0;
  for (const s of STAGES) if (since >= s.afterMs) percent = s.percent;
  return percent;
}

/** The bucket, 0-99, a hub's rollout id falls in. */
export const bucketOf = (id: string): number => createHash("sha256").update(id).digest().readUInt32BE(0) % 100;

/** Who picks: its ring, its bucket and its speed. */
export type Picker = { ring: Ring; bucket: number; speed: Speed };

/** `b` may reach `who` at `now`. */
export function reaches(b: RolloutBuild, who: Picker, now: number): boolean {
  if (b.haltedAt !== undefined || b.pulledAt !== undefined) return false;
  if (who.ring === "first") return true;
  if (who.bucket >= percentAt(b, now)) return false;
  return who.speed !== "steady" || (now - ms(b.publishedAt) >= STEADY_MS && b.wasHalted !== true);
}

/** What a machine on `running` does: stay, or move to `build` (`back` when that is older, after a pull). */
export type Pick = { kind: "stay"; why: string } | { kind: "move"; build: RolloutBuild; back: boolean };

/**
 * The build `who` runs next: the newest that reaches it. Never an older one than it runs, unless the one it runs was
 * pulled; a halted build it already runs, it keeps.
 */
export function pick(r: Rollout, who: Picker, running: string, now: number): Pick {
  const target = r.builds.find((b) => reaches(b, who, now));
  const mine = r.builds.findIndex((b) => b.version === running);
  const pulled = mine >= 0 && r.builds[mine]!.pulledAt !== undefined;
  if (!target) return { kind: "stay", why: pulled ? "its build was pulled, and no build before it may reach it yet" : "no build reaches it yet" };
  if (target.version === running) return { kind: "stay", why: "it runs the newest build that reaches it" };
  const at = r.builds.indexOf(target);
  // Newer: listed before the build it runs, or that build isn't listed (one from before, or long gone).
  const newer = mine < 0 ? !aheadOfAll(r, running) : at < mine;
  if (newer) return { kind: "move", build: target, back: false };
  if (pulled) return { kind: "move", build: target, back: true };
  return { kind: "stay", why: "it runs a newer build than the ones that reach it" };
}

/** `running` isn't listed and is newer than every listed build: a build from a branch, or one the list dropped. */
function aheadOfAll(r: Rollout, running: string): boolean {
  const newest = r.builds[0];
  return newest !== undefined && versionCmp(running, newest.version) === 1;
}

/** rollout.json's contents, or why it isn't one. */
export function parseRollout(text: string): Rollout {
  const v = JSON.parse(text) as { builds?: unknown };
  if (v === null || typeof v !== "object" || !Array.isArray(v.builds)) throw new Error("rollout.json has no builds");
  const builds = v.builds.filter(
    (b): b is RolloutBuild =>
      b !== null &&
      typeof b === "object" &&
      typeof (b as RolloutBuild).build === "string" &&
      typeof (b as RolloutBuild).version === "string" &&
      typeof (b as RolloutBuild).publishedAt === "string" &&
      typeof (b as RolloutBuild).sha256 === "object" &&
      (b as RolloutBuild).sha256 !== null &&
      Object.values((b as RolloutBuild).sha256).every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)),
  );
  return { builds };
}

/** A build's checksums as the downloads take them: pinned, so each comes from its own name. */
export const sumsOf = (sha256: Record<string, string>): Sums => Object.assign(new Map(Object.entries(sha256)), { pinned: true as const });

/** Where a build's files are: its own release, or `build-<number>` beside `FLEETD_BASE_URL`'s directory. */
export const buildUrl = (build: string) =>
  process.env.FLEETD_BASE_URL !== undefined
    ? `${process.env.FLEETD_BASE_URL.replace(/\/+$/, "")}/build-${build}`
    : `https://github.com/${REPO}/releases/download/build-${build}`;

export const buildFeed = (build: string): Feed => new HttpFeed(buildUrl(build));

/** The release's rollout.json; undefined when it has none (a fork's release, or one from before rollouts). */
export async function readRollout(feed: Feed): Promise<Rollout | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await feed.get("rollout.json");
  } catch (e) {
    if (/\b404\b/.test((e as Error).message)) return undefined;
    throw new Failure("download", `couldn't read the release's rollout.json: ${(e as Error).message}`);
  }
  try {
    return parseRollout(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Failure("download", `the release's rollout.json is not valid: ${(e as Error).message}`);
  }
}

/** The build to move to, with where its files are and their checksums (read only when asked: a release from before
 * pins keeps them in SHA256SUMS); or why the machine stays. */
export type Choice =
  | { kind: "move"; to: string; sums: () => Promise<Sums>; feed: Feed; back: boolean; build?: RolloutBuild; newest?: string }
  | { kind: "stay"; why: string; newest?: string };

/**
 * What a machine on `running` does now, from the release at `feed`: the rollout's pick, or without a rollout.json the
 * release's newest build when it is newer.
 */
export async function choose(feed: Feed, who: Picker, running: string, now: number, files: (build: string) => Feed = buildFeed): Promise<Choice> {
  const r = await readRollout(feed);
  if (r === undefined) {
    const b = await release(feed);
    if (b.cliVersion === undefined) return { kind: "stay", why: "the release has no fleetd build yet" };
    if (b.cliVersion === running || versionCmp(b.cliVersion, running) === -1) return { kind: "stay", why: "it runs the newest build", newest: b.cliVersion };
    const pinned = b.sums;
    return { kind: "move", to: b.cliVersion, sums: async () => pinned ?? (await releaseSums(feed)), feed, back: false };
  }
  const p = pick(r, who, running, now);
  if (p.kind === "stay") return { kind: "stay", why: p.why, ...(r.builds[0] ? { newest: r.builds[0].version } : {}) };
  const s = sumsOf(p.build.sha256);
  return { kind: "move", to: p.build.version, sums: async () => s, feed: files(p.build.build), back: p.back, build: p.build, newest: r.builds[0]!.version };
}

/** The hub's rollout id, made once at `path`: random, kept on the hub only, so its bucket never moves. */
export function rolloutId(path: string): string {
  try {
    const id = readFileSync(path, "utf8").trim();
    if (id !== "") return id;
  } catch {}
  const id = randomBytes(16).toString("hex");
  try {
    mkdirSync(dirname(path), { recursive: true });
    replaceFile(path, `${id}\n`);
  } catch {}
  return id;
}

/** `edge`/`nightly`/`fast`/no value → fast, `stable`/`latest`/`steady` → steady: old channel names move over. */
export function parseSpeed(name: string | undefined): Speed | undefined {
  if (name === undefined) return undefined;
  if (name === "fast" || name === "edge" || name === "nightly") return "fast";
  if (name === "steady" || name === "stable" || name === "latest") return "steady";
  return undefined;
}
