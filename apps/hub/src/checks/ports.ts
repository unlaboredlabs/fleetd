// What the claim flow hands to estimates and incidents (M6b implements both). The no-op layers are for tests and
// for a hub built before those land.
import type { Incident, WorkstreamId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class EstimatesPort extends Context.Service<
  EstimatesPort,
  {
    /** Called once the workstream is stored as `done`: record its actual minutes against the estimate. */
    readonly recordDone: (workstreamId: WorkstreamId) => Effect.Effect<void>;
  }
>()("fleetd/checks/EstimatesPort") {}

export type IncidentInput = Omit<Incident, "incidentId" | "at">;

export class IncidentsPort extends Context.Service<
  IncidentsPort,
  { readonly record: (incident: IncidentInput) => Effect.Effect<void> }
>()("fleetd/checks/IncidentsPort") {}

export const layerEstimatesNoop = Layer.succeed(EstimatesPort, EstimatesPort.of({ recordDone: () => Effect.void }));
export const layerIncidentsNoop = Layer.succeed(IncidentsPort, IncidentsPort.of({ record: () => Effect.void }));
