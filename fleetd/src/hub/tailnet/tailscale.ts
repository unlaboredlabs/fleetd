// Tailscale's own programs as a gateway runs them: the pinned static build, fetched (checksum verified) the first time
// it's needed, and tailscaled's local API on its unix socket (status, a dial, a name lookup). A self-hosted hub runs no
// gateway since W760 (D594); fleetd cloud's gateway, written again in its own src/tailnet, is held against this pin
// and its stand-in (test/tailnet_standin.ts) by its tests until its pin move takes them over (W760's cloud follow-up).
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, isIP, type Socket } from "node:net";
import { join } from "node:path";

/** The build fleetd was tested with, and each architecture's tarball's SHA-256 (pkgs.tailscale.com/stable). */
export const TAILSCALE = {
  version: "1.104.7",
  sha256: {
    amd64: "e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c",
    arm64: "d6bed2720310b328b861f943d7b4016c5358a9bad60575eb51e8143b79068484",
  },
} as const;

export type Arch = keyof typeof TAILSCALE.sha256;
export type Programs = { tailscale: string; tailscaled: string };

const archOf = (arch: string): Arch | undefined => (arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined);

/** Why the gateway can't run on this hub, in plain words; undefined where it can. */
export function unsupported(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "linux" && archOf(arch)) return undefined;
  return `Tailscale's gateway runs on Linux hubs, and this hub runs on ${platform} (${arch})`;
}

export const tarballUrl = (arch: Arch, version: string = TAILSCALE.version) => `https://pkgs.tailscale.com/stable/tailscale_${version}_${arch}.tgz`;

/** The pinned tailscale and tailscaled under `dir` (`<dir>/<version>/`), fetched and checked once. */
export async function programs(dir: string, fetcher: typeof fetch = fetch, arch: string = process.arch): Promise<Programs> {
  const a = archOf(arch);
  if (!a) throw new Error(unsupported(process.platform, arch));
  const at = join(dir, TAILSCALE.version);
  const out = { tailscale: join(at, "tailscale"), tailscaled: join(at, "tailscaled") };
  if (existsSync(out.tailscale) && existsSync(out.tailscaled)) return out;
  const res = await fetcher(tarballUrl(a), { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Tailscale's download answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (got !== TAILSCALE.sha256[a]) throw new Error(`Tailscale's download didn't match its checksum (${got.slice(0, 12)}…)`);
  const tmp = `${at}.part`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const tgz = join(tmp, "tailscale.tgz");
  writeFileSync(tgz, bytes);
  const top = `tailscale_${TAILSCALE.version}_${a}`;
  const tar = Bun.spawnSync(["tar", "-xzf", tgz, "-C", tmp, "--strip-components=1", `${top}/tailscale`, `${top}/tailscaled`], { stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(`Tailscale's download didn't unpack: ${tar.stderr.toString().trim().slice(0, 200)}`);
  rmSync(tgz, { force: true });
  for (const p of ["tailscale", "tailscaled"]) chmodSync(join(tmp, p), 0o755);
  rmSync(at, { recursive: true, force: true });
  renameSync(tmp, at);
  return out;
}

/** What the gateway reads of tailscaled's status. */
export type Status = {
  BackendState?: string;
  AuthURL?: string;
  CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string } | null;
  Self?: Device | null;
  /** With `peers`: every other device the gateway's netmap has. */
  Peer?: Record<string, Device> | null;
};

/** A device as tailscaled's status names it. */
export type Device = { DNSName?: string; HostName?: string; TailscaleIPs?: string[] | null };

/** tailscaled's local API on `sock`. */
export class LocalApi {
  constructor(readonly sock: string) {}

  async status(signal?: AbortSignal, peers = false): Promise<Status> {
    const res = await fetch(`http://local-tailscaled.sock/localapi/v0/status?peers=${peers}`, { unix: this.sock, ...(signal ? { signal } : {}) } as RequestInit);
    if (!res.ok) throw new Error(`tailscaled's status answered ${res.status}`);
    return (await res.json()) as Status;
  }

  /** tailscaled's own answer to a lookup of `name`, of the DNS type named `type` (A, AAAA, PTR…): a whole DNS message. */
  async dns(name: string, type: string, signal?: AbortSignal): Promise<Uint8Array> {
    const q = new URLSearchParams({ name: name.endsWith(".") ? name : `${name}.`, type });
    const res = await fetch(`http://local-tailscaled.sock/localapi/v0/dns-query?${q}`, { unix: this.sock, ...(signal ? { signal } : {}) } as RequestInit);
    if (!res.ok) throw new Error(`tailscaled's lookup answered ${res.status}: ${(await res.text()).trim().slice(0, 200)}`);
    const body = (await res.json()) as { Bytes?: string };
    return new Uint8Array(Buffer.from(body.Bytes ?? "", "base64"));
  }

  /** A TCP connection through tailscaled to `host` (an address or a MagicDNS name) on `port`: its `tailscale nc`. */
  dial(host: string, port: number, signal?: AbortSignal): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = connect(this.sock);
      let head = Buffer.alloc(0);
      const fail = (e: Error) => (s.destroy(), reject(e));
      const abort = () => fail(new Error("the dial was given up"));
      signal?.addEventListener("abort", abort, { once: true });
      s.once("connect", () =>
        s.write(
          `POST /localapi/v0/dial HTTP/1.1\r\nHost: local-tailscaled.sock\r\nConnection: upgrade\r\nUpgrade: ts-dial\r\nDial-Host: ${host}\r\nDial-Port: ${port}\r\nDial-Network: tcp\r\n\r\n`,
        ),
      );
      const onData = (d: Buffer) => {
        head = Buffer.concat([head, d]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) {
          if (head.length > 16_384) fail(new Error("tailscaled's answer to a dial was too long"));
          return;
        }
        s.off("data", onData);
        s.off("error", fail);
        signal?.removeEventListener("abort", abort);
        const lines = head.subarray(0, end).toString().split("\r\n");
        if (!/^HTTP\/1\.1 101 /u.test(lines[0] ?? "")) {
          const why = head.subarray(end + 4).toString().trim().slice(0, 200) || (lines[0] ?? "");
          return fail(new Error(why));
        }
        const rest = head.subarray(end + 4);
        if (rest.length) s.unshift(rest);
        resolve(s);
      };
      s.on("data", onData);
      s.once("error", fail);
    });
  }
}

/** DNS type numbers the gateway's lookup takes, by the names tailscaled takes them as. */
export const DNS_TYPES: Readonly<Record<number, string>> = { 1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX", 16: "TXT", 28: "AAAA", 33: "SRV", 65: "HTTPS" };

/** An address as one spelling: IPv6 compressed and lowercase (a box's capture writes it out in full). */
export function canonicalIp(ip: string): string {
  const bare = ip.replace(/^\[(.*)\]$/u, "$1");
  if (isIP(bare) !== 6) return bare;
  try {
    return new URL(`http://[${bare}]`).hostname.slice(1, -1);
  } catch {
    return bare.toLowerCase();
  }
}

/** Who a dial may reach: the netmap's peers, by address and by full MagicDNS name, never the gateway itself. */
export type Peers = { ips: Set<string>; names: Set<string> };

/** The peers of `st` (a status read with peers), the gateway's own addresses and names left out. */
export function peersOf(st: Status): Peers {
  const name = (d: Device) => (d.DNSName ?? "").toLowerCase().replace(/\.$/u, "");
  const self = new Set([...(st.Self?.TailscaleIPs ?? []).map(canonicalIp), ...(st.Self ? [name(st.Self)] : [])]);
  const ips = new Set<string>();
  const names = new Set<string>();
  for (const d of Object.values(st.Peer ?? {})) {
    for (const ip of d.TailscaleIPs ?? []) if (!self.has(canonicalIp(ip))) ips.add(canonicalIp(ip));
    const full = name(d);
    if (full && !self.has(full)) names.add(full);
  }
  return { ips, names };
}

/** Whether a dial to `host` reaches one of `p`'s peers. */
export const isPeer = (p: Peers, host: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/u, "");
  return isIP(canonicalIp(h)) !== 0 ? p.ips.has(canonicalIp(h)) : p.names.has(h);
};
