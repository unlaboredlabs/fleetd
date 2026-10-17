import * as Layer from "effect/Layer";
import * as CheckRunner from "./CheckRunner.ts";
import * as Claims from "./Claims.ts";
import * as GitHub from "./GitHub.ts";
import * as Judges from "./Judges.ts";

/**
 * Claims with the check runner, judges and GitHub through `gh`. Left to the caller: NodeCommands, because the node
 * link needs the same instance, and JudgeVerdicts, because the value bar's JudgeHook (`Judges.layerJudgeHook`) sits on
 * it below Tasks. Needs NodeCommands, JudgeVerdicts, Tasks, Asks, EventLog, HubStore, HubDb, LeadRecords, LeadWakes,
 * ClaimRecords, Estimates and Incidents (the last three come with the leads layer).
 */
export const layer = (options: { readonly gh?: GitHub.GhRunner; readonly claims?: Claims.ClaimsOptions } = {}) =>
  Claims.layer(options.claims).pipe(
    Layer.provideMerge(CheckRunner.layer),
    Layer.provideMerge(Layer.merge(Judges.layer, GitHub.layer(options.gh))),
  );
