// The target every script here had before there were targets: a hub of the build under test, started on a home of
// its own (the factory kit's startHub), one team to a hub. And openTarget, which gives a script the target it was
// asked for: that one, or with `--target <module>` whatever the module makes (README.md).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startHub } from "../lab/factory/kit.ts";
import { arg, has, target as build } from "./lib.ts";
import type { Target } from "./target.ts";

/**
 * A hub of `bin` per team, each on the `dir` its team is made in: its own home, FLEETD_HOME and port, stopped by the
 * PID captured at its start. `teams` is 1, as a self-hosted hub is. 2 is two hubs side by side, which is not a hub
 * keeping two teams apart: neither has heard of the other's ids, so the two-team cases must all pass there, and one
 * that fails is a fault in the cases (`--two-hubs`).
 */
export function hubBuild(name: string, bin: string, teams = 1): Target {
  // The kit starts the hub, and the node that joins it, from FLEETD_BIN.
  process.env.FLEETD_BIN = bin;
  const hubs: Array<Awaited<ReturnType<typeof startHub>>> = [];
  return {
    name,
    teams,
    team: async (dir) => {
      if (hubs.length >= teams) throw new Error(`${name} makes ${teams === 1 ? "one team" : `${teams} teams`}: a hub build is one team`);
      const hub = await startHub(dir);
      hubs.push(hub);
      return hub;
    },
    close: async () => {
      for (const hub of hubs.splice(0).reverse()) await hub.stop();
    },
  };
}

/** What a `--target` module exports by default: given the build under test, the target to run it against. */
export type MakeTarget = (build: { readonly name: string; readonly bin: string }) => Target | Promise<Target>;

/**
 * The target a script runs against, with the build under test (lib.ts's `target()`): its machines and its CLI are that
 * build's whatever the target. `--target <module>` (or COMPARE_TARGET) is a module whose default export is a
 * MakeTarget; without it, a hub of the build. With `--areas` too no machine joins, so the build is optional: `bin` is
 * "" when none is given.
 */
export async function openTarget(): Promise<{ readonly name: string; readonly bin: string; readonly target: Target }> {
  const given = arg("--target", "COMPARE_TARGET");
  const file = given === "" ? undefined : given;
  const binless = file !== undefined && has("--areas") && arg("--bin", "FLEETD_BIN") === undefined;
  const { name, bin } = binless ? { name: arg("--impl", "COMPARE_IMPL", "bun")!, bin: "" } : build();
  if (file === undefined) return { name, bin, target: hubBuild(name, bin, has("--two-hubs") ? 2 : 1) };
  if (bin !== "") process.env.FLEETD_BIN = bin;
  const made = (await import(pathToFileURL(path.resolve(file)).href)) as { default?: MakeTarget };
  if (typeof made.default !== "function") throw new Error(`${file} has no default export: export a function that makes the target`);
  return { name, bin, target: await made.default({ name, bin }) };
}
