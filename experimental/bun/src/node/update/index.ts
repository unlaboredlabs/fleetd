// `node_action` `update` (crates/fleetd/src/node/update.rs): the node updates itself to the build its hub names, with
// the CLI's own pieces (src/update): a download checked against the release's SHA256SUMS, the previous binary kept,
// and the watcher that restarts the node's service and puts the previous binary back if the new one doesn't come up.
// It answers before the restart; the hub sees the outcome in the version the node reconnects with, or, when the
// service manager refuses the restart, in a second answer the node still running sends (notRestarted).
//
// `fetch` comes first, while the hub fetches its own build: the node downloads the build its hub is about to run and
// keeps it, checked again against the release's sums before it is installed.
//
// The update names the hub's flavour too: a node on the other one switches to it, as `fleetd update --flavour` does, at
// the same path (docs/cutover/bun.md). The hub's flavour is the target either way, so a hub rolled back to Rust brings
// its nodes back too.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { UpdateStage } from "../../shared/contracts.ts";
import { VERSION } from "../../shared/version.ts";
import { HEALTH_WAIT_SECS, readVerdict, start as startWatcher, upPath, type Plan } from "../../update/finish.ts";
import {
  assetOf,
  baseUrl,
  checkedTo,
  cliAsset,
  Failure,
  FLAVOUR,
  HttpFeed,
  installedExe,
  isBuild,
  release,
  replaceFile,
  restore,
  runningBinary,
  sums,
  swap,
  updateHelper,
  type Feed,
  type Flavour,
} from "../../update/index.ts";
import { isHubService, services, type Service } from "../../update/service.ts";
import { versionLabel } from "../../update/version.ts";

/** Where this node's binary and service are, and what it runs: the real ones, or a test's. `asset` is its flavour's. */
export type Place = { home: string; exe: string; services: Service[]; running: string; releaseBuild: boolean; flavour: Flavour; asset: string };

export function placeHere(home: string): Place {
  let exe: string;
  try {
    exe = installedExe();
  } catch (error) {
    throw new Failure("install", `couldn't find this node's binary: ${(error as Error).message}`);
  }
  let asset: string;
  try {
    asset = cliAsset();
  } catch (error) {
    throw new Failure("download", (error as Error).message);
  }
  return { home, exe, services: services(exe), running: VERSION, releaseBuild: VERSION !== "0.0.0", flavour: FLAVOUR, asset };
}

/** What `update` installs: its flavour (this node's own when it names none, as from an older hub) and that flavour's
 * asset. */
function target(update: NodeUpdate, p: Place): { flavour: Flavour; asset: string } {
  const flavour = update.flavour ?? p.flavour;
  if (flavour !== "rust" && flavour !== "bun") throw new Failure("download", "the hub asked for a flavour of fleetd this one doesn't know");
  if (flavour === p.flavour) return { flavour, asset: p.asset };
  try {
    return { flavour, asset: assetOf(flavour) };
  } catch (error) {
    throw new Failure("download", (error as Error).message);
  }
}

/** The node runs what `update` names: its version, and its flavour. */
const runs = (update: NodeUpdate, p: Place, flavour: Flavour) => update.version === p.running && flavour === p.flavour;

const dir = (p: Place) => join(p.home, "update");
export const planPath = (p: Place) => join(dir(p), "node-plan.json");
/** The build `fetch` kept for the update that follows. */
const fetched = (p: Place) => join(dir(p), "fleetd.next");
/** The SHA256SUMS of the build `fetch` was asked for, read while the channel still offered it. */
const keptSumsPath = (p: Place) => join(dir(p), "fleetd.next.sums.json");

function keepSums(p: Place, to: string, s: Map<string, string>): void {
  try {
    mkdirSync(dir(p), { recursive: true });
    replaceFile(keptSumsPath(p), JSON.stringify({ version: to, sums: Object.fromEntries(s) }));
  } catch (error) {
    throw new Failure("download", `couldn't keep the release's checksums: ${(error as Error).message}`);
  }
}

function keptSums(p: Place, to: string): Map<string, string> | undefined {
  try {
    const kept = JSON.parse(readFileSync(keptSumsPath(p), "utf8")) as { version: string; sums: Record<string, string> };
    return kept.version === to ? new Map(Object.entries(kept.sums)) : undefined;
  } catch {
    return undefined;
  }
}

/** Held while a fetch downloads: the update waits for it rather than downloading the same build alongside. */
let fetching: Promise<unknown> = Promise.resolve();
const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = fetching.catch(() => {}).then(fn);
  fetching = run;
  return run;
};

/** The channel's newest build and its sums, read together; a newest build other than `to` is refused. */
async function releaseOf(to: string, feed: Feed): Promise<Map<string, string>> {
  const [r, s] = await Promise.all([release(feed), sums(feed)]);
  if (r.cliVersion !== to)
    throw new Failure(
      "download",
      `the channel's newest build is now ${r.cliVersion ? versionLabel(r.cliVersion) : "none"}, not the hub's ${versionLabel(to)}: update again`,
    );
  return s;
}

export type NodeUpdate = { version: string; channel: string; flavour?: string };

/** Downloads `update.version` ahead of the update, checked, and keeps it beside the node's binary with the sums. */
export function fetch(update: NodeUpdate, p: Place, feed: Feed): Promise<void> {
  return exclusive(async () => {
    const to = update.version;
    const { flavour, asset } = target(update, p);
    // Nothing the update that follows could install.
    if (runs(update, p, flavour) || !p.releaseBuild || !p.services.some((s) => !isHubService(s))) return;
    const s = await releaseOf(to, feed);
    keepSums(p, to, s);
    // This binary is the hub's too, which the hub puts in place itself.
    if (p.services.some(isHubService) || isBuild(p.exe, s, asset) || isBuild(fetched(p), s, asset)) return;
    await checkedTo(feed, s, asset, fetched(p));
  });
}

export type Staged = { kind: "current" } | { kind: "restarting"; plan: Plan };

/** Puts `update.version` in place, checked, keeping `previous` (the running binary) for a rollback. */
export function stage(update: NodeUpdate, p: Place, feed: Feed, previous: () => Uint8Array): Promise<Staged> {
  const to = update.version;
  let flavour: Flavour;
  let asset: string;
  try {
    ({ flavour, asset } = target(update, p));
  } catch (error) {
    return Promise.reject(error);
  }
  if (runs(update, p, flavour)) return Promise.resolve({ kind: "current" });
  const service = p.services.find((s) => !isHubService(s));
  if (!service)
    return Promise.reject(
      new Failure(
        "restart",
        "this node doesn't run as the service `fleetd machine add` sets up, so it can't restart itself: run `fleetd update` on this machine",
      ),
    );
  if (!p.releaseBuild)
    return Promise.reject(new Failure("install", "this node runs a local build of fleetd: install a release with curl -fsSL https://fleetd.sh | sh"));
  // A fetch still downloading this build finishes first.
  return exclusive(async () => {
    const kept = keptSums(p, to);
    const s = kept && (isBuild(p.exe, kept, asset) || isBuild(fetched(p), kept, asset)) ? kept : await releaseOf(to, feed);
    // A switch the release has no build for is refused for good, not tried again.
    if (flavour !== p.flavour && !s.has(asset)) throw new Failure("install", `the release has no ${flavour} build for this machine (${asset}), so it stays on ${p.flavour}`);
    // On the hub's machine the hub's update already put this build at the shared path.
    const inPlace = isBuild(p.exe, s, asset);
    const prev = join(dir(p), "fleetd.prev");
    let running: Uint8Array;
    try {
      running = previous();
    } catch (error) {
      throw new Failure("install", `couldn't keep the running binary for a rollback: ${(error as Error).message}; nothing was changed`);
    }
    if (inPlace) {
      try {
        mkdirSync(dir(p), { recursive: true });
        replaceFile(prev, running);
      } catch (error) {
        throw new Failure("install", `couldn't keep the running binary for a rollback: ${(error as Error).message}; nothing was changed`);
      }
    } else {
      if (!isBuild(fetched(p), s, asset)) await checkedTo(feed, s, asset, fetched(p));
      // Staying on Bun: its session host moves with it. Back to Rust: the Rust build needs none, and the one beside it
      // stays as it is.
      if (flavour === "bun") await updateHelper(feed, s, p.exe, prev);
      swap(p.exe, fetched(p), running, prev);
    }
    rmSync(fetched(p), { force: true });
    rmSync(keptSumsPath(p), { force: true });
    return {
      kind: "restarting",
      plan: {
        exe: p.exe,
        prev,
        service,
        from: p.running,
        to,
        health: { kind: "node", up: upPath(p.home) },
        waitSecs: HEALTH_WAIT_SECS,
        verdict: join(dir(p), "node-verdict.json"),
        answered: join(dir(p), "node-answered"),
      },
    };
  });
}

/** The files the node and the watcher of its restart share. */
export type Watch = { answered: string; verdict: string };

function feedOf(update: NodeUpdate): Feed {
  // Edge goes out as `nightly`, its name before D203.
  const channel = update.channel === "nightly" || update.channel === "edge" ? "edge" : update.channel === "stable" ? "stable" : undefined;
  if (!channel) throw new Failure("download", "the hub asked for a channel this fleetd doesn't know");
  return new HttpFeed(baseUrl(channel));
}

/** The `fetch` node action, after the node answered it: a failure only means the update downloads the build itself. */
export async function runFetch(update: NodeUpdate, home: string): Promise<void> {
  try {
    await fetch(update, placeHere(home), feedOf(update));
  } catch (error) {
    console.warn(`${new Date().toISOString()} WARN update: fetching ${update.version} ahead failed: ${(error as Error).message}`);
  }
}

/** The node action: stage the update, then start the watcher that restarts this node. */
export async function run(update: NodeUpdate, home: string, opts: { place?: Place; feed?: Feed; previous?: () => Uint8Array; startWatcher?: (plan: Plan, path: string) => void } = {}): Promise<{ message: string; watch?: Watch }> {
  const p = opts.place ?? placeHere(home);
  const staged = await stage(update, p, opts.feed ?? feedOf(update), opts.previous ?? runningBinary);
  if (staged.kind === "current") return { message: `already runs ${versionLabel(update.version)}` };
  const flavour = update.flavour ?? p.flavour;
  const switched = flavour === p.flavour ? "" : ` (${flavour}, from ${p.flavour})`;
  const { plan } = staged;
  try {
    (opts.startWatcher ?? startWatcher)(plan, planPath(p));
  } catch (error) {
    try {
      restore(plan.exe, plan.prev);
    } catch {}
    throw new Failure("restart", `couldn't start the restart (${(error as Error).message}), so the previous binary was put back`);
  }
  return { message: `restarting on ${versionLabel(plan.to)}${switched}`, ...(plan.answered ? { watch: { answered: plan.answered, verdict: plan.verdict } } : {}) };
}

/** After the node answered "restarting": the watcher's verdict, if this process lives to read it. A restart that
 * happened ends this process first, so a verdict read here means the service manager refused the restart. */
export async function notRestarted(verdict: string, waitMs: number): Promise<Failure | undefined> {
  const end = Date.now() + waitMs;
  for (;;) {
    const v = existsSync(verdict) ? readVerdict(verdict) : undefined;
    if (v && v.state !== "done") return new Failure((v.stage ?? "restart") as UpdateStage, v.message);
    if (Date.now() >= end) return undefined;
    await Bun.sleep(200);
  }
}
