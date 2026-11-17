// Whether this machine can run an agent in a VM of its own, and if not, why in a sentence and what fixes it. The VM
// kind asks before each box and the doctor shows it; a machine that can't keeps running agents as plain processes,
// so this never throws and never refuses a machine anything: it only answers.
//
// What a VM needs, none of it root (measured on the devbox, sandbox-per-agent-measurements):
//   - x86_64 Linux (the pinned builds are x86_64; macOS has no KVM);
//   - /dev/kvm read-write for this user, directly or through `sg kvm` (as the Android emulator takes it);
//   - unprivileged user and mount namespaces, which `virtiofsd --sandbox namespace` runs in;
//   - an upstream DNS server for the guest: passt can't hand out DNS where the host's resolver is a loopback stub
//     (systemd-resolved's 127.0.0.53), so the box is given the servers behind it, from
//     /run/systemd/resolve/resolv.conf;
//   - the pinned files (tools.ts), there or still fetchable: a fetch that failed holds the machine back for an hour.
import { readFileSync } from "node:fs";
import { type Kvm, type KvmRefusal, kvmAt, sgOpens } from "../../node/device/sdk.ts";
import { findTools, readState, vmDir } from "./tools.ts";

export type VmCheck =
  | {
      ok: true;
      /** How the VMM gets /dev/kvm: opened directly, or started through `sg kvm`. */
      kvm: Kvm;
      /** The DNS servers to give the guest (`fleetd.dns=`). */
      dns: string[];
      /** The pinned files are all there, or the VM kind fetches them (ensureTools) before its first box. */
      tools: "ready" | "fetch";
    }
  | { ok: false; why: string; fix?: string };

/** How long a failed fetch keeps the machine on plain processes before the next try. */
export const RETRY_FETCH_MS = 60 * 60_000;

/** What the check looks at; the tests stand in each. */
export type Probes = {
  platform: string;
  arch: string;
  kvm: () => { ok: Kvm } | { err: KvmRefusal };
  /** Whether this user can make a user and mount namespace: undefined if so, else what stood in the way. */
  userns: () => string | undefined;
  /** A file's text, or undefined when it can't be read. */
  read: (path: string) => string | undefined;
  /** The pinned files: there, never failed, or the last failure. */
  tools: () => "ready" | "fetch" | { failed: string; at: number };
  now: () => number;
};

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** The machine's own probes, for the node home `home`. */
export function machineProbes(home: string): Probes {
  return {
    platform: process.platform,
    arch: process.arch,
    kvm: () => kvmAt("/dev/kvm", "/etc/group", sgOpens, "VMs"),
    userns: () => {
      if (!Bun.which("unshare")) return "unshare (util-linux) isn't installed to try it";
      const ran = Bun.spawnSync(["unshare", "--user", "--map-root-user", "--mount", "true"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      return ran.success ? undefined : ran.stderr.toString().trim() || `unshare exited ${ran.exitCode}`;
    },
    read: readText,
    tools: () => {
      const dir = vmDir(home);
      if (findTools({ dir })) return "ready";
      return readState(dir) ?? "fetch";
    },
    now: Date.now,
  };
}

/** The resolv.conf nameservers a guest can reach: not loopback, not link-local. */
export function upstream(resolvConf: string): string[] {
  const out: string[] = [];
  for (const line of resolvConf.split("\n")) {
    const m = /^\s*nameserver\s+(\S+)/u.exec(line);
    const ns = m?.[1];
    if (!ns || ns.includes("%")) continue;
    const lower = ns.toLowerCase();
    if (/^127\./u.test(ns) || /^169\.254\./u.test(ns) || /^0\.0\.0\.0$/u.test(ns)) continue;
    if (lower === "::1" || lower === "::" || lower.startsWith("fe80:")) continue;
    if (!out.includes(ns)) out.push(ns);
  }
  // IPv4 first: a box always has an IPv4 route through passt.
  return [...out.filter((ns) => !ns.includes(":")), ...out.filter((ns) => ns.includes(":"))];
}

/** Can this machine run VMs? Never throws: a probe that does is an answer of no, with what it said. */
export function vmCheck(probes: Probes): VmCheck {
  try {
    return check(probes);
  } catch (e) {
    return { ok: false, why: `checking for VMs failed: ${(e as Error).message}` };
  }
}

function check(p: Probes): VmCheck {
  if (p.platform !== "linux") return { ok: false, why: `VMs need Linux with KVM; this machine runs ${p.platform === "darwin" ? "macOS" : p.platform}, so its agents run as plain processes.` };
  if (p.arch !== "x64") return { ok: false, why: `VMs run on x86_64 machines for now; this one is ${p.arch}, so its agents run as plain processes.` };

  const kvm = p.kvm();
  if ("err" in kvm) return { ok: false, why: kvm.err.why, ...(kvm.err.fix ? { fix: kvm.err.fix } : {}) };

  const userns = p.userns();
  if (userns !== undefined) {
    if (p.read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")?.trim() === "1") {
      return {
        ok: false,
        why: "AppArmor keeps this user from making the user namespace virtiofsd shares files from. The command lets unprivileged users make them again, now and after a reboot.",
        fix: "echo kernel.apparmor_restrict_unprivileged_userns=0 | sudo tee /etc/sysctl.d/60-fleetd-userns.conf && sudo sysctl --system",
      };
    }
    if (p.read("/proc/sys/user/max_user_namespaces")?.trim() === "0") {
      return {
        ok: false,
        why: "User namespaces are turned off on this machine (user.max_user_namespaces is 0), and virtiofsd shares files from one. The command turns them on, now and after a reboot.",
        fix: "echo user.max_user_namespaces=15000 | sudo tee /etc/sysctl.d/60-fleetd-userns.conf && sudo sysctl --system",
      };
    }
    return { ok: false, why: `This user can't make the user namespace virtiofsd shares files from: ${[...userns].slice(0, 200).join("")}` };
  }

  let dns = upstream(p.read("/etc/resolv.conf") ?? "");
  if (dns.length === 0) dns = upstream(p.read("/run/systemd/resolve/resolv.conf") ?? "");
  if (dns.length === 0) {
    return {
      ok: false,
      why: "No DNS server for VMs: this machine's resolver is a local stub (such as systemd-resolved's 127.0.0.53), which a VM can't reach, and /run/systemd/resolve/resolv.conf names no server behind it.",
    };
  }

  const tools = p.tools();
  if (typeof tools === "object") {
    const next = tools.at + RETRY_FETCH_MS;
    if (p.now() < next) {
      return { ok: false, why: `Fetching the VM files failed: ${tools.failed}. The node tries again after ${new Date(next).toISOString().slice(11, 16)} UTC.` };
    }
    return { ok: true, kvm: kvm.ok, dns, tools: "fetch" };
  }
  return { ok: true, kvm: kvm.ok, dns, tools };
}

/** The machine's own answer. */
export const canRunVms = (home: string): VmCheck => {
  try {
    return vmCheck(machineProbes(home));
  } catch (e) {
    return { ok: false, why: `checking for VMs failed: ${(e as Error).message}` };
  }
};
