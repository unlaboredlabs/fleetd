// What this machine can host for sessions (machine roles W46), sent with each
// heartbeat's `load.hosts`: a browser (the broker's Chrome, or its install on the first session), an Android emulator
// (fleetd's own pinned one, node/device, with KVM), a Linux desktop (node/desktop adds its own line), and the agents'
// Mac's own screen. Each says why in plain words. Read at most every few minutes. iOS simulators are no screen any
// more (D298). The agents' Mac offers only its own screen, so it says nothing of the others.
//
// No switch turns a kind on or off: a machine hosts every kind it can run (an older node.json's `enabled` is ignored),
// and a kind it can't says why, with the command that fixes it where one does.
import { statSync } from "node:fs";
import type { HostCheck, HostOff, SessionHost } from "../../shared/contracts.ts";
import { CAP_SESSION_ANDROID } from "../../shared/node_link.ts";
import type { Node } from "../api.ts";
import { findChrome, installDir } from "../browser/chrome.ts";
import type { NodeConfig } from "../config.ts";
import { health as androidHealth } from "../device/index.ts";
import { kvm as kvmNow, type KvmCheck, supported as androidSupported } from "../device/sdk.ts";
import { macScreen as desktopMacScreen } from "../desktop/index.ts";
import { type Blocked, blocked as macBlocked } from "../desktop/mac/index.ts";

const FRESH_MS = 300_000;
/** A screen's idle timeout where node.json sets none. */
const IDLE_MINUTES = 30;
/** The Mac screen's own idle timeout (desktop/mac `IDLE_MINUTES`). */
const MAC_IDLE_MINUTES = 5;

type Section = Record<string, unknown>;

function check(host: SessionHost, off: HostOff | undefined, detail: string): HostCheck {
  return { host, ready: off === undefined, detail: detail.length > 300 ? `${detail.slice(0, 297)}...` : detail, ...(off ? { off } : {}) };
}

/** The check with the command that clears what stands in the way, where it can't run and one does. */
function fixed(c: HostCheck, fix: string | undefined): HostCheck {
  return !c.ready && fix && fix.length <= 300 ? { ...c, fix } : c;
}

/** The check with its idle timeout. */
const withIdle = (c: HostCheck, idleMinutes = IDLE_MINUTES): HostCheck => ({ ...c, idleMinutes });

export function browser(home: string, section: Section): HostCheck {
  return withIdle(browserCheck(home, section));
}

function browserCheck(home: string, section: Section): HostCheck {
  const named = section.chrome;
  if (typeof named === "string") {
    let there = false;
    try {
      there = statSync(named).isFile();
    } catch {}
    return there
      ? check("browser", undefined, `Chrome at ${named} (node.json)`)
      : check("browser", "missing", `node.json names Chrome at ${named}, which is not there`);
  }
  const found = findChrome(installDir(home));
  return found
    ? check("browser", undefined, `Chrome at ${found}`)
    : check("browser", undefined, "Chrome not installed yet: the node installs it with the first screen");
}

/**
 * fleetd's own Android emulator (node/device): ready where it is installed, or where /dev/kvm opens so the first
 * session installs it (again, after an install that failed); else what stands in the way.
 */
export function android(home: string, kvm: KvmCheck = kvmNow): HostCheck {
  return withIdle(androidCheck(androidHealth(home, kvm), kvm));
}

function androidCheck(health: ReturnType<typeof androidHealth>, kvm: KvmCheck): HostCheck {
  if (!androidSupported() || !health) return check("android", "unsupported", "Android screens run on Linux x86_64 with KVM");
  let off: HostOff | undefined;
  if (health.state === "installing") off = "installing";
  else if (health.state !== "ready" && health.state !== "wanted") {
    // With KVM opening, only a failed install: the next session tries it again, so the hub must send it.
    off = "ok" in kvm() ? undefined : "missing";
  }
  return fixed(check("android", off, health.message), health.fix);
}

/**
 * The agents' Mac's own screen, on the agents' Mac only (`agentsMac`): ready while the node's user is on the Mac's
 * screen, unlocked, with Screen Recording and Accessibility allowed.
 */
export function macScreen(agentsMac: boolean, blocked: () => Blocked | undefined = macBlocked, supported = process.platform === "darwin"): HostCheck {
  let c: HostCheck;
  if (!supported || !agentsMac) c = check("mac", "unsupported", "the Mac screen is the agents' Mac's own");
  else {
    // What stands in the way now (node/desktop/mac `blocked`): the session off the screen or locked, a grant missing.
    const why = blocked();
    c = why
      ? fixed(check("mac", "missing", why.message), why.fix)
      : check("mac", undefined, "the node's session is on the Mac's screen, unlocked, with Screen Recording and Accessibility");
  }
  return withIdle(c, MAC_IDLE_MINUTES);
}

const last = new Map<string, { at: number; checks: { before: HostCheck[]; after: HostCheck[] } }>();

/** Drops what was read, so the next heartbeat reads the machine again. */
export function forget(home: string): void {
  last.delete(home);
}

/** This node's own lines, read at most every few minutes: those before the desktop's, and the Mac's after it. */
export function lines(
  home: string,
  config: NodeConfig | undefined,
  kvm: KvmCheck = kvmNow,
  now = Date.now(),
  blocked: () => Blocked | undefined = macBlocked,
) {
  const kept = last.get(home);
  if (kept && now - kept.at < FRESH_MS) return kept.checks;
  const section = (key: string) => ((config as Record<string, unknown> | undefined)?.[key] ?? {}) as Section;
  const mac = macScreen(config?.agentsMac === true, blocked);
  const checks =
    config?.agentsMac === true ? { before: [], after: [mac] } : { before: [browser(home, section("browser")), android(home, kvm)], after: [mac] };
  last.set(home, { at: now, checks });
  return checks;
}

/**
 * The Android line ready only while the node lists `session_android`: node/device lists it once an agent can drive a
 * session here (agent-device on its PATH, the emulator ready), and the hub places Android screens by this line alone.
 */
export function listed(checks: HostCheck[], caps: string[]): HostCheck[] {
  if (caps.includes(CAP_SESSION_ANDROID)) return checks;
  return checks.map((c) =>
    c.host === "android" && c.ready
      ? { ...c, ready: false, off: "missing", detail: "not offered yet: this node lists Android sessions once agents can drive one here" }
      : c,
  );
}

/**
 * Adds the machine's lines to each heartbeat's `load.hosts`, around what the other areas put there (node/desktop's
 * line), in Rust's order (browser, android, desktop, mac), Android gated by its sessions being listed. After every
 * other area's.
 */
export function start(node: Node, kvm: KvmCheck = kvmNow): void {
  node.area("hb").contribute((hb) => {
    if (!hb.load) return;
    // The Mac screen's gate as node/desktop checks it at each start (its own test's, where one set it).
    const mine = lines(node.home, node.config, kvm, Date.now(), () => desktopMacScreen(node).blocked());
    hb.load.hosts = listed([...mine.before, ...(hb.load.hosts ?? []), ...mine.after], node.area("caps").list());
  });
}
