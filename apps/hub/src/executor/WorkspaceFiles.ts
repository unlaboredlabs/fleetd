// Files in a project's workspace on a machine, read through T3's own file RPC. Provided by Executors.layer next to
// Executors and ThreadWatch.
import type { MachineId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ExecutorError } from "./Executors.ts";

export class WorkspaceFiles extends Context.Service<
  WorkspaceFiles,
  {
    /** Undefined when the file does not exist. `relativePath` is relative to `cwd`, which must be a T3 workspace root. */
    readonly read: (machineId: MachineId, cwd: string, relativePath: string) => Effect.Effect<string | undefined, ExecutorError>;
  }
>()("fleetd/executor/WorkspaceFiles") {}
