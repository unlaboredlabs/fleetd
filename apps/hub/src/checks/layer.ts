import * as Layer from "effect/Layer";
import * as CheckRunner from "./CheckRunner.ts";
import * as ClaimRecords from "./ClaimRecords.ts";
import * as Claims from "./Claims.ts";
import * as GitHub from "./GitHub.ts";
import * as Judges from "./Judges.ts";

/**
 * Claims with the check runner, judges and GitHub through `gh`. NodeCommands is left to the caller, because the node
 * link needs the same instance. Needs NodeCommands, Tasks, Asks, EventLog, HubStore, HubDb, LeadRecords, LeadWakes,
 * EstimatesPort and IncidentsPort.
 */
export const layer = (options: { readonly gh?: GitHub.GhRunner; readonly claims?: Claims.ClaimsOptions } = {}) =>
  Claims.layer(options.claims).pipe(
    Layer.provideMerge(CheckRunner.layer),
    Layer.provideMerge(Layer.mergeAll(Judges.layer, GitHub.layer(options.gh), ClaimRecords.layer)),
  );
