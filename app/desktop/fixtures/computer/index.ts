// A bot's Computer (Settings › Bots › Bot, W705), on the typical hub's first bot, made storefront with one repo of its
// own: its setup commands and the image they build, one fixture a state. computer-ready: built 3 h ago, 1.1 GB.
// computer-building: a rebuild running while the one before still serves. computer-failed: a build that failed at
// `cargo fetch`, its log's end behind Log, the older image still serving. computer-new: commands saved, not built yet.
// computer-nowhere: its machine builds no images (a self-hosted hub's), so only its setup shows.
// computer-two: storefront and its api repo, each its own Computer, api's with no commands and so no image.
// computer-runs-on: Runs on picked as fleetd's computers · 4 vCPU / 8 GB, among fleetd's computers' sizes.
// computer-runs-on-gone: Runs on picked as fleetd's computers · 8 vCPU / 16 GB, then fleetd's computers disconnected: the row says its agents
// wait.
import { Fixture } from "../kit/fixture.ts";
import { at } from "../kit/ids.ts";
import { defineGroup } from "../kit/group.ts";
import { arr } from "../kit/stress.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { projectSections } from "../kit/sections.ts";

const HOUR = 3_600_000;

const COMMANDS = ["curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal", "pnpm install --frozen-lockfile", "cargo fetch"];
const INPUTS = ["pnpm-lock.yaml", "Cargo.lock", "rust-toolchain.toml"];

const LOG = [
  "$ curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal",
  "info: downloading installer",
  "info: profile set to 'minimal'",
  "info: default toolchain set to 'stable-x86_64-unknown-linux-gnu'",
  "  stable-x86_64-unknown-linux-gnu installed - rustc 1.91.0 (f8297e351 2026-10-28)",
  "$ pnpm install --frozen-lockfile",
  "Lockfile is up to date, resolution step is skipped",
  "Packages: +412",
  "Done in 6.2s",
  "$ cargo fetch",
  "    Updating crates.io index",
  "error: failed to get `tokio` as a dependency of package `storefront-api v0.4.0 (/work/storefront/api)`",
  "Caused by:",
  "  failed to load source for dependency `tokio`",
  "Caused by:",
  "  Unable to update registry `crates-io`",
  "Caused by:",
  "  failed to fetch `https://index.crates.io/`",
  "Caused by:",
  "  [6] Couldn't resolve host name (Could not resolve host: index.crates.io)",
  "cargo fetch exited with 101",
].join("\n");

type Ref = { machineId: string; projectId: string };

/** Makes the first bot storefront, with its own repo (and `api` beside it, with `two`), and returns its ref. */
const storefront = (f: Fixture, two = false): Ref => {
  const first = arr(f.snapshot?.["projects"]).filter(isObject)[0];
  if (first === undefined) throw new Error("computer fixtures: the base has no bot");
  const ref = { machineId: asText(first["machineId"]), projectId: asText(first["projectId"]) };
  first["title"] = "storefront";
  const own: JsonObject = { repoId: "R801", name: "storefront", checkout: ref, base: "main", repoKey: "acme/storefront", path: "/home/dev/src/storefront" };
  const api: JsonObject = {
    repoId: "R802",
    name: "api",
    checkout: { machineId: ref.machineId, projectId: "api" },
    base: "main",
    repoKey: "acme/storefront-api",
    path: "/home/dev/src/storefront-api",
  };
  first["repos"] = two ? [own, api] : [own];
  projectSections(f, ref);
  f.answer("mcp_servers_get", undefined, { global: [], project: [] });
  return ref;
};

const settings = (ref: Ref, image: JsonObject, extra: JsonObject = {}): JsonObject => ({
  settings: {
    ...ref,
    title: "storefront",
    workspaceRoot: "/home/dev/src/storefront",
    env: [],
    setup: { commands: COMMANDS, inputs: INPUTS },
    worktrees: { dir: `/home/dev/.fleetd/node/worktrees/${ref.projectId}`, baseBranch: "main", worktrees: [] },
    image,
    ...extra,
  },
});

const state = (base: Fixture, name: string, about: string, image: (now: string) => JsonObject): Fixture => {
  const f = Fixture.from(base, name, about);
  const ref = storefront(f);
  f.answer("project_settings_get", ref, settings(ref, image(f.now)));
  f.answer("project_image_rebuild", undefined, { image: { ...image(f.now), state: "building", startedAt: at(f.now, 0) } });
  return f;
};

const BUILT = (now: string): JsonObject => ({ builtAt: at(now, -3 * HOUR), bytes: 1_181_116_006, where: "boat" });

/** Choices as the hub words them (shared/sandbox.ts computerChoices). */
const sized = (kind: string, name: string, sizes: [number, number][]): JsonObject[] =>
  sizes.map(([cpu, memGb]) => ({ kind, cpu, memGb, label: `${name} · ${String(cpu)} vCPU / ${String(memGb)} GB` }));

/** storefront ready, with `computer` picked among `computers` (none: Automatic). */
const runsOn = (base: Fixture, name: string, about: string, computer: JsonObject | undefined, computers: JsonObject[]): Fixture => {
  const f = Fixture.from(base, name, about);
  const ref = storefront(f);
  const extra = { ...(computer ? { computer } : {}), computers };
  f.answer("project_settings_get", ref, settings(ref, { state: "ready", ...BUILT(f.now) }, extra));
  f.answer("project_settings_set", undefined, settings(ref, { state: "ready", ...BUILT(f.now) }, extra));
  return f;
};

export default defineGroup({
  fixtures: (base) => [
    state(base("typical"), "computer-ready", "A bot's Computer: its image built 3 h ago, 1.1 GB, with Rebuild.", (now) => ({ state: "ready", ...BUILT(now) })),
    state(base("typical"), "computer-building", "A bot's Computer: a rebuild running while the image before it serves.", (now) => ({
      state: "building",
      startedAt: at(now, -2 * 60_000),
      ...BUILT(now),
    })),
    state(base("typical"), "computer-failed", "A bot's Computer: a build failed at cargo fetch, its log behind Log; the older image serves.", (now) => ({
      state: "failed",
      failedAt: at(now, -12 * 60_000),
      log: LOG,
      ...BUILT(now),
    })),
    state(base("typical"), "computer-new", "A bot's Computer: commands saved, its image not built yet.", () => ({ state: "none", where: "boat" })),
    // A machine that can't build one (a self-hosted hub's): none, kept nowhere.
    state(base("typical"), "computer-nowhere", "A bot's Computer on a machine that builds no images: its setup alone, no image row.", () => ({ state: "none" })),
    runsOn(base("typical"), "computer-runs-on", "A bot's Computer: Runs on is fleetd's computers · 4 vCPU / 8 GB, one pick of provider and size.", { kind: "boat", cpu: 4, memGb: 8 }, sized("boat", "fleetd's computers", [[2, 4], [4, 8], [8, 16], [16, 32]])),
    runsOn(base("typical"), "computer-runs-on-gone", "A bot's Computer: its pick's provider was disconnected, so its agents wait and the row says why.", { kind: "boat", cpu: 8, memGb: 16 }, [
      { kind: "boat", cpu: 8, memGb: 16, label: "fleetd's computers · 8 vCPU / 16 GB", unavailable: "fleetd's computers aren't connected: an admin connects them in Settings › Hub › Machines" },
    ]),
    (() => {
      const f = Fixture.from(base("typical"), "computer-two", "A bot with two repos: each its own Computer; api has no commands, so no image.");
      const ref = storefront(f, true);
      f.answer("project_settings_get", ref, settings(ref, { state: "ready", ...BUILT(f.now) }));
      f.answer("project_settings_get", { ...ref, repo: "api" }, settings(ref, { state: "none" }, { repo: "api", setup: { commands: [], inputs: [] } }));
      return f;
    })(),
  ],
});
