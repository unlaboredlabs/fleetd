// This computer's own Tailscale, as the hub and a node read it: whether it is on a tailnet, which one, its name there
// and the tailnet's MagicDNS suffix. tailscaled's local API on its socket (Linux), else the `tailscale` command
// (macOS's app puts it in the app bundle). Read only: fleetd never logs this computer in or out of a tailnet.
import { existsSync } from "node:fs";

export type LocalTailscale = {
  /** On a tailnet now: tailscaled runs and is logged in. */
  running: boolean;
  tailnet?: string;
  /** This computer's MagicDNS name, without the trailing dot. */
  device?: string;
  suffix?: string;
};

const SOCKETS = ["/var/run/tailscale/tailscaled.sock", "/run/tailscale/tailscaled.sock"];
const COMMANDS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"];
const WAIT_MS = 3_000;

type Status = {
  BackendState?: string;
  CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string } | null;
  Self?: { DNSName?: string } | null;
};

export const fromStatus = (s: Status): LocalTailscale => {
  if (s.BackendState !== "Running") return { running: false };
  const strip = (v: string | undefined) => (v ? v.replace(/\.$/u, "") : undefined);
  const out: LocalTailscale = { running: true };
  const tailnet = s.CurrentTailnet?.Name;
  const device = strip(s.Self?.DNSName);
  const suffix = strip(s.CurrentTailnet?.MagicDNSSuffix);
  if (tailnet) out.tailnet = tailnet;
  if (device) out.device = device;
  if (suffix) out.suffix = suffix;
  return out;
};

async function viaSocket(sock: string): Promise<Status | undefined> {
  try {
    const res = await fetch("http://local-tailscaled.sock/localapi/v0/status?peers=false", { unix: sock, signal: AbortSignal.timeout(WAIT_MS) } as RequestInit);
    return res.ok ? ((await res.json()) as Status) : undefined;
  } catch {
    return undefined;
  }
}

async function viaCommand(cmd: string): Promise<Status | undefined> {
  try {
    const p = Bun.spawn([cmd, "status", "--json", "--peers=false"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => p.kill(), WAIT_MS);
    const text = await new Response(p.stdout).text();
    clearTimeout(timer);
    await p.exited;
    return text.trim() ? (JSON.parse(text) as Status) : undefined;
  } catch {
    return undefined;
  }
}

/** This computer's Tailscale now; `{ running: false }` when it has none, or none that answers. */
export async function localTailscale(): Promise<LocalTailscale> {
  for (const sock of SOCKETS) {
    if (!existsSync(sock)) continue;
    const s = await viaSocket(sock);
    if (s) return fromStatus(s);
  }
  for (const cmd of COMMANDS) {
    if (cmd.startsWith("/") && !existsSync(cmd)) continue;
    const s = await viaCommand(cmd);
    if (s) return fromStatus(s);
  }
  return { running: false };
}

/** `localTailscale`, read at most every `ttlMs`: a session start asks it once per server. */
export function cachedLocalTailscale(ttlMs = 30_000, read: () => Promise<LocalTailscale> = localTailscale): () => Promise<LocalTailscale> {
  let at = 0;
  let last: Promise<LocalTailscale> | undefined;
  return () => {
    const now = Date.now();
    if (!last || now - at > ttlMs) {
      at = now;
      last = read();
    }
    return last;
  };
}
