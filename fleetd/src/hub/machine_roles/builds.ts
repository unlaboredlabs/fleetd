// A PR's build for a person's screen (crates/fleetd/src/hub/machine_roles/builds.rs): the newest of the PR head's CI
// runs that uploaded an artifact named for the kind (an Android build: "android" or "apk" in its name), downloaded with
// the hub's `gh`, the one file it holds (an .apk), at most FILE_MAX. And the hub's own sealed device steps that send
// it to the screen's machine and install it there (node/device/remote.rs `seal_call`, `open_done`): each under a key of
// its own per way, from the relay key the hub sealed into the screen's start, its nonce its count.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionKind } from "../../shared/contracts.ts";
import { secretbox, secretboxOpen } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { AppGh } from "../github_app/gh.ts";
import { githubApps } from "../github_app/index.ts";
import type { GhRunner } from "../train/gh.ts";

/** The head's runs looked through. */
const RUNS = 10;
/** The most a screen takes of a file (node/device/remote.rs `FILE_MAX`). */
export const FILE_MAX = 64 << 20;
/** A device step's piece (remote.rs `PIECE`). */
export const PIECE = 4 << 20;

export type Found = { runId: number; artifact: string; sha: string };
export type Build = { name: string; bytes: Uint8Array };

export const noun = (kind: SessionKind) => (kind === "ios" ? "iOS simulator build" : "Android build");

function namedFor(name: string, kind: SessionKind): boolean {
  const n = name.toLowerCase();
  if (kind === "ios") return n.includes("ios");
  if (kind === "android") return n.includes("android") || n.includes("apk");
  return false;
}

/** The build file in a downloaded artifact: the first by path, links not followed. */
function theFile(dir: string, kind: SessionKind): string | undefined {
  const suffix = kind === "ios" ? ".zip" : ".apk";
  const found: string[] = [];
  const dirs = [dir];
  while (dirs.length > 0) {
    const next = dirs.pop()!;
    for (const name of readdirSync(next)) {
      const path = join(next, name);
      const meta = lstatSync(path);
      if (meta.isDirectory()) dirs.push(path);
      else if (meta.isFile() && name.toLowerCase().endsWith(suffix)) found.push(path);
    }
  }
  return found.sort()[0];
}

const clip = (s: string, max: number) => ([...s].length <= max ? s : `${[...s].slice(0, max - 1).join("")}…`);

export class Builds {
  constructor(
    public gh: GhRunner,
    private readonly dir: string,
  ) {}

  private async run(args: string[]): Promise<string> {
    let out;
    try {
      out = await this.gh.run(args);
    } catch (e) {
      const why = (e as Error).message;
      throw new Error(why === "ENOENT" ? "the GitHub CLI (gh) isn't installed on the hub's machine" : why);
    }
    if (out.exitCode !== 0) {
      const said = out.stderr.trim();
      throw new Error(said === "" ? `gh exited with ${out.exitCode}` : clip(said, 300));
    }
    return out.stdout;
  }

  private async json<T>(path: string): Promise<T> {
    const out = await this.run(["api", path]);
    try {
      return JSON.parse(out) as T;
    } catch (e) {
      throw new Error(`GitHub answered something else: ${(e as Error).message}`);
    }
  }

  /** PR `number` of `repo`'s build for a `kind` screen, or why there is none, in plain words. */
  async find(repo: string, number: number, kind: SessionKind): Promise<Found> {
    const what = noun(kind);
    const read = async <T>(path: string, what: string) => {
      try {
        return await this.json<T>(path);
      } catch (e) {
        throw new Error(`${what}: ${(e as Error).message}.`);
      }
    };
    const pull = await read<{ head: { sha: string } }>(`repos/${repo}/pulls/${number}`, `PR #${number} of ${repo} couldn't be read`);
    const sha = pull.head.sha;
    const short = sha.slice(0, 7);
    const runs = await read<{ workflow_runs?: { id: number; status?: string }[] }>(
      `repos/${repo}/actions/runs?head_sha=${sha}&per_page=${RUNS}`,
      `PR #${number}'s CI runs couldn't be read`,
    );
    const all = (runs.workflow_runs ?? []).slice(0, RUNS);
    let running = false;
    let expired = false;
    for (const run of all) {
      if ((run.status ?? "") !== "completed") running = true;
      const listed = await read<{ artifacts?: { name: string; expired?: boolean }[] }>(
        `repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`,
        `PR #${number}'s CI artifacts couldn't be read`,
      );
      for (const a of (listed.artifacts ?? []).filter((a) => namedFor(a.name, kind))) {
        if (a.expired) {
          expired = true;
          continue;
        }
        return { runId: run.id, artifact: a.name, sha };
      }
    }
    if (running) throw new Error(`PR #${number}'s CI is still running on its head (${short}): its ${what} isn't there yet. Try again once it's done.`);
    if (expired) {
      throw new Error(`PR #${number}'s ${what} has expired: GitHub keeps CI artifacts only so long. Re-run its CI, or push to it, to build it again.`);
    }
    if (all.length === 0) throw new Error(`PR #${number}'s head (${short}) has no CI runs, so no ${what}.`);
    throw new Error(
      `PR #${number}'s head (${short}) has no ${what}: none of its CI runs uploaded an artifact named for ${
        kind === "ios" ? "iOS (a zipped simulator .app)" : "Android (an .apk)"
      }.`,
    );
  }

  /** Downloads the build `find` found, into the hub's own folder, and reads its file. */
  async fetch(repo: string, number: number, kind: SessionKind, found: Found): Promise<Build> {
    const what = noun(kind);
    const ext = kind === "ios" ? "zip" : "apk";
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      throw new Error(`the hub can't keep downloads: ${(e as Error).message}`);
    }
    const tmp = mkdtempSync(join(this.dir, "pr-"));
    try {
      try {
        await this.run(["run", "download", String(found.runId), "-n", found.artifact, "-D", tmp, "-R", repo]);
      } catch (e) {
        throw new Error(`PR #${number}'s ${what} didn't download: ${(e as Error).message}.`);
      }
      const file = theFile(tmp, kind);
      if (!file) throw new Error(`PR #${number}'s artifact ${found.artifact} holds no .${ext} file.`);
      const size = existsSync(file) ? statSync(file).size : 0;
      if (size > FILE_MAX) {
        throw new Error(`PR #${number}'s ${what} is ${size >> 20} MiB, more than the ${FILE_MAX >> 20} MiB a screen takes.`);
      }
      return { name: `pr-${number}.${ext}`, bytes: readFileSync(file) };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/**
 * The hub's builds (`<home>/builds`), read with the App-aware `gh` as the prs area's are (serve/mod.rs gives Builds
 * the AppGh): a repo the GitHub App reaches is read as the App, the machine's own login otherwise.
 */
export const builds = (hub: Hub) =>
  hub.area("machine_roles.builds", (h) => new Builds(new AppGh(githubApps(h)), join(h.config.home, "builds")));

// ---- the hub's own sealed device steps (remote.rs) ----

type Way = "call" | "answer";

function wayKey(relayKey: Uint8Array, way: Way): Uint8Array {
  const label = way === "call" ? "fleetd device 1: agent to runner" : "fleetd device 1: runner to agent";
  return new Uint8Array(new Bun.CryptoHasher("sha256").update(label).update(relayKey).digest());
}

function nonce(count: number): Uint8Array {
  const out = new Uint8Array(24);
  new DataView(out.buffer).setBigUint64(0, BigInt(count), true);
  return out;
}

/** A device step, sealed with the screen's relay key under its count: `{ step: "sealed", count, dataB64 }`. */
export function sealCall(relayKey: Uint8Array, count: number, call: Record<string, unknown>): Record<string, unknown> {
  const sealed = secretbox(wayKey(relayKey, "call"), nonce(count), new TextEncoder().encode(JSON.stringify(call)));
  return { step: "sealed", count, dataB64: Buffer.from(sealed).toString("base64") };
}

/** The screen's machine's answer to step `count`, opened; undefined for one that doesn't open with the key. */
export function openDone(relayKey: Uint8Array, count: number, done: Record<string, unknown>): Record<string, unknown> | undefined {
  if (done.step !== "sealed" || typeof done.dataB64 !== "string") return undefined;
  const plain = secretboxOpen(wayKey(relayKey, "answer"), nonce(count), Buffer.from(done.dataB64, "base64"));
  if (!plain) return undefined;
  try {
    const opened = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
    return opened.step === "sealed" ? undefined : opened;
  } catch {
    return undefined;
  }
}
