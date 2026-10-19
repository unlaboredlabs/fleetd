// app-pair.json pairs the app with no typing, so it is trusted only as `fleetd init` / `fleetd pair` write it: a
// small regular file of ours, private to us, naming a hub on this machine or a private network.
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { isIP } from "node:net";
import type { PairFailure } from "../../shared/pairing";

const MAX_BYTES = 4096;
const RERUN = "Run `fleetd pair` on the hub to write a fresh one, or type the address and code below.";

export type FileRead = { ok: true; text: string } | { ok: false; missing: true } | { ok: false; missing: false; failure: PairFailure };

const refuse = (path: string, why: string): FileRead => ({
  ok: false,
  missing: false,
  failure: { code: "", message: `Ignored ${path}: ${why}`, fix: RERUN },
});

/**
 * Reads the file without following a symlink or blocking on a FIFO, and only if it is a regular file this user owns,
 * readable by no one else, and small.
 */
export const readAppPairFile = async (path: string): Promise<FileRead> => {
  let handle;
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer. Where the OS lacks a flag it is undefined, which `|`
    // reads as 0.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, missing: true };
    return refuse(path, code === "ELOOP" ? "it is a symlink." : `it can't be opened (${code ?? "unknown error"}).`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return refuse(path, "it isn't a regular file.");
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return refuse(path, "another user owns it.");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return refuse(path, "other users can read it; it must be private (0600).");
    if (stat.size > MAX_BYTES) return refuse(path, "it is too large to be a pairing file.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) return refuse(path, "it is too large to be a pairing file.");
    return { ok: true, text: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close();
  }
};

export const removeAppPairFile = (path: string): Promise<void> => rm(path, { force: true });

const PRIVATE_V4: ReadonlyArray<readonly [number, number]> = [
  // [network as a 32-bit number, prefix length]
  [0x7f000000, 8], // loopback
  [0x0a000000, 8], // 10/8
  [0xac100000, 12], // 172.16/12
  [0xc0a80000, 16], // 192.168/16
  [0x64400000, 10], // 100.64/10, Tailscale's CGNAT range
  [0xa9fe0000, 16], // link-local
];

const v4Number = (ip: string): number => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

const privateV4 = (ip: string): boolean =>
  PRIVATE_V4.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((v4Number(ip) & mask) >>> 0) === net;
  });

const privateV6 = (ip: string): boolean => {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
  if (mapped?.[1] !== undefined) return privateV4(mapped[1]);
  // fc00::/7 (unique local, Tailscale's fd7a:115c:a1e0::/48 among them) and fe80::/10 (link-local).
  return /^f[cd]/u.test(lower) || /^fe[89ab]/u.test(lower);
};

/** Names that only resolve on this machine, the LAN or a tailnet. */
const PRIVATE_SUFFIXES = [".local", ".lan", ".home.arpa", ".internal", ".ts.net"];

/**
 * Whether a hub address from app-pair.json may be paired with unasked: http(s) to this machine, a private network or
 * a tailnet. Anything else still pairs, but only when someone types it.
 */
export const privateHubOrigin = (origin: string): boolean => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const family = isIP(host);
  if (family === 4) return privateV4(host);
  if (family === 6) return privateV6(host);
  return host === "localhost" || !host.includes(".") || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
};
