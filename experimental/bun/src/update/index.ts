// fleetd updating itself (crates/fleetd/src/update/mod.rs), shared by `fleetd update`, the hub's `hub_update` and a
// node its hub asks to: the release channel, the channel's files and a download checked against its SHA256SUMS, the
// swap that keeps the binary it replaces, the services `fleetd init` made (service.ts), and the watcher that restarts
// one and puts the previous build back if it doesn't come up (finish.ts).
//
// Release assets have version-less names next to `SHA256SUMS` and `release.json`, at `releases/download/edge/` or
// `releases/latest/download/`. When one answers a server error or doesn't answer, the same asset comes through the
// releases API instead, checked the same way. `FLEETD_BASE_URL` points at another asset directory.
//
// The Rust build downloads a release's packed `<asset>.lzma` when its SHA256SUMS lists one; Bun has no LZMA decoder,
// so this port always takes the plain asset, which every release has beside it, checked against the same line.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, chmodSync, copyFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { UpdateStage } from "../shared/contracts.ts";
import { HELPER } from "../node/runner/helper.ts";
import { VERSION } from "../shared/version.ts";
import { edgeStamp } from "./version.ts";

export const REPO = "unlaboredlabs/fleetd";

export type Channel = "edge" | "stable";

export function parseChannel(name: string): Channel {
  if (name === "edge" || name === "nightly") return "edge";
  if (name === "stable" || name === "latest") return "stable";
  throw new Error(`unknown channel ${JSON.stringify(name)}: use edge or stable`);
}

/** Edge builds stay on edge and tagged builds on stable; until the first tag, local builds follow edge. */
export const channelOf = (version: string, releaseBuild: boolean): Channel => (edgeStamp(version) || !releaseBuild ? "edge" : "stable");

/** Where the channel's assets are: `FLEETD_BASE_URL`, else its GitHub release download directory. */
export const baseUrl = (c: Channel) =>
  process.env.FLEETD_BASE_URL ??
  (c === "edge" ? `https://github.com/${REPO}/releases/download/edge` : `https://github.com/${REPO}/releases/latest/download`);

/** Why an update didn't happen, at which stage, in one plain sentence. */
export class Failure extends Error {
  constructor(
    readonly stage: UpdateStage,
    message: string,
  ) {
    super(message);
    this.name = "Failure";
  }
}

/** A channel's asset directory; tests stand in a fake release feed. */
export interface Feed {
  /** The asset's bytes, or a thrown Error in plain words: for the small files. */
  get(name: string): Promise<Uint8Array>;
  /** The asset's chunks to `sink` as they arrive. */
  stream?(name: string, sink: (chunk: Uint8Array) => void): Promise<void>;
}

export const GITHUB_FAILING = "GitHub's downloads are failing right now, try again later";

const STALL_MS = 60_000;
const SMALL_WAIT_MS = 600_000;
const RESUMES = 5;
const RESUME_WAIT_MS = 1000;

class Again extends Error {}
class Final extends Error {}

/** GitHub's API for the release whose download directory is `base`. */
export function releaseApi(base: string): string | undefined {
  const rest = base.startsWith("https://github.com/") ? base.slice(19) : undefined;
  const at = rest?.indexOf("/releases/") ?? -1;
  if (rest === undefined || at < 0) return undefined;
  const repo = rest.slice(0, at);
  const release = rest.slice(at + 10).replace(/\/+$/, "");
  if (release === "latest/download") return `https://api.github.com/repos/${repo}/releases/latest`;
  if (!release.startsWith("download/")) return undefined;
  return `https://api.github.com/repos/${repo}/releases/tags/${release.slice(9)}`;
}

const bothFailed = (link: string, api: string) => `${GITHUB_FAILING} (${link}; through GitHub's API: ${api})`;
const after = (link: string | undefined, e: string) => (link !== undefined ? bothFailed(link, e) : e);
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The real feed: plain GETs under `base`, and for a GitHub release, its `api` when those fail. */
export class HttpFeed implements Feed {
  constructor(
    readonly base: string,
    readonly api: string | undefined = releaseApi(base),
  ) {}

  private async apiUrl(name: string): Promise<string> {
    const api = this.api!;
    let answer: Response;
    try {
      answer = await fetch(api, { headers: { accept: "application/vnd.github+json", "user-agent": `fleetd/${VERSION}` }, signal: AbortSignal.timeout(SMALL_WAIT_MS) });
    } catch (e) {
      throw new Error(`GET \`${api}\`: ${why(e)}`);
    }
    if (!answer.ok) throw new Error(`GET \`${api}\`: ${answer.status} ${answer.statusText}`.trimEnd());
    const release = (await answer.json()) as { assets?: { name: string; url: string }[] };
    const asset = release.assets?.find((a) => a.name === name);
    if (!asset) throw new Error(`\`${name}\` is not in the release at \`${api}\``);
    return asset.url;
  }

  /** A GET of a build from byte `from`, or with undefined of a small file. */
  private async send(url: string, from: number | undefined, api: boolean): Promise<Response> {
    const headers: Record<string, string> = { "user-agent": `fleetd/${VERSION}` };
    if (api) headers.accept = "application/octet-stream";
    if (from !== undefined && from > 0) headers.range = `bytes=${from}-`;
    let answer: Response;
    try {
      answer = await fetch(url, { headers, ...(from === undefined ? { signal: AbortSignal.timeout(SMALL_WAIT_MS) } : {}) });
    } catch (e) {
      throw new Again(`GET \`${url}\`: ${why(e)}`);
    }
    const status = `${answer.status} ${answer.statusText}`.trimEnd();
    if (answer.status >= 500 || answer.status === 429) throw new Again(`GET \`${url}\`: ${status}`);
    if (!answer.ok) throw new Final(`GET \`${url}\`: ${status}`);
    const start = from ?? 0;
    const resumed = answer.headers.get("content-range")?.startsWith(`bytes ${start}-`) ?? false;
    if (start > 0 && (answer.status !== 206 || !resumed)) {
      throw new Final(`GET \`${url}\` was cut off at byte ${start}, and the server can't go on from there`);
    }
    return answer;
  }

  private async fetchSmall(url: string, api: boolean): Promise<Uint8Array> {
    const answer = await this.send(url, undefined, api);
    try {
      return new Uint8Array(await answer.arrayBuffer());
    } catch (e) {
      throw new Again(`GET \`${url}\`: ${why(e)}`);
    }
  }

  async get(name: string): Promise<Uint8Array> {
    const url = `${this.base}/${name}`;
    let link: string;
    try {
      return await this.fetchSmall(url, false);
    } catch (e) {
      if (e instanceof Final || !(e instanceof Again)) throw new Error(why(e));
      link = e.message;
    }
    if (!this.api) throw new Error(link);
    try {
      return await this.fetchSmall(await this.apiUrl(name), true);
    } catch (e) {
      throw new Error(bothFailed(link, why(e)));
    }
  }

  async stream(name: string, sink: (chunk: Uint8Array) => void): Promise<void> {
    let url = `${this.base}/${name}`;
    let link: string | undefined;
    let got = 0;
    let tries = 0;
    for (;;) {
      const before = got;
      let cut: string;
      try {
        const answer = await this.send(url, got, link !== undefined);
        // Bun's fetch ends a body cut short without an error: its Content-Length tells.
        const length = Number(answer.headers.get("content-length") ?? Number.NaN);
        const expected = Number.isFinite(length) ? got + length : undefined;
        cut = await (async () => {
          const reader = answer.body!.getReader();
          for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const stalled = new Promise<"stall">((r) => (timer = setTimeout(() => r("stall"), STALL_MS)));
            let read: { done: true; value?: undefined } | { done: false; value: Uint8Array } | "stall";
            try {
              read = await Promise.race([reader.read(), stalled]);
            } catch (e) {
              return `GET \`${url}\`: ${why(e)}`;
            } finally {
              clearTimeout(timer);
            }
            if (read === "stall") {
              void reader.cancel().catch(() => {});
              return `GET \`${url}\`: operation timed out`;
            }
            if (read.done) return expected !== undefined && got < expected ? `GET \`${url}\`: the body ended at byte ${got} of ${expected}` : "";
            sink(read.value);
            got += read.value.length;
          }
        })();
        if (cut === "") return;
      } catch (e) {
        if (e instanceof Final) throw new Error(after(link, e.message));
        if (!(e instanceof Again)) throw e;
        if (link === undefined && this.api) {
          try {
            url = await this.apiUrl(name);
          } catch (a) {
            throw new Error(bothFailed(e.message, why(a)));
          }
          link = e.message;
          tries = 0;
          continue;
        }
        cut = e.message;
      }
      tries = got > before ? 1 : tries + 1;
      if (tries > RESUMES) throw new Error(after(link, cut));
      await Bun.sleep(RESUME_WAIT_MS * tries);
    }
  }
}

/** The channel's release.json: its newest CLI's version. */
export async function release(feed: Feed): Promise<{ cliVersion?: string }> {
  let bytes: Uint8Array;
  try {
    bytes = await feed.get("release.json");
  } catch (e) {
    throw downloadFailure("couldn't read the release", why(e));
  }
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as { cliVersion?: unknown };
    if (v === null || typeof v !== "object") throw new Error("invalid type: expected struct Release");
    return typeof v.cliVersion === "string" ? { cliVersion: v.cliVersion } : {};
  } catch (e) {
    throw new Failure("download", `the release's release.json is not valid: ${why(e)}`);
  }
}

/** The release's SHA256SUMS. */
export async function sums(feed: Feed): Promise<Map<string, string>> {
  let bytes: Uint8Array;
  try {
    bytes = await feed.get("SHA256SUMS");
  } catch (e) {
    throw downloadFailure("couldn't read the release's checksums", why(e));
  }
  return parseSums(new TextDecoder().decode(bytes));
}

const notInRelease = (name: string) => new Failure("download", `\`${name}\` is not in the release`);
const downloadFailed = (name: string, e: string) => downloadFailure(`couldn't download \`${name}\``, e);
function downloadFailure(what: string, e: string): Failure {
  return new Failure("download", e.startsWith(GITHUB_FAILING) ? e : `${what}: ${e}`);
}
const notKept = (path: string, e: unknown) => new Failure("install", `couldn't keep the downloaded build at \`${path}\`: ${why(e)}`);

/** A checked download in memory: the release's SHA256SUMS line for `name`, and the asset's bytes that match it. */
export async function verified(feed: Feed, name: string): Promise<Uint8Array> {
  const [s, bytes] = await Promise.allSettled([sums(feed), feed.get(name)]);
  if (s.status === "rejected") throw s.reason;
  if (!s.value.has(name)) throw notInRelease(name);
  if (bytes.status === "rejected") throw downloadFailed(name, why(bytes.reason));
  matchSums(s.value, name, sha256Hex(bytes.value));
  return bytes.value;
}

/** `verified` straight into `path`: it lands only when it matches; otherwise `path` is as it was. */
export async function verifiedTo(feed: Feed, name: string, path: string): Promise<void> {
  return checkedTo(feed, await sums(feed), name, path);
}

/** `verifiedTo` against sums already read. */
export async function checkedTo(feed: Feed, s: Map<string, string>, name: string, path: string): Promise<void> {
  if (!s.has(name)) throw notInRelease(name);
  const part = staging(path);
  try {
    const actual = await downloadTo(feed, name, part);
    matchSums(s, name, actual);
    try {
      renameSync(part, path);
    } catch (e) {
      throw notKept(path, e);
    }
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}

/** Streams `name` into a new file at `part`, hashing it on the way: its SHA-256. */
async function downloadTo(feed: Feed, name: string, part: string): Promise<string> {
  try {
    mkdirSync(dirname(part), { recursive: true });
  } catch (e) {
    throw notKept(part, e);
  }
  let fd: number;
  try {
    fd = openSync(part, "w", 0o755);
  } catch (e) {
    throw notKept(part, e);
  }
  const sha = new Bun.CryptoHasher("sha256");
  try {
    const sink = (chunk: Uint8Array) => {
      try {
        writeSync(fd, chunk);
      } catch (e) {
        throw new Error(`couldn't write \`${part}\`: ${why(e)}`);
      }
      sha.update(chunk);
    };
    try {
      if (feed.stream) await feed.stream(name, sink);
      else sink(await feed.get(name));
    } catch (e) {
      throw downloadFailed(name, why(e));
    }
    try {
      chmodSync(part, 0o755);
      fsyncSync(fd);
    } catch (e) {
      throw notKept(part, e);
    }
  } finally {
    closeSync(fd);
  }
  return sha.digest("hex");
}

function matchSums(s: Map<string, string>, name: string, actual: string): void {
  const expected = s.get(name);
  if (expected === undefined) throw notInRelease(name);
  if (actual !== expected) {
    throw new Failure("checksum", `\`${name}\`: checksum mismatch (expected \`${expected}\`, got \`${actual}\`); nothing was changed`);
  }
}

/** Whether the file at `path` is the build the sums name for `asset`. */
export function isBuild(path: string, s: Map<string, string>, asset: string): boolean {
  const want = s.get(asset);
  if (want === undefined) return false;
  try {
    return fileSha256Hex(path) === want;
  } catch {
    return false;
  }
}

/** `sha256sum` output: `<hex>  <name>` per line (`*<name>` in binary mode). */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s(.*)$/.exec(line);
    if (m) out.set(m[2]!.trimStart().replace(/^\*+/, ""), m[1]!.toLowerCase());
  }
  return out;
}

export const sha256Hex = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export const fileSha256Hex = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

/** Which implementation a build is (update/mod.rs `Flavour`): each updates to its own flavour's asset, so a machine
 * changes flavour only when `fleetd update --flavour` says so. */
export type Flavour = "rust" | "bun";

/** The flavour this build is. */
export const FLAVOUR: Flavour = "bun";

export function parseFlavour(name: string): Flavour {
  if (name === "rust" || name === "bun") return name;
  throw new Error(`unknown flavour ${JSON.stringify(name)}: use rust or bun`);
}

/** This platform's CLI asset: `fleetd-bun-<os>-<arch>`, this flavour's. */
export const cliAsset = (): string => assetOf(FLAVOUR);

/** This platform's asset of `flavour`: `fleetd-<os>-<arch>` for Rust, `fleetd-bun-<os>-<arch>` for Bun. */
export function assetOf(flavour: Flavour): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined;
  if (!arch) throw new Error(`no fleetd release build for ${process.arch === "ia32" ? "x86" : process.arch}`);
  return flavour === "rust" ? `fleetd-${os}-${arch}` : `fleetd-bun-${os}-${arch}`;
}

/** The session host beside the Bun build at `exe` (node/runner/helper.ts): the release's Rust build, which is also the
 * Rust build a switch back can put in place without a download. */
export const helperPath = (exe: string) => join(dirname(exe), HELPER);

/** Where an update keeps the session host it replaced, beside the previous binary `prev`, for `restore`. */
export const keptHelper = (prev: string) => `${prev}.session-host`;

/** Brings the session host beside `exe` to the release `s` names, when there is one there: it moves with the Bun build,
 * so the two are always one release's. With `prev`, the update's previous binary, the session host it replaces is kept
 * beside it (`keptHelper`), so a rollback puts both back; one kept by an earlier update goes first. */
export async function updateHelper(feed: Feed, s: Map<string, string>, exe: string, prev?: string): Promise<void> {
  const path = helperPath(exe);
  const asset = assetOf("rust");
  if (prev !== undefined) rmSync(keptHelper(prev), { force: true });
  if (!existsSync(path) || isBuild(path, s, asset)) return;
  if (prev !== undefined) {
    try {
      mkdirSync(dirname(prev), { recursive: true });
      replaceFileFrom(keptHelper(prev), path);
    } catch (e) {
      throw new Failure("install", `couldn't keep the session host for a rollback: ${errText(e)}; nothing was changed`);
    }
  }
  await checkedTo(feed, s, asset, path);
}

/** The installed binary this process was started from: the path the services name. */
export function installedExe(): string {
  const exe = process.execPath.replace(/ \(deleted\)$/, "");
  try {
    return realpathSync(exe);
  } catch {
    return exe;
  }
}

/** The bytes of the binary this process runs, whatever has been installed over its path since. */
export function runningBinary(): Uint8Array {
  if (process.platform === "linux") return readFileSync("/proc/self/exe");
  if (kept) return kept;
  throw new Error("this process's binary wasn't kept when it started");
}
let kept: Uint8Array | undefined;
/** Called first thing on macOS: holds this process's binary before anything can install over its path. */
export function keepRunningBinary(): void {
  if (process.platform !== "linux") {
    try {
      kept = readFileSync(process.execPath);
    } catch {}
  }
}

/** The file beside `path` that a new one is written to before it is renamed over `path`. */
export const staging = (path: string) => join(dirname(path), `.${basename(path)}.new`);

/** Writes a sibling file and renames it over `path`; never writes into the old file. */
export function replaceFile(path: string, bytes: Uint8Array | string): void {
  replaceWith(path, (fd) => void writeSync(fd, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes));
}

/** `replaceFile` with a copy of the file at `from`. */
export function replaceFileFrom(path: string, from: string): void {
  const tmp = staging(path);
  try {
    copyFileSync(from, tmp);
    chmodSync(tmp, 0o755);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function replaceWith(path: string, fill: (fd: number) => void): void {
  const tmp = staging(path);
  try {
    const fd = openSync(tmp, "w", 0o755);
    try {
      fill(fd);
      chmodSync(tmp, 0o755);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Keeps `previous` at `prev`, then puts a copy of the build at `next` at `exe`. Either failing leaves `exe` as it was. */
export function swap(exe: string, next: string, previous: Uint8Array, prev: string): void {
  const install = (what: string, e: unknown) => new Failure("install", `couldn't ${what}: ${errText(e)}; nothing was changed`);
  try {
    mkdirSync(dirname(prev), { recursive: true });
    replaceFile(prev, previous);
  } catch (e) {
    throw install("keep the previous binary", e);
  }
  try {
    replaceFileFrom(exe, next);
  } catch (e) {
    throw install(`replace ${exe}`, e);
  }
}

/** Puts the binary `swap` kept back at `exe`, and the session host `updateHelper` kept beside it, if it kept one. */
export function restore(exe: string, prev: string): void {
  replaceFileFrom(exe, prev);
  if (existsSync(keptHelper(prev))) replaceFileFrom(helperPath(exe), keptHelper(prev));
}

/** An io error's words as Rust prints them: "No such file or directory (os error 2)". */
export function errText(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  const msgs: Record<string, [string, number]> = {
    ENOENT: ["No such file or directory", 2],
    EACCES: ["Permission denied", 13],
    EEXIST: ["File exists", 17],
    ENOSPC: ["No space left on device", 28],
    ETXTBSY: ["Text file busy", 26],
    EROFS: ["Read-only file system", 30],
  };
  const known = err?.code ? msgs[err.code] : undefined;
  return known ? `${known[0]} (os error ${known[1]})` : why(e);
}

export const exists = existsSync;
