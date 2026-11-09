// What `fleetd init` finds on its own: Tailscale, the LAN address, SSH hosts,
// local git repos, and the install command for a missing tool. Every probe here only reads.
import { createSocket } from "node:dgram";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Peer } from "./machine.ts";

export type Tailnet = { ipv4?: string; dnsName?: string; peers: Peer[] };

export function parseTailscaleStatus(json: string): Tailnet | undefined {
  let status: any;
  try {
    status = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (status?.BackendState !== "Running" || status.Self === undefined) return undefined;
  const dns = (node: any) => {
    const name = typeof node?.DNSName === "string" ? node.DNSName.replace(/\.+$/, "") : "";
    return name === "" ? undefined : name;
  };
  const ipv4 = (Array.isArray(status.Self.TailscaleIPs) ? status.Self.TailscaleIPs : []).find(
    (ip: unknown) => typeof ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip),
  );
  const peers: Peer[] = Object.values(status.Peer ?? {})
    .filter((p: any) => p?.Online === true && (p.OS === "linux" || p.OS === "macOS"))
    .flatMap((p: any) => {
      const dnsName = dns(p);
      return dnsName === undefined ? [] : [{ name: dnsName.split(".")[0]!, dnsName }];
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const self = dns(status.Self);
  return { ...(ipv4 ? { ipv4 } : {}), ...(self ? { dnsName: self } : {}), peers };
}

export function parseSshHosts(config: string): string[] {
  const hosts: string[] = [];
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    const m = /^(\S+?)[\s=]+(.*)$/.exec(line);
    if (!m || m[1]!.toLowerCase() !== "host") continue;
    for (const h of m[2]!.replace(/^[= \t]+/, "").split(/\s+/)) {
      const host = h.replace(/^"+|"+$/g, "");
      if (host !== "" && !/[*?!]/.test(host) && !hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

export function parseGitRemote(config: string): string | undefined {
  let section = "";
  let first: string | undefined;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || line.slice(0, eq).trim() !== "url" || !section.startsWith("[remote ")) continue;
    const url = line.slice(eq + 1).trim();
    if (section === '[remote "origin"]') return url;
    first ??= url;
  }
  return first;
}

export function shortRemote(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url.endsWith(".git")) url = url.slice(0, -4);
  if (url.startsWith("git@") && url.includes(":")) {
    const rest = url.slice(4);
    const c = rest.indexOf(":");
    return `${rest.slice(0, c)}/${rest.slice(c + 1)}`;
  }
  for (const scheme of ["https://", "http://", "ssh://git@", "ssh://", "git://"]) {
    if (url.startsWith(scheme)) {
      const rest = url.slice(scheme.length);
      return rest.slice(rest.lastIndexOf("@") + 1);
    }
  }
  return url;
}

export function parseGithubRepo(raw: string): [string, string] | undefined {
  const text = raw.trim();
  const short = shortRemote(text);
  const path = short.startsWith("github.com/")
    ? short.slice(11)
    : short.startsWith("www.github.com/")
      ? short.slice(15)
      : !text.includes(":") && !text.includes(".")
        ? short
        : undefined;
  if (path === undefined) return undefined;
  const parts = path.split("/");
  const ok = (s: string | undefined) => s !== undefined && s !== "" && /^[A-Za-z0-9_.-]+$/.test(s);
  return parts.length === 2 && ok(parts[0]) && ok(parts[1]) ? [parts[0]!, parts[1]!] : undefined;
}

export type Repo = { path: string; remote?: string };
export const REPO_ROOTS = ["src", "code", "projects", "dev", "Developer", "repos", "git"];

export function findRepos(roots: string[]): Repo[] {
  const found: Repo[] = [];
  const visit = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const dirs = names
      .filter((n) => !n.startsWith(".") && n !== "node_modules" && n !== "target")
      .map((n) => join(dir, n))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
    for (const path of dirs) {
      let isGit = false;
      try {
        isGit = statSync(join(path, ".git")).isDirectory();
      } catch {}
      if (isGit) {
        let remote: string | undefined;
        try {
          remote = parseGitRemote(readFileSync(join(path, ".git", "config"), "utf8"));
        } catch {}
        found.push({ path, ...(remote === undefined ? {} : { remote }) });
      } else if (depth < 2) visit(path, depth + 1);
    }
  };
  for (const root of roots) visit(root, 1);
  return found;
}

export function installCommand(tool: string, os: string, osRelease?: string): string {
  const like = (osRelease ?? "")
    .split("\n")
    .flatMap((l) => (l.startsWith("ID=") ? [l.slice(3)] : l.startsWith("ID_LIKE=") ? [l.slice(8)] : []))
    .map((v) => v.replace(/^"+|"+$/g, ""))
    .join(" ")
    .split(/\s+/);
  const family = (n: string) => like.includes(n);
  if (tool === "claude") return ["curl -fsSL https://claude.ai/install.sh", "bash"].join(" | ");
  if (tool === "gh") {
    if (os === "macos") return "brew install gh";
    if (family("debian") || family("ubuntu")) return "sudo apt install gh";
    if (family("fedora") || family("rhel")) return "sudo dnf install gh";
    if (family("arch")) return "sudo pacman -S github-cli";
    return "see https://github.com/cli/cli#installation";
  }
  if (tool === "node") {
    return os === "macos"
      ? "brew install node"
      : "curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs";
  }
  return `install ${tool}`;
}

export function noreplyIdentity(ghUserJson: string): string | undefined {
  try {
    const user = JSON.parse(ghUserJson);
    if (typeof user?.login !== "string" || !Number.isInteger(user.id) || user.id < 0) return undefined;
    return `${user.login} <${user.id}+${user.login}@users.noreply.github.com>`;
  } catch {
    return undefined;
  }
}

/** The private IPv4 address of the interface the default route leaves by: a UDP socket "connected" to a documentation
 * address (nothing is sent) has it as its local address. Undefined when there is none, or no route. */
export async function lanIpv4(): Promise<string | undefined> {
  let socket: ReturnType<typeof createSocket> | undefined;
  try {
    socket = createSocket("udp4");
    const s = socket;
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.connect(9, "192.0.2.1", () => resolve());
    });
    const ip = s.address().address;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? ip : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      socket?.close();
    } catch {}
  }
}
