// Which stage feed this app updates from (D701, .github/release/rollout.ts): every build goes to fleetd's own hub and
// cloud first, then to everyone in stages. The app falls in a bucket by a random id it makes once and keeps on this
// device (nothing leaves it): below 10 it reads stage10-*.yml, below 50 stage50-*.yml, otherwise latest-*.yml, each the
// newest build that reached that share. A build pulled from the rollout sends the app back to the one before it, so
// the updater may step down only when the app runs a pulled build.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The bucket, 0-99, an id falls in: as fleetd/src/update/rollout.ts `bucketOf`. */
export const bucketOf = (id: string): number => createHash("sha256").update(id).digest().readUInt32BE(0) % 100;

/** The electron-updater channel for `bucket`: its feed is `<channel>-mac.yml` / `-linux.yml`; null reads latest. */
export const stageChannel = (bucket: number): string | null => (bucket < 10 ? "stage10" : bucket < 50 ? "stage50" : null);

/** This app's rollout id, made once at `path`. */
export function rolloutId(path: string): string {
  try {
    const id = readFileSync(path, "utf8").trim();
    if (id !== "") return id;
  } catch {
    // None yet: made below.
  }
  const id = randomBytes(16).toString("hex");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${id}\n`);
  } catch {
    // Not kept: this run's id still picks a stage, and the next run makes another.
  }
  return id;
}

/** The app `version` runs is only in builds pulled from the rollout (rollout.json): it goes back to the one before. */
export function pulled(rollout: unknown, version: string): boolean {
  const builds = (rollout as { builds?: unknown } | null)?.builds;
  if (!Array.isArray(builds)) return false;
  const mine = builds.filter((b): b is { appVersion?: unknown; pulledAt?: unknown } => b !== null && typeof b === "object" && (b as { appVersion?: unknown }).appVersion === version);
  return mine.length > 0 && mine.every((b) => typeof b.pulledAt === "string");
}
