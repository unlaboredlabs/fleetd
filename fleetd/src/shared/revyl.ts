// The team's own Revyl account (W676), without the hub or the node: where a phone screen goes by its kind's route, what
// a check of the key found, which `revyl` commands an agent may run on its screen, and the key masked out of anything
// Revyl prints. The hub keeps the key (hub/revyl); the agent's node drives the screen through Revyl's documented CLI
// (node/revyl). No partner API, no billing: Revyl bills the team directly.
import type { KnownRevylCheckReason, KnownRevylRoute, RevylKind } from "./contracts.ts";

export const ROUTES: readonly KnownRevylRoute[] = ["ours_first", "ours_only", "revyl_only"];
export const KINDS: readonly RevylKind[] = ["ios", "android"];

/** How long a node may take to download Revyl's CLI the first time it needs it (node/revyl/install.ts). */
export const INSTALL_WAIT = 120_000;

/** How long Settings' Test of the key may take on a machine (`revyl device list`). */
export const CHECK_WAIT = 30_000;

/** A Revyl screen's idle timeout at Revyl, in seconds: as long as fleetd's own (IDLE_MS), so fleetd ends it first. */
export const IDLE_SECS = 30 * 60;

/** A kind's route in effect: the stored one while a key is connected (ours_first when none is stored), else ours_only. */
export function routeOf(stored: string | undefined, connected: boolean): KnownRevylRoute {
  if (!connected) return "ours_only";
  return ROUTES.includes(stored as KnownRevylRoute) ? (stored as KnownRevylRoute) : "ours_first";
}

/** How the team's own machines stand for a start: a slot free now, all of them full, or none that can host it. */
export type Ours = "free" | "full" | "none";

/**
 * Where a start goes, deterministically: the team's machine (`ours`), Revyl, or the line for the team's machines
 * (`line`, only with ours_only while they are full). Revyl's own queue holds a start while its sessions are all in use.
 * `ours` while none can host it leaves the refusal to today's placement, which says why.
 */
export function choose(route: KnownRevylRoute, ours: Ours): "ours" | "revyl" | "line" {
  switch (route) {
    case "revyl_only":
      return "revyl";
    case "ours_first":
      return ours === "free" ? "ours" : "revyl";
    case "ours_only":
      return ours === "full" ? "line" : "ours";
  }
}

/** Revyl's words for a key it refuses (docs.revyl.com/authentication: "Invalid API key", an expired key reads the same). */
const INVALID = /invalid api key|api key (?:has )?expired|expired api key|unauthori[sz]ed|\b401\b|not authenticated/i;

/** What a `revyl` run that failed says about the key: refused by Revyl, or anything else. */
export function failure(output: string): Exclude<KnownRevylCheckReason, "no_cli"> {
  return INVALID.test(output) ? "invalid_key" : "failed";
}

/** Revyl API keys (`rvl_…`) and `key` itself, masked. */
export function mask(text: string, key?: string): string {
  let out = text;
  if (key && key.length >= 4) out = out.split(key).join("rvl_…");
  return out.replace(/rvl_[A-Za-z0-9_\-.]{4,}/g, "rvl_…");
}

/** The last `max` characters of `text`, on a line's start when it can. */
export function tail(text: string, max = 600): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(t.length - max);
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl < max / 2 ? cut.slice(nl + 1) : cut;
}

/** The `revyl device` commands an agent may run on its own screen: coordinates, never Revyl's AI-driven targets. */
const DEVICE = new Set(["tap", "double-tap", "swipe", "long-press", "type", "key", "screenshot", "info", "hierarchy", "install", "launch", "navigate", "logs"]);

/** Flags fleetd sets itself, or that would reach past the agent's own screen. */
const OWN_FLAGS = new Set(["-s", "--session-id", "--all", "--api-key", "--target", "--intent"]);

/**
 * Why `argv` (what the agent typed after `revyl`) may not run on its Revyl screen, in a sentence; undefined when it may.
 * Allowed: `device` actions by coordinates and reads, and `build upload --file` of the agent's own .app or .apk.
 * Refused: starting or stopping devices (fleetd does), Revyl's AI-driven actions (`--target`), remote builds, tests,
 * workflows, computers, auth, feedback and anything about billing.
 */
export function refusal(argv: string[]): string | undefined {
  const [cmd, sub] = argv;
  if (argv.includes("--")) return "fleetd adds your screen's session to each command, so a revyl command here takes no `--`.";
  const flag = argv.find((a) => OWN_FLAGS.has(a.split("=")[0]!));
  if (flag) {
    if (flag.startsWith("--target") || flag.startsWith("--intent")) {
      return "Revyl's AI-driven actions are off in fleetd: tap, swipe and type by coordinates (--x --y), after a screenshot.";
    }
    return `fleetd sets ${flag.split("=")[0]} itself: your revyl commands always reach your own screen.`;
  }
  if (cmd === "device") {
    if (sub === "start" || sub === "stop" || sub === "list") {
      return "fleetd starts and stops your Revyl screen: session_start gives you one, session_end ends it.";
    }
    if (sub && DEVICE.has(sub)) return undefined;
    return `revyl device ${sub ?? ""} isn't one fleetd runs: use tap, swipe, long-press, type, key, screenshot, info, hierarchy, install, launch, navigate or logs.`.replace("device  ", "device ");
  }
  if (cmd === "build") {
    if (sub === "upload" && argv.includes("--file") && !argv.some((a) => a === "--url" || a.startsWith("--url="))) return undefined;
    return "Revyl's remote builds are off in fleetd: build the app yourself, then revyl build upload --file <your .app or .apk>.";
  }
  if (cmd === "feedback") return "fleetd's agents never send feedback to Revyl: say what went wrong in your result instead.";
  if (cmd === "auth" || cmd === "billing" || cmd === "upgrade" || cmd === "config") {
    return "fleetd holds the team's Revyl key and its billing is the team's own: an agent never changes either.";
  }
  return `revyl ${cmd ?? ""} isn't one fleetd runs: drive your screen with revyl device …, and upload your build with revyl build upload --file.`;
}

/**
 * `output` without the lines in which Revyl's CLI asks an agent to report to Revyl unasked ("Revyl: … revyl feedback
 * --type bug …"): fleetd's agents never send feedback.
 */
export const withoutNudges = (output: string) =>
  output
    .split("\n")
    .filter((l) => !/^Revyl: .*\brevyl feedback\b/.test(l))
    .join("\n");

/** A refusal from Revyl about money or limits (a billing notice, no minutes left): never retried. */
export const billingRefusal = (output: string) => /billing|payment|credit|free minutes|out of minutes|upgrade your plan|402/i.test(output);

/** What fixes a failed check of the key on `machine` that Revyl answered, by its reason (the hub's and fleetd cloud's words). */
export function checkFix(reason: "invalid_key" | "failed", machine: string): string {
  return reason === "invalid_key"
    ? "Revyl refused the key: it may be wrong or expired. Make a new one in Revyl's dashboard (Settings › API Keys) and connect it again."
    : `test again in a minute; if it keeps failing, run revyl doctor on ${machine}`;
}
