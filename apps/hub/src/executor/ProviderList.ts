// The provider instances a machine's T3 runs (its `server.getConfig` provider list), and which instance a launch goes
// to. Every launch goes to the "fleetd" Claude instance, whose launch args deny T3's own spawn tools, except a model
// only a usable Codex instance offers: that runs there, so L-tier reviews can get a Codex reviewer.
import type { Effort, MachineId } from "@fleetd/contracts";
import type { ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ExecutorError } from "./Executors.ts";

export const FLEETD_INSTANCE = "fleetd";
export const CODEX_DRIVER = "codex";

export interface ProviderInstance {
  readonly instanceId: string;
  readonly driver: string;
  /** Enabled, installed, not reported unavailable, in error or logged out. */
  readonly usable: boolean;
  /** Model slugs and their aliases. */
  readonly models: ReadonlyArray<string>;
  readonly defaultModel?: string;
}

export class ProviderList extends Context.Service<
  ProviderList,
  { readonly instances: (machineId: MachineId) => Effect.Effect<ReadonlyArray<ProviderInstance>, ExecutorError> }
>()("fleetd/executor/ProviderList") {}

export const toInstance = (p: ServerProvider): ProviderInstance => {
  const preferred = p.models.find((m) => m.isDefault === true) ?? p.models.find((m) => m.isLegacy !== true);
  return {
    instanceId: p.instanceId,
    driver: p.driver,
    usable:
      p.enabled &&
      p.installed &&
      p.availability !== "unavailable" &&
      p.status !== "error" &&
      p.status !== "disabled" &&
      p.auth.status !== "unauthenticated",
    models: p.models.flatMap((m) => [m.slug, ...(m.aliases ?? [])]),
    ...(preferred === undefined ? {} : { defaultModel: preferred.slug }),
  };
};

/** The first usable Codex instance with a model to run, if the machine has one. */
export const codexInstance = (instances: ReadonlyArray<ProviderInstance>): (ProviderInstance & { readonly defaultModel: string }) | undefined =>
  instances.find((i): i is ProviderInstance & { readonly defaultModel: string } => i.driver === CODEX_DRIVER && i.usable && i.defaultModel !== undefined);

/** Claude models never leave the fleetd instance; a model only a usable Codex instance lists runs on it. */
export const routeModel = (instances: ReadonlyArray<ProviderInstance>, model: string): { readonly instanceId: string; readonly driver: string } => {
  const fleetd = { instanceId: FLEETD_INSTANCE, driver: "claudeAgent" };
  if (instances.some((i) => i.driver !== CODEX_DRIVER && i.models.includes(model))) return fleetd;
  const codex = instances.find((i) => i.driver === CODEX_DRIVER && i.usable && i.models.includes(model));
  return codex === undefined ? fleetd : { instanceId: codex.instanceId, driver: codex.driver };
};

/** T3's effort option for the driver. Codex calls it `reasoningEffort` and its top level `xhigh`. */
export const effortOption = (driver: string, effort: Effort): { readonly id: string; readonly value: string } =>
  driver === CODEX_DRIVER ? { id: "reasoningEffort", value: effort === "max" ? "xhigh" : effort } : { id: "effort", value: effort };
