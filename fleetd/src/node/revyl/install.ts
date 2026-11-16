// fleetd's own copy of Revyl's CLI on a node that has none, fetched when a Test or a Revyl screen first needs it: the
// release binary for this machine straight from Revyl's GitHub releases (what revyl.com/install.sh fetches), checked
// against the sha256 Revyl published for it, into the node's own folder. No script, no sudo, nothing system-wide, no
// shell profile changed; fleetd's builds and repo hold no copy. One install at a time per folder: a caller that comes
// while one is under way waits for it.
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { INSTALL_WAIT } from "../../shared/revyl.ts";

/** Revyl's releases of its CLI (github.com/RevylAI/revyl-cli). */
export const RELEASES = "https://github.com/RevylAI/revyl-cli/releases";

/** The version fleetd installs, and the sha256 of each platform's binary from that release's checksums.txt. */
export type Pin = { version: string; sha256: Readonly<Record<string, string>> };

export const PIN: Pin = {
  version: "v0.2.12",
  sha256: {
    "revyl-darwin-amd64": "3009d975851dffc0213b485ad41667d15aec7a617ec70f7d5e6d712928aaf83e",
    "revyl-darwin-arm64": "6d606356f3bfaf16a889924685ee1546920263f4aa650c5787e16fe73ae55278",
    "revyl-linux-amd64": "5171aa35cd50740bc037f43d098d8de3270ca29ae5d7b8a2d871e2f57a1385af",
    "revyl-linux-arm64": "ac0ce1d68c77dd4aa862310b61c6c423e894c88dcf765267bd3c4ad50e1150ef",
  },
};

/** Where to install (`dir`), and for the tests, a stand-in release channel, pin, platform and wait. */
export type Install = { dir: string; releases?: string; pin?: Pin; platform?: string; arch?: string; waitMs?: number };

/** Revyl's name for this machine's binary (`revyl-<os>-<arch>`), or undefined for one Revyl builds none for. */
export function assetFor(platform: string, arch: string): string | undefined {
  const os = platform === "darwin" || platform === "linux" ? platform : undefined;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  return os && cpu ? `revyl-${os}-${cpu}` : undefined;
}

/** Why fleetd's copy of Revyl's CLI couldn't be installed, in a sentence. */
export class InstallFailed extends Error {}

const installing = new Map<string, Promise<string>>();

/** The path of fleetd's copy of `revyl` in `o.dir`, installed first when it isn't there. Throws InstallFailed. */
export function installRevyl(o: Install): Promise<string> {
  const pin = o.pin ?? PIN;
  const bin = join(o.dir, pin.version, "revyl");
  if (existsSync(bin)) return Promise.resolve(bin);
  let going = installing.get(o.dir);
  if (!going) {
    going = download(o, pin, bin).finally(() => installing.delete(o.dir));
    installing.set(o.dir, going);
  }
  return going;
}

async function download(o: Install, pin: Pin, bin: string): Promise<string> {
  if (existsSync(bin)) return bin;
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const asset = assetFor(platform, arch);
  const sha256 = asset && pin.sha256[asset];
  if (!asset || !sha256) throw new InstallFailed(`Revyl's CLI has no build for ${platform}/${arch} (only macOS and Linux, on x64 or arm64)`);
  const url = `${o.releases ?? RELEASES}/download/${pin.version}/${asset}`;
  const host = new URL(url).host;
  const waitMs = o.waitMs ?? INSTALL_WAIT;
  const part = `${bin}.part`;
  try {
    mkdirSync(join(o.dir, pin.version), { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new InstallFailed(`couldn't make ${o.dir}: ${(e as Error).message}`);
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(waitMs) });
    if (!res.ok || !res.body) throw new InstallFailed(`${host} answered ${res.status} for Revyl's CLI ${pin.version} (${asset})`);
    const hash = new Bun.CryptoHasher("sha256");
    // Closed before it runs: a binary still open for writing can't be started (ETXTBSY).
    const out = await open(part, "w", 0o700);
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        await out.write(chunk);
      }
    } finally {
      await out.close();
    }
    if (hash.digest("hex") !== sha256) throw new InstallFailed(`the download of Revyl's CLI ${pin.version} didn't match the checksum Revyl published for it`);
    chmodSync(part, 0o755);
    renameSync(part, bin);
  } catch (e) {
    rmSync(part, { force: true });
    if (e instanceof InstallFailed) throw e;
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError") throw new InstallFailed(`Revyl's CLI didn't download from ${host} within ${Math.round(waitMs / 1000)} seconds`);
    throw new InstallFailed(`couldn't download Revyl's CLI from ${host}: ${(e as Error).message}`);
  }
  // Older versions fleetd installed here go.
  for (const name of readdirSync(o.dir)) if (name !== pin.version) rmSync(join(o.dir, name), { recursive: true, force: true });
  return bin;
}
