// The rollout of fleetd's builds (D701). Each numbered build is a release of its own, `build-<number>` (publish.sh):
// its pinned files, never replaced, and its feeds. rollout.json, on the edge release, lists the builds machines may run,
// newest first, with how far each got (fleetd/src/update/rollout.ts reads it on every hub, and downloads a build from
// its own release). Run with bun from the repo root, with gh logged in to the repo (GH_TOKEN); every write reads
// rollout.json back and tries again if another write crossed it.
//
//   rollout.ts add              publish.sh, in dist/, once the build's release is up: lists the build (BUILD, VERSION,
//                               RELEASE_SHA; release.json and changes.json beside it) with its plain-words what's new
//   rollout.ts pass <build>     fleetd's own hub passed its self-check on <build> (rollout.yml, which the hub starts)
//   rollout.ts tick             every 10 minutes (rollout.yml): the first ring's gate, then what the desktop app's
//                               and the phone's feeds offer, stage by stage; builds no longer listed lose their files
//   rollout.ts halt <build>     nobody new takes <build>
//   rollout.ts pull <build>     everyone on <build> goes back to the build before it
//   rollout.ts resume <build>   undoes a halt or a pull
//   rollout.ts moving           exits 0 while a build waits on the gate or hasn't reached everyone yet
//
// The first ring: a build passes once fleetd's own hub passed on it and the cloud runs it (its public /version names a
// fleetd commit that holds the build's, with every instance settled). A stale cloud never holds everyone back: when the
// cloud's fleetd is more than 6 hours old, doesn't say, or hasn't taken the build 2 hours after the hub passed, the
// build passes without it and says so in `cloud`.
//
// The desktop app reads its feed on edge by its bucket (app/desktop/src/main/update-stage.ts): stage10-*.yml below 10,
// stage50-*.yml below 50, latest-*.yml otherwise, and apps from before stages read latest. Each is the feed of the
// newest build that reached that share (a build that didn't change the app has none: the nearest older build's), its
// files named by their full address in that build's release. The phone's over-the-air updates aren't staged here: they
// go out after each merge (mobile-release.yml, D800), and a bundle that crashes as it starts goes back to the one
// before it on the phone itself.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRollout, percentAt, STAGES, type Rollout, type RolloutBuild } from "../../fleetd/src/update/rollout.ts";
import { httpStatus, transient } from "../../fleetd/src/hub/train/github.ts";

const HOUR = 3_600_000;
const TAG = "edge";
/** Builds listed at most; a build no longer listed loses its release's files. */
export const MAX_BUILDS = 60;
/** How far back builds stay for Update speed Steady: one per 6 hours, the newest that passed in each. */
export const KEEP_MS = 3 * 24 * HOUR;
const SLOT_MS = 6 * HOUR;
export const CLOUD_URL = process.env.FLEETD_CLOUD_VERSION_URL ?? "https://app.fleetd.dev/version";
export const CLOUD_STALE_MS = 6 * HOUR;
export const CLOUD_WAIT_MS = 2 * HOUR;
/** The CLI's builds hubs and nodes download, each under its pinned name in the build's release. */
const CLI = /^fleetd-bun-(linux|darwin)-[a-z0-9]+$/;
const REPO = process.env.GITHUB_REPOSITORY ?? "unlaboredlabs/fleetd";
/** A build's own release. */
export const releaseOf = (build: string) => `build-${build}`;

/** A build's feed as edge serves it: its files by their full address in the build's release. */
export const absolute = (feed: string, build: string) =>
  feed.replace(/^(  - url: |path: )(?!https:)(.+)$/gm, `$1https://github.com/${REPO}/releases/download/${releaseOf(build)}/$2`);
/** The desktop app's stage feeds, each with the share a build must have reached. */
export const FEEDS: readonly { name: string; percent: number }[] = [
  { name: "stage10", percent: 10 },
  { name: "stage50", percent: 50 },
  { name: "latest", percent: 100 },
];
const PLATFORMS = ["mac", "linux"] as const;

const ms = (iso: string | undefined) => (iso === undefined ? Number.NaN : Date.parse(iso));
const iso = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A day-numbered build's number, from before release.version-scheme. */
const DAY_NUMBERED_BUILD = /^\d{4}\.\d{1,2}\.\d{1,2}\.\d+$/;
/** A build number as the rollout lists it: `0.9.4` (release.version-scheme), or a day-numbered one from before. */
export const BUILD_NUMBER = /^(?:\d+\.\d+\.\d+|\d{4}\.\d{1,2}\.\d{1,2}\.\d+)$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A build's heading: its number and the UTC day it was published, "0.9.4 · Nov 23"; a day-numbered build's number
 * already says its day. */
export const heading = (b: Pick<RolloutBuild, "build" | "publishedAt">) => {
  const at = new Date(ms(b.publishedAt));
  return Number.isNaN(at.getTime()) || b.build.split(".").length !== 3 ? b.build : `${b.build} · ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
};

/**
 * A merged change's subject in plain words: without its `type(scope): ` prefix, its workstream and its PR number, and
 * starting with a capital. A train batch (`batch: a (#1); b (#2)`) is each of its changes.
 */
export function plainNotes(subjects: string[]): string[] {
  const out: string[] = [];
  for (const subject of subjects) {
    const parts = subject.startsWith("batch: ") ? subject.slice(7).split(/;\s+/) : [subject];
    for (let s of parts) {
      s = s.replace(/^(?:feat|fix|chore|ci|docs|perf|refactor|test|build|style|revert)(?:\([^)]*\))?!?:\s*/i, "");
      s = s.replace(/(?:\s*\((?:#\d+|W\d+)\))+\s*$/g, "").replace(/\s*\(W\d+\)/g, "").trim();
      if (s === "" || /^Merge /.test(s)) continue;
      out.push(s[0]!.toUpperCase() + s.slice(1));
    }
  }
  return out;
}

/** The builds to keep, newest first: every build up to the newest that reached everyone, one good build before that to
 * go back to, and for Steady, the newest passed build of each 6 hours of the last 3 days; MAX_BUILDS at most. */
export function prune(builds: RolloutBuild[], now: number): RolloutBuild[] {
  const good = (b: RolloutBuild) => b.haltedAt === undefined && b.pulledAt === undefined;
  // A day-numbered build (2026.11.23.x, eleven of them) stays listed for good: a hub on one, from before 0.MINOR.PATCH,
  // orders a build that isn't listed by its minute stamp, which a 0.9.x version hasn't, so it finds 0.9.x newer only
  // while its own build is listed (fleetd/src/update/rollout.ts `pick`), however long it was away.
  const dayNumbered = (b: RolloutBuild) => DAY_NUMBERED_BUILD.test(b.build);
  const full = builds.findIndex((b) => good(b) && percentAt(b, now) === 100);
  const fallback = full < 0 ? -1 : builds.findIndex((b, i) => i > full && good(b) && b.passedAt !== undefined);
  const slots = new Set<number>();
  const kept = builds.filter((b, i) => {
    if (dayNumbered(b) || (full < 0 ? now - ms(b.publishedAt) < KEEP_MS : i <= full)) return true;
    const slot = Math.floor(ms(b.publishedAt) / SLOT_MS);
    if (i === fallback) {
      slots.add(slot);
      return true;
    }
    // Steady's: never a build that was halted once.
    if (!(now - ms(b.publishedAt) < KEEP_MS) || !good(b) || b.wasHalted === true || b.passedAt === undefined || slots.has(slot)) return false;
    slots.add(slot);
    return true;
  });
  return kept.filter((b, i) => i < MAX_BUILDS || dayNumbered(b));
}

/** What the cloud says it runs. */
export type Cloud = { kind: "runs"; fleetd: string } | { kind: "unsettled" } | { kind: "silent"; why: string };

/** How the first ring's cloud check goes for `b`: passed, skipped (with why), or wait. */
export type CloudVerdict = { pass: true; words: string } | { pass: false };

/**
 * The cloud's half of the first ring. `contains(a, b)`: commit b holds commit a. `dateOf`: a commit's time, ms, or
 * undefined when unknown.
 */
export function cloudVerdict(
  b: RolloutBuild,
  cloud: Cloud,
  now: number,
  contains: (a: string, b: string) => boolean,
  dateOf: (commit: string) => number | undefined,
): CloudVerdict {
  if (cloud.kind === "silent") return { pass: true, words: `skipped: the cloud ${cloud.why}` };
  if (cloud.kind === "runs") {
    if (contains(b.commit, cloud.fleetd)) return { pass: true, words: "the cloud runs it" };
    const at = dateOf(cloud.fleetd);
    if (at !== undefined && now - at > CLOUD_STALE_MS) {
      return { pass: true, words: `skipped: the cloud runs fleetd from ${iso(at)}, more than 6 hours older, so it didn't take this build` };
    }
  }
  if (now - ms(b.hubPassedAt) >= CLOUD_WAIT_MS) return { pass: true, words: "skipped: the cloud didn't take this build within 2 hours" };
  return { pass: false };
}

/** The first ring's gate over every build that waits on it; whether anything changed. */
export function gate(r: Rollout, cloud: () => Cloud, now: number, contains: (a: string, b: string) => boolean, dateOf: (c: string) => number | undefined): boolean {
  let said: Cloud | undefined;
  let changed = false;
  for (const b of r.builds) {
    if (b.passedAt !== undefined || b.hubPassedAt === undefined || b.haltedAt !== undefined || b.pulledAt !== undefined) continue;
    said ??= cloud();
    const v = cloudVerdict(b, said, now, contains, dateOf);
    if (!v.pass) continue;
    b.cloud = v.words;
    b.passedAt = iso(now);
    changed = true;
  }
  return changed;
}

/** Where each feed comes from: the newest build that reached its stage, or undefined for edge's own latest-*.yml (no
 * build reached the stage yet; latest itself is then left as it is). */
export function stageSources(r: Rollout, now: number, hasFeed: (build: string) => boolean): { feed: string; from: string | undefined }[] {
  return FEEDS.map((f) => ({ feed: f.name, from: feedBuild(r, f.percent, now, hasFeed) }));
}

/** A feed as the nightly copy serves it: its version nightly-named, which apps from before Edge's rename compare. */
export const nightlyFeed = (feed: string) => feed.replace(/^(version: .*)-edge\./m, "$1-nightly.");

/** The newest build that reached `percent` of hubs and has a desktop feed (its own or the nearest older build's). */
export function feedBuild(r: Rollout, percent: number, now: number, hasFeed: (build: string) => boolean): string | undefined {
  const at = r.builds.findIndex((b) => b.haltedAt === undefined && b.pulledAt === undefined && percentAt(b, now) >= percent);
  if (at < 0) return undefined;
  return r.builds.slice(at).find((b) => hasFeed(b.build))?.build;
}

/**
 * Something is still moving: a build fleetd's own hub passed waits on the first ring's gate, or one that passed hasn't
 * reached everyone yet. The rollout workflow ticks on while it is (`rollout.ts moving`), since GitHub's schedule alone
 * can lag by hours.
 */
export function moving(r: Rollout, now: number): boolean {
  return r.builds.some(
    (b) =>
      b.haltedAt === undefined &&
      b.pulledAt === undefined &&
      ((b.hubPassedAt !== undefined && b.passedAt === undefined) || (b.passedAt !== undefined && percentAt(b, now) < 100)),
  );
}

/** The release's notes: the newest builds, each with how far it got and its what's new. */
export function releaseNotes(r: Rollout, now: number): string {
  const lines = [
    "Every green build of main is a release, numbered 0.MINOR.PATCH. A build goes to fleetd's own hub and the cloud first, then to everyone in stages: " +
      `${STAGES.map((s) => `${s.percent}%${s.afterMs === 0 ? "" : ` after ${s.afterMs / HOUR} h`}`).join(", ")}. ` +
      "Hubs on Update speed Steady take builds that have been out 2 days.",
    "",
    "Install: curl -fsSL https://fleetd.sh | sh",
  ];
  for (const b of r.builds.slice(0, 15)) {
    const state =
      b.pulledAt !== undefined
        ? "pulled"
        : b.haltedAt !== undefined
          ? "halted"
          : b.passedAt === undefined
            ? b.hubPassedAt === undefined
              ? "on fleetd's own hub"
              : "waiting on the cloud"
            : `${percentAt(b, now)}% of hubs`;
    lines.push("", `### ${heading(b)} (${state})`, "");
    const notes = b.notes ?? [];
    for (const n of notes.slice(0, 30)) lines.push(`- ${n}`);
    if (notes.length > 30) lines.push(`- and ${notes.length - 30} more`);
    if (notes.length === 0) lines.push("- No merged changes listed.");
    if (b.cloud?.startsWith("skipped") === true) lines.push(`- The cloud check was ${b.cloud}.`);
  }
  return lines.join("\n");
}

// ---- The edge release, through gh ----

/** Tries of one gh call whose failure may well pass a moment later; the waits between them double from GH_RETRY_MS. */
const GH_TRIES = 5;
const GH_RETRY_MS = Number(process.env.ROLLOUT_GH_RETRY_MS ?? 5000);
/** One try's longest: a call GitHub never answers is a failure to try again, not a hung ticker. */
const GH_TRY_MS = 5 * 60_000;
/** gh's words when it never got GitHub's answer. */
const NETWORK = /connection reset|connection refused|no such host|i\/o timeout|tls handshake timeout|unexpected eof|network is unreachable|ETIMEDOUT/i;

/** Whether a failed gh call may well pass a moment later: GitHub's 5xx, its rate limit, or no answer at all. */
export const ghTransient = (stderr: string) => transient(httpStatus(stderr), stderr) || NETWORK.test(stderr);

/**
 * One gh call, tried again (GH_TRIES at most, about 75 s of waits) while it fails on GitHub rather than on what it
 * asked: on Nov 25 an edit of edge's notes got HTTP 500 twice through an incident. Any other failure ends at once.
 */
function runGh(args: string[], input?: string): { status: number; stdout: string; stderr: string; transient: boolean } {
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync("gh", args, { encoding: "utf8", input, maxBuffer: 64 << 20, timeout: GH_TRY_MS });
    const stderr = r.error ? `${r.stderr ?? ""}${String(r.error)}` : (r.stderr ?? "");
    if (r.status === 0) return { status: 0, stdout: r.stdout, stderr, transient: false };
    const again = ghTransient(stderr);
    if (!again || attempt >= GH_TRIES) return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr, transient: again };
    const wait = GH_RETRY_MS * 2 ** (attempt - 1);
    console.log(`::warning::gh ${args.slice(0, 2).join(" ")} failed (try ${attempt} of ${GH_TRIES}), retrying in ${wait / 1000} s: ${stderr.trim()}`);
    Bun.sleepSync(wait);
  }
}

function gh(args: string[], input?: string): string {
  const r = runGh(args, input);
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

function readRollout(): Rollout {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "rollout-"));
  const r = runGh(["release", "download", TAG, "-p", "rollout.json", "-D", dir]);
  if (r.status !== 0 || !existsSync(join(dir, "rollout.json"))) {
    if (/no assets match|not found/i.test(r.stderr)) return { builds: [] };
    throw new Error(`couldn't read rollout.json: ${r.stderr.trim()}`);
  }
  return parseRollout(readFileSync(join(dir, "rollout.json"), "utf8"));
}

function writeRollout(r: Rollout): void {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "rollout-"));
  const path = join(dir, "rollout.json");
  writeFileSync(path, `${JSON.stringify(r, null, 2)}\n`);
  gh(["release", "upload", TAG, path, "--clobber"]);
}

/** Applies `change` to rollout.json and writes it, until a read back holds it (`holds`); what it wrote. */
function update(change: (r: Rollout) => boolean, holds: (r: Rollout) => boolean): Rollout {
  for (let attempt = 1; ; attempt++) {
    const r = readRollout();
    if (!change(r)) return r;
    writeRollout(r);
    // A write that crossed this one lands within seconds of it.
    Bun.sleepSync(3000);
    const back = readRollout();
    if (holds(back)) return back;
    if (attempt >= 5) throw new Error("another write kept crossing this one; run it again");
    console.log("another write crossed this one; trying again");
  }
}

/** A release's file names; none when it doesn't exist (any more). GitHub failing isn't "none": it throws. */
function assets(tag: string): string[] {
  const r = runGh(["release", "view", tag, "--json", "assets", "-q", ".assets[].name"]);
  if (r.status !== 0 && r.transient) throw new Error(`gh release view ${tag}: ${r.stderr.trim()}`);
  return r.status === 0 ? r.stdout.split("\n").filter((n) => n !== "") : [];
}

function download(tag: string, name: string, dir: string): string {
  gh(["release", "download", tag, "-p", name, "-D", dir, "--clobber"]);
  return join(dir, name);
}

const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8" });
const contains = (a: string, b: string) => a === b || git(["merge-base", "--is-ancestor", a, b]).status === 0;
const dateOf = (commit: string) => {
  const r = git(["show", "-s", "--format=%ct", commit]);
  return r.status === 0 ? Number(r.stdout.trim()) * 1000 : undefined;
};

async function readCloud(): Promise<Cloud> {
  try {
    const answer = await fetch(CLOUD_URL, { signal: AbortSignal.timeout(15_000) });
    if (answer.status === 404) return { kind: "silent", why: "doesn't say which fleetd it runs" };
    if (!answer.ok) return { kind: "unsettled" };
    const v = (await answer.json()) as { fleetd?: unknown; settled?: unknown };
    if (v.settled !== true) return { kind: "unsettled" };
    if (typeof v.fleetd !== "string" || !/^[0-9a-f]{40}$/.test(v.fleetd)) return { kind: "silent", why: "doesn't say which fleetd it runs" };
    // A commit this checkout doesn't have can't be compared: fetch it, else treat it as unknown.
    if (git(["cat-file", "-e", `${v.fleetd}^{commit}`]).status !== 0) git(["fetch", "-q", "origin", v.fleetd]);
    return { kind: "runs", fleetd: v.fleetd };
  } catch {
    return { kind: "unsettled" };
  }
}

// ---- Commands ----

/**
 * The desktop app's stage feeds on edge, every one of them always there: an app reads its stage's feed and, from
 * before it fell back to latest by itself (2026.11.23.1), fails on a missing one. Each is the feed of the newest build
 * that reached its stage (`stageSources`), else edge's own latest-*.yml as it stands. `edge` is edge's file names.
 */
function writeFeeds(r: Rollout, now: number, work: string, filesOf: (build: string) => string[], edge: Set<string>): void {
  const same = (name: string, text: string) => edge.has(name) && readFileSync(download(TAG, name, join(work, "edge")), "utf8") === text;
  for (const platform of PLATFORMS) {
    const own = `latest-${platform}.yml`;
    for (const { feed, from } of stageSources(r, now, (build) => filesOf(build).includes(own))) {
      let text: string;
      if (from !== undefined) text = absolute(readFileSync(download(releaseOf(from), own, join(work, from)), "utf8"), from);
      else if (feed !== "latest" && edge.has(own)) text = readFileSync(download(TAG, own, join(work, "edge-latest")), "utf8");
      else continue;
      const target = `${feed}-${platform}.yml`;
      if (!same(target, text)) {
        const out = join(work, target);
        writeFileSync(out, text);
        gh(["release", "upload", TAG, out, "--clobber"]);
        edge.add(target);
        console.log(`${target}: ${from ?? "edge's latest"}`);
      }
      // Apps from before Edge's rename read the nightly copy (publish.sh): only a build that reached everyone, under
      // the nightly-named version they compare.
      if (feed === "latest" && from !== undefined) {
        const old = nightlyFeed(text);
        const was = assets("nightly").includes(target) ? readFileSync(download("nightly", target, join(work, "nightly")), "utf8") : "";
        if (was !== old) {
          const out = join(work, "nightly-out", target);
          mkdirSync(join(work, "nightly-out"), { recursive: true });
          writeFileSync(out, old);
          gh(["release", "upload", "nightly", out, "--clobber"]);
          console.log(`nightly ${target}: ${from}`);
        }
      }
    }
  }
}

function add(): void {
  const build = process.env.BUILD ?? "";
  const version = process.env.VERSION ?? "";
  const commit = process.env.RELEASE_SHA ?? "";
  if (!BUILD_NUMBER.test(build) || version === "" || commit === "") throw new Error("add needs BUILD, VERSION and RELEASE_SHA");
  const release = JSON.parse(readFileSync("release.json", "utf8")) as { sha256?: Record<string, string>; appVersion?: string };
  const sha256 = Object.fromEntries(Object.entries(release.sha256 ?? {}).filter(([name]) => CLI.test(name)));
  if (Object.keys(sha256).length === 0) {
    console.log("this build has no pinned CLI builds; rollout.json stays as it is");
    return;
  }
  const changes = existsSync("changes.json") ? ((JSON.parse(readFileSync("changes.json", "utf8")) as { changes?: { commit: string; subject: string }[] }).changes ?? []) : [];
  const now = Date.now();
  const r = update(
    (r) => {
      if (r.builds.some((b) => b.build === build)) return false;
      const since = r.builds[0]?.commit;
      const fresh: string[] = [];
      for (const c of changes) {
        if (c.commit === since) break;
        fresh.push(c.subject);
      }
      const entry: RolloutBuild = {
        build,
        version,
        commit,
        publishedAt: iso(now),
        sha256,
        ...(release.appVersion !== undefined ? { appVersion: release.appVersion } : {}),
        notes: plainNotes(fresh).slice(0, 100),
      };
      r.builds = [entry, ...r.builds];
      return true;
    },
    (r) => r.builds.some((b) => b.build === build),
  );
  gh(["release", "edit", TAG, "--notes", releaseNotes(r, now)]);
  // Every stage feed there from the first build on (`writeFeeds`).
  const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "rollout-"));
  writeFeeds(r, now, work, (b) => assets(releaseOf(b)), new Set(assets(TAG)));
  const mine = r.builds.find((b) => b.build === build);
  const notes = (mine?.notes ?? []).map((n) => `- ${n}`).join("\n") || "- No merged changes listed.";
  gh(["release", "edit", releaseOf(build), "--notes", `fleetd ${mine === undefined ? build : heading(mine)}, built from main at ${commit}.\n\n### What's new\n\n${notes}`]);
  console.log(`rollout.json: added ${build}; ${r.builds.length} builds listed`);
}

function flag(kind: "halt" | "pull" | "resume" | "pass", build: string): Rollout {
  const now = iso(Date.now());
  const r = update(
    (r) => {
      const b = r.builds.find((b) => b.build === build);
      if (!b) throw new Error(`${build} isn't in rollout.json (builds listed: ${r.builds.map((b) => b.build).join(", ") || "none"})`);
      if (kind === "halt") {
        if (b.haltedAt !== undefined) return false;
        b.haltedAt = now;
        b.wasHalted = true;
      } else if (kind === "pull") {
        if (b.pulledAt !== undefined) return false;
        b.pulledAt = now;
        b.wasHalted = true;
      } else if (kind === "pass") {
        if (b.hubPassedAt !== undefined) return false;
        b.hubPassedAt = now;
      } else {
        if (b.haltedAt === undefined && b.pulledAt === undefined) return false;
        delete b.haltedAt;
        delete b.pulledAt;
      }
      return true;
    },
    (r) => {
      const b = r.builds.find((b) => b.build === build);
      if (!b) return false;
      if (kind === "halt") return b.haltedAt !== undefined;
      if (kind === "pull") return b.pulledAt !== undefined;
      if (kind === "pass") return b.hubPassedAt !== undefined;
      return b.haltedAt === undefined && b.pulledAt === undefined;
    },
  );
  console.log(`${build}: ${kind === "resume" ? "resumed" : kind === "pass" ? "passed on fleetd's own hub" : `${kind === "halt" ? "halted" : "pulled"}`}`);
  return r;
}

async function tick(): Promise<void> {
  const now = Date.now();
  const cloud = await readCloud();
  let dropped: string[] = [];
  // A write that crosses this one (a new build, a flag) is kept: the next tick gates again.
  const r = update(
    (r) => {
      const before = r.builds.map((b) => b.build);
      const changed = gate(r, () => cloud, now, contains, dateOf);
      r.builds = prune(r.builds, now);
      dropped = before.filter((b) => !r.builds.some((k) => k.build === b));
      return changed || dropped.length > 0;
    },
    () => true,
  );
  const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "rollout-"));
  const files = new Map<string, string[]>();
  const filesOf = (build: string) => {
    if (!files.has(build)) files.set(build, assets(releaseOf(build)));
    return files.get(build)!;
  };
  const edge = new Set(assets(TAG));
  writeFeeds(r, now, work, filesOf, edge);

  // The builds this tick stopped listing lose their files; their releases stay, for their notes.
  for (const build of dropped) {
    for (const name of filesOf(build)) runGh(["release", "delete-asset", releaseOf(build), name, "-y"]);
    console.log(`${releaseOf(build)}: files removed, no longer listed`);
  }
  gh(["release", "edit", TAG, "--notes", releaseNotes(r, now)]);
}

if (import.meta.main) {
  const [command, build] = process.argv.slice(2);
  try {
    if (command === "add") add();
    else if (command === "tick") await tick();
    // Exits 0 while something is still moving (`moving`), 1 once nothing is.
    else if (command === "moving") process.exit(moving(readRollout(), Date.now()) ? 0 : 1);
    else if ((command === "halt" || command === "pull" || command === "resume" || command === "pass") && build) {
      flag(command, build);
      await tick();
    } else {
      console.error("usage: rollout.ts add | tick | pass <build> | halt <build> | pull <build> | resume <build>");
      process.exit(2);
    }
  } catch (e) {
    console.error(`::error::${(e as Error).message}`);
    process.exit(1);
  }
}
