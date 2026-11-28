// The phone app's over-the-air updates in stages (D800, with D701's stages): each update reaches about 10% of
// installs as it is published, 50% an hour later and everyone after 3 hours. Every phone sends its install's random id
// with each check (expo-updates' EAS-Client-ID), and site/vercel.json routes it by that id's first two hex digits:
// up to 1a (27 of 256, about 10%) to the channel's stage10/ manifests, below 80 (50%) to stage50/, else to the channel's
// own. phone.json on the edge release lists the updates (mobile-release.yml's update job adds each one), and
// rollout.ts writes what each stage serves into edge's mobile-updates.tar.gz on publish and on every tick.
//
// Only the newest update of a runtime version advances: once a newer one is published, an older one still on its way
// stays at the stage it had reached, so a revert or any later fix stops a bad update from going on to 50% and everyone.
// A halted update reaches nobody new: each stage serves the newest update before it that reached it. A pulled one
// also takes back those who have it: every stage serves its back copy, the update everyone had when it was published
// signed again as a newer one (or expo-updates' rollBackToEmbedded directive when there was none), which its package
// carries (app/mobile/scripts/updates.ts --served). An urgent one (`rollout.ts phone-urgent`) is everyone's from then.
//
// An update's package, phone-update-<id>.tar.gz on the edge release: <runtime version>/<platform> (its signed
// manifests), back/<runtime version>/<platform>, and assets/ (its files and its back copy's).

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spike } from "../../fleetd/src/hub/app_errors/pull.ts";

export type Platform = "ios" | "android";
export const PLATFORMS: readonly Platform[] = ["ios", "android"];

export type PhoneUpdate = {
  /** The iOS update's id, the name a halt or a pull gives. */
  id: string;
  /** Each platform's update id and runtime version (its native fingerprint). */
  platforms: Partial<Record<Platform, { id: string; runtime: string }>>;
  /** The commit it was exported from. */
  commit: string;
  publishedAt: string;
  haltedAt?: string;
  pulledAt?: string;
  /** Sent to everyone at once, an urgent fix. */
  urgentAt?: string;
};

/** Newest first. */
export type PhoneRollout = { updates: PhoneUpdate[] };

const HOUR = 3_600_000;
/** The share of installs an update has reached so long after it was published. */
export const PHONE_STAGES: readonly { afterMs: number; percent: number }[] = [
  { afterMs: 0, percent: 10 },
  { afterMs: HOUR, percent: 50 },
  { afterMs: 3 * HOUR, percent: 100 },
];
/** Updates listed at most; one no longer listed loses its package. */
export const MAX_UPDATES = 20;

/** The directory under the channel each stage's manifests are in: the channel's own for everyone. */
export const STAGE_DIRS: readonly { percent: number; dir: string }[] = [
  { percent: 10, dir: "stage10" },
  { percent: 50, dir: "stage50" },
  { percent: 100, dir: "" },
];

export function parsePhoneRollout(text: string): PhoneRollout {
  const r = JSON.parse(text) as Partial<PhoneRollout>;
  return { updates: Array.isArray(r.updates) ? r.updates : [] };
}

/** The share of installs `u` has reached at `now`. */
export function phonePercentAt(u: PhoneUpdate, now: number): number {
  if (u.urgentAt !== undefined && now >= Date.parse(u.urgentAt)) return 100;
  const since = now - Date.parse(u.publishedAt);
  let percent = 0;
  for (const s of PHONE_STAGES) if (since >= s.afterMs) percent = s.percent;
  return percent;
}

/** One manifest a stage serves: `from`'s own (`back` false) or its back copy, for a runtime version and platform. */
export type Served = { dir: string; runtime: string; platform: Platform; from: string; back: boolean };

/** What each stage serves at `now`, for every runtime version and platform the listed updates are for. */
export function served(r: PhoneRollout, now: number): Served[] {
  const out: Served[] = [];
  const keys = new Map<string, { runtime: string; platform: Platform }>();
  for (const u of r.updates) {
    for (const platform of PLATFORMS) {
      const p = u.platforms[platform];
      if (p) keys.set(`${p.runtime} ${platform}`, { runtime: p.runtime, platform });
    }
  }
  for (const { runtime, platform } of keys.values()) {
    const mine = r.updates.filter((u) => u.platforms[platform]?.runtime === runtime);
    for (const { percent, dir } of STAGE_DIRS) {
      for (const [i, u] of mine.entries()) {
        if (u.pulledAt !== undefined) {
          out.push({ dir, runtime, platform, from: u.id, back: true });
          break;
        }
        // As far as it got by the time the next newer one was published.
        const until = i === 0 ? now : Math.min(now, Date.parse(mine[i - 1]!.publishedAt));
        if (u.haltedAt !== undefined || phonePercentAt(u, until) < percent) continue;
        out.push({ dir, runtime, platform, from: u.id, back: false });
        break;
      }
    }
  }
  return out;
}

/** Whether an update is still on its way to everyone: the ticker keeps ticking. */
export const phoneMoving = (r: PhoneRollout, now: number): boolean =>
  r.updates.some(
    (u, i) =>
      // An older one a newer one stopped (`served`) moves no more.
      !r.updates.slice(0, i).some((n) => PLATFORMS.some((p) => n.platforms[p] !== undefined && n.platforms[p]?.runtime === u.platforms[p]?.runtime)) &&
      u.haltedAt === undefined &&
      u.pulledAt === undefined &&
      phonePercentAt(u, now) < 100,
  );

/** Its package's name on the edge release. */
export const packageOf = (id: string) => `phone-update-${id}.tar.gz`;

/** What served.txt says of what each stage serves: rollout.ts compares it with edge's to skip an unchanged upload. */
export const servedText = (s: Served[]): string =>
  s.map((x) => `${x.dir || "everyone"} ${x.platform} ${x.runtime} ${x.from}${x.back ? " back" : ""}\n`).join("");

/** The newest MAX_UPDATES, and any older one a stage still serves; the rest are dropped with their packages. */
export function prunePhone(r: PhoneRollout, now: number): { kept: PhoneUpdate[]; dropped: string[] } {
  const serving = new Set(served(r, now).map((s) => s.from));
  const kept = r.updates.filter((u, i) => i < MAX_UPDATES || serving.has(u.id));
  return { kept, dropped: r.updates.filter((u) => !kept.includes(u)).map((u) => u.id) };
}

/** The update a package's updates.txt lists ("<platform> <runtime version> <update id>" lines), published at `now`. */
export function updateOf(updatesTxt: string, commit: string, now: string): PhoneUpdate {
  const platforms: PhoneUpdate["platforms"] = {};
  for (const line of updatesTxt.split("\n")) {
    const [platform, runtime, id] = line.trim().split(" ");
    if ((platform === "ios" || platform === "android") && runtime && id) platforms[platform] = { id, runtime };
  }
  const id = platforms.ios?.id ?? platforms.android?.id;
  if (id === undefined) throw new Error("the package's updates.txt lists no update");
  return { id, platforms, commit, publishedAt: now };
}

/** Writes the channel's directory as `s` serves it into `out`, from each update's unpacked package (`packageDir`):
 * each stage's manifests, every file they name, and served.txt. */
export function writeServed(s: Served[], packageDir: (id: string) => string, out: string): void {
  mkdirSync(join(out, "assets"), { recursive: true });
  for (const id of new Set(s.map((x) => x.from))) {
    const assets = join(packageDir(id), "assets");
    if (existsSync(assets)) for (const f of readdirSync(assets)) cpSync(join(assets, f), join(out, "assets", f));
  }
  for (const x of s) {
    mkdirSync(join(out, x.dir, x.runtime), { recursive: true });
    cpSync(join(packageDir(x.from), ...(x.back ? ["back"] : []), x.runtime, x.platform), join(out, x.dir, x.runtime, x.platform));
  }
  writeFileSync(join(out, "served.txt"), servedText(s));
}

/** The cloud's per-update totals of its teams' phone error reports (only counts: never a message, a stack or a team),
 * as `CLOUD_PHONE_ERRORS_URL` serves them. */
export type CloudErrors = { updates: { id: string; firstAt: number; fatal: number; caught: number }[] };

/** The listed updates whose cloud totals spike by the workspace's own rule (hub/app_errors/pull.ts), to pull, each with
 * why; an update counts by any of its platforms' ids. */
export function cloudPulls(r: PhoneRollout, cloud: CloudErrors, now: number): { id: string; why: string }[] {
  const counts = [...cloud.updates].sort((a, b) => b.firstAt - a.firstAt);
  const out: { id: string; why: string }[] = [];
  for (const u of r.updates) {
    if (u.pulledAt !== undefined) continue;
    for (const id of new Set([u.id, ...Object.values(u.platforms).map((p) => p!.id)])) {
      const why = spike(counts, id, now);
      if (why !== undefined) {
        out.push({ id: u.id, why: `${why} across the cloud's teams` });
        break;
      }
    }
  }
  return out;
}
