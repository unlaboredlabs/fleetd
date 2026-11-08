// Writing secrets to disk as the Rust node does (crates/fleetd/src/node/secrets.rs `write_atomic`): a sibling temp file
// (exclusive create, 0600), fsync, then a rename over the target, so a reader sees the old file or the new one.
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

export function writeAtomic(target: string, bytes: Uint8Array | string): void {
  const tmp = join(dirname(target), `.${basename(target)}.fleetd-${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, typeof bytes === "string" ? Buffer.from(bytes) : bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** The first 8 hex characters of sha256 over the plaintext. */
export const fingerprintOf = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex").slice(0, 8);

/** A name fleetd or claude keeps for itself (project_settings.rs `env_name_reserved`). */
export const envNameReserved = (name: string) =>
  ["HOME", "PATH", "USER", "TMPDIR", "TMP", "TEMP"].includes(name) || ["FLEETD_", "ANTHROPIC_", "CLAUDE"].some((p) => name.startsWith(p));

export const ENV_VALUE_MAX_BYTES = 64 * 1024;
export const ENV_TOTAL_MAX_BYTES = 512 * 1024;
export const PROJECT_ENV_MAX = 100;

/** `value` quoted for a shell: in single quotes, each of its own as `'\''`. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
