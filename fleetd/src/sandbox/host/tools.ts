// What a node needs to run an agent in a VM of its own, fetched by the node itself the first time it's asked, each
// pinned and checked, into `<node home>/vm/`: Cloud Hypervisor and ch-remote (static release binaries) and its guest
// kernel, straight from Cloud Hypervisor's GitHub releases against the sha256 pinned here; virtiofsd, passt and the
// read-only root image from fleetd's own release `vm-<key>` (sandbox/image/recipe.ts), against that release's
// SHA256SUMS, as `fleetd update` checks fleetd itself. No root, no package manager, nothing outside the node's folder,
// no command for a person to run. A pin that changes fetches that file again on the next ask, and the version it
// replaces goes. One fetch at a time per folder: a caller that comes while one is under way waits for it.
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { writeAtomic } from "../../node/secrets/files.ts";
import { ASSETS, assetUrl, IMAGE } from "../image/recipe.ts";

/** One file the node keeps: where it comes from and how it's checked. `sha256` absent: the release's SHA256SUMS. */
export type Pin = { name: string; version: string; url: string; file: string; sha256?: string; zstd?: boolean; exec?: boolean };

const CH = "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/v54.1";
const KERNEL = "https://github.com/cloud-hypervisor/linux/releases/download/ch-release-v7.2.8-20261009";

/** The pins, x86_64 Linux only. */
export const PINS: readonly Pin[] = [
  {
    name: "cloud-hypervisor",
    version: "v54.1",
    url: `${CH}/cloud-hypervisor-static`,
    file: "cloud-hypervisor",
    sha256: "f9ffb9646783233d1f0fb09e77db1fca66499d1041e63bc011b90683c0d49933",
    exec: true,
  },
  {
    name: "ch-remote",
    version: "v54.1",
    url: `${CH}/ch-remote-static`,
    file: "ch-remote",
    sha256: "06c111b691ee085c0392e6d53f6600131e425e54669546dd0f2c40bdedc8e5ce",
    exec: true,
  },
  {
    name: "kernel",
    version: "ch-release-v7.2.8-20261009",
    url: `${KERNEL}/vmlinux-x86_64`,
    file: "vmlinux",
    sha256: "edfeb8a8a6c04ff2979e9f1c700feaa29b8f564f952261834ef0b7d2e673a853",
  },
  { name: "virtiofsd", version: IMAGE.tag, url: assetUrl(ASSETS.virtiofsd), file: "virtiofsd", exec: true },
  { name: "passt", version: IMAGE.tag, url: assetUrl(ASSETS.passt), file: "passt", exec: true },
  { name: "root", version: IMAGE.tag, url: assetUrl(ASSETS.root), file: "root.ext4", zstd: true },
];

/** The release's SHA256SUMS, for the pins that take their sum from it. */
export const SUMS_URL = assetUrl(ASSETS.sums);

/** The files, as the VM kind uses them. */
export type VmTools = {
  cloudHypervisor: string;
  chRemote: string;
  kernel: string;
  virtiofsd: string;
  passt: string;
  /** The root image: ext4, opened read-only by every VM. */
  root: string;
};

/** The longest one fetch may take: the root image is about 0.5 GB compressed. */
export const FETCH_WAIT_MS = 60 * 60_000;

export const vmDir = (home: string) => join(home, "vm");

/** Where to keep the files (`dir`), and for the tests, stand-in pins, sums and wait. */
export type Fetch = { dir: string; pins?: readonly Pin[]; sumsUrl?: string; waitMs?: number; platform?: string; arch?: string };

/** Why the files couldn't be fetched, in a sentence. */
export class FetchFailed extends Error {}

/** Bun's node:zlib has zstd; the Node types this repo pins don't list it yet. */
const createZstdDecompress = (zlib as unknown as { createZstdDecompress: () => Transform }).createZstdDecompress;

const pathOf = (dir: string, pin: Pin) => join(dir, pin.name, pin.version, pin.file);

function toolsOf(dir: string, pins: readonly Pin[]): VmTools | undefined {
  const at = (name: string) => {
    const pin = pins.find((p) => p.name === name);
    return pin && existsSync(pathOf(dir, pin)) ? pathOf(dir, pin) : undefined;
  };
  const tools = {
    cloudHypervisor: at("cloud-hypervisor"),
    chRemote: at("ch-remote"),
    kernel: at("kernel"),
    virtiofsd: at("virtiofsd"),
    passt: at("passt"),
    root: at("root"),
  };
  return Object.values(tools).every((p) => p !== undefined) ? (tools as VmTools) : undefined;
}

/** The files at their pins, when every one is there. A file is there only once it was checked. */
export const findTools = (o: Fetch): VmTools | undefined => toolsOf(o.dir, o.pins ?? PINS);

/** The last fetch that failed, kept for the capability check: `<dir>/state.json`. */
export type FetchState = { failed: string; at: number };

export function readState(dir: string): FetchState | undefined {
  try {
    const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as Partial<FetchState>;
    return typeof s.failed === "string" && typeof s.at === "number" ? { failed: s.failed, at: s.at } : undefined;
  } catch {
    return undefined;
  }
}

const fetching = new Map<string, Promise<VmTools>>();

/** The files, each fetched and checked first when it isn't there at its pin. Throws FetchFailed. */
export function ensureTools(o: Fetch): Promise<VmTools> {
  const there = findTools(o);
  if (there) return Promise.resolve(there);
  let going = fetching.get(o.dir);
  if (!going) {
    going = fetchAll(o).finally(() => fetching.delete(o.dir));
    fetching.set(o.dir, going);
  }
  return going;
}

async function fetchAll(o: Fetch): Promise<VmTools> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  if (platform !== "linux" || arch !== "x64") throw new FetchFailed(`VMs run on x86_64 Linux only, not ${platform}/${arch}`);
  const pins = o.pins ?? PINS;
  const waitMs = o.waitMs ?? FETCH_WAIT_MS;
  try {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new FetchFailed(`couldn't make ${o.dir}: ${(e as Error).message}`);
  }
  try {
    const missing = pins.filter((p) => !existsSync(pathOf(o.dir, p)));
    const sums = missing.some((p) => !p.sha256) ? await releaseSums(o.sumsUrl ?? SUMS_URL, waitMs) : new Map<string, string>();
    for (const pin of missing) {
      const sha256 = pin.sha256 ?? sums.get(pin.url.split("/").at(-1) ?? "");
      if (!sha256) throw new FetchFailed(`fleetd's release ${IMAGE.tag} lists no checksum for ${pin.name}`);
      await fetchOne(o.dir, pin, sha256, waitMs);
    }
  } catch (e) {
    const why = e instanceof FetchFailed ? e.message : `fetching the VM files failed: ${(e as Error).message}`;
    try {
      writeAtomic(join(o.dir, "state.json"), JSON.stringify({ failed: why, at: Date.now() }));
    } catch {
      // The next ask says it again.
    }
    throw new FetchFailed(why);
  }
  rmSync(join(o.dir, "state.json"), { force: true });
  // Versions the pins no longer name go.
  for (const pin of pins) {
    try {
      for (const v of readdirSync(join(o.dir, pin.name))) if (v !== pin.version) rmSync(join(o.dir, pin.name, v), { recursive: true, force: true });
    } catch {
      // Nothing older.
    }
  }
  const tools = findTools(o);
  if (!tools) throw new FetchFailed("the fetch left a file out");
  return tools;
}

const hostOf = (url: string) => new URL(url).host;

function failedFetch(e: unknown, what: string, url: string, waitMs: number): FetchFailed {
  if (e instanceof FetchFailed) return e;
  const name = (e as Error).name;
  if (name === "TimeoutError" || name === "AbortError") return new FetchFailed(`${what} didn't download from ${hostOf(url)} within ${Math.round(waitMs / 60_000)} minutes`);
  return new FetchFailed(`couldn't download ${what} from ${hostOf(url)}: ${(e as Error).message}`);
}

/** The release's SHA256SUMS: file name to sha256. */
async function releaseSums(url: string, waitMs: number): Promise<Map<string, string>> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(Math.min(waitMs, 60_000)) });
  } catch (e) {
    throw failedFetch(e, `the checksums of fleetd's VM files`, url, waitMs);
  }
  if (res.status === 404) throw new FetchFailed(`fleetd's VM files for this build (release ${IMAGE.tag}) aren't published yet`);
  if (!res.ok) throw new FetchFailed(`${hostOf(url)} answered ${res.status} for the checksums of fleetd's VM files`);
  const sums = new Map<string, string>();
  for (const line of (await res.text()).split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/u.exec(line.trim());
    if (m?.[1] && m[2]) sums.set(m[2], m[1]);
  }
  return sums;
}

/** Downloads one file to `<name>/<version>/<file>`, checking the sha256 of what came down before it's put there. */
async function fetchOne(dir: string, pin: Pin, sha256: string, waitMs: number): Promise<void> {
  const target = pathOf(dir, pin);
  const part = `${target}.part`;
  mkdirSync(join(dir, pin.name, pin.version), { recursive: true, mode: 0o700 });
  const what = `${pin.name} ${pin.version}`;
  try {
    const res = await fetch(pin.url, { signal: AbortSignal.timeout(waitMs) });
    if (!res.ok || !res.body) throw new FetchFailed(`${hostOf(pin.url)} answered ${res.status} for ${what}`);
    const hash = new Bun.CryptoHasher("sha256");
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    const out = createWriteStream(part, { mode: pin.exec ? 0o700 : 0o600 });
    if (pin.zstd) await pipeline(body, tap, createZstdDecompress(), out);
    else await pipeline(body, tap, out);
    if (hash.digest("hex") !== sha256) throw new FetchFailed(`the download of ${what} didn't match its pinned checksum`);
    if (pin.exec) chmodSync(part, 0o755);
    renameSync(part, target);
  } catch (e) {
    rmSync(part, { force: true });
    throw failedFetch(e, what, pin.url, waitMs);
  }
}
