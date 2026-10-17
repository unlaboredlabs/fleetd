// What tasks need from slots, leases and the policy file. The slots and leases areas implement these; the hub's
// wiring adapts them. Each answer is immediate: a "no" carries the reason the task shows while it is queued, and
// tasks retry their queue after every release.
import type { AreaName, PolicyFile, ProjectRef, TaskId, TaskKind } from "@fleetd/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { LeadError } from "../leads/LeadError.ts";

export type Grant = { readonly granted: true } | { readonly granted: false; readonly reason: string };

export class SlotPort extends Context.Service<
  SlotPort,
  {
    /** Takes a slot for `holder` if the cap and the project's share allow. Granting a holder that has one is a no-op. */
    readonly acquire: (request: { readonly holder: TaskId; readonly projectRef: ProjectRef; readonly kind: TaskKind }) => Effect.Effect<Grant>;
    /** A no-op for a holder without a slot. */
    readonly release: (holder: TaskId) => Effect.Effect<void>;
    /** Runs `listener` after any slot is released, including lead turns'. It must not wait on the releaser. */
    readonly onRelease: (listener: Effect.Effect<void>) => Effect.Effect<void>;
  }
>()("fleetd/tasks/SlotPort") {}

export class LeasePort extends Context.Service<
  LeasePort,
  {
    /** All of `areas` for `taskId` or none of them. Areas it already holds count as granted. */
    readonly acquire: (request: {
      readonly projectRef: ProjectRef;
      readonly taskId: TaskId;
      readonly areas: ReadonlyArray<AreaName>;
    }) => Effect.Effect<Grant>;
    /** Every lease `taskId` holds. */
    readonly release: (taskId: TaskId) => Effect.Effect<void>;
  }
>()("fleetd/tasks/LeasePort") {}

export class PolicyPort extends Context.Service<
  PolicyPort,
  {
    /** The project's `.fleetd/policy.yaml`, or DEFAULT_POLICY when it has none. */
    readonly get: (ref: ProjectRef) => Effect.Effect<PolicyFile, LeadError>;
  }
>()("fleetd/tasks/PolicyPort") {}
