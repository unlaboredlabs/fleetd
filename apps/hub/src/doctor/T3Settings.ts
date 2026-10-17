// A machine's T3 server settings, read and written over T3's own RPC (`server.getSettings` / `server.updateSettings`)
// with the hub's node-minted session. T3 redacts secret values when it reads them out and keeps the stored value when
// a redacted one is written back, so re-applying an instance read this way never loses its credentials.
import type { MachineId } from "@fleetd/contracts";
import type { ProviderInstanceMutation, ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ExecutorError } from "../executor/Executors.ts";

export interface SettingsUpdate {
  readonly patch: ServerSettingsPatch;
  readonly providerInstanceMutation?: ProviderInstanceMutation;
}

export class T3Settings extends Context.Service<
  T3Settings,
  {
    readonly read: (machineId: MachineId) => Effect.Effect<ServerSettings, ExecutorError>;
    readonly update: (machineId: MachineId, update: SettingsUpdate) => Effect.Effect<ServerSettings, ExecutorError>;
  }
>()("fleetd/doctor/T3Settings") {}
