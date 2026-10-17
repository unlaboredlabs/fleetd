import { Effect, Schema } from "effect";
import {
  AskBlocks,
  AskId,
  AskKind,
  AskOptions,
  AskState,
  AskSteps,
  AskText,
  askKindRule,
  Brief,
  BriefHash,
  Decision,
  DecisionId,
  DecisionKey,
  DecisionValue,
  DecisionWhy,
  Headline,
  WorkstreamId,
  WorkstreamState,
} from "./ledger.ts";
import { McpToolError } from "./mcp.ts";

// Lead-side `fleetd` CLI calls. The CLI connects to the local node's unix socket, writes one LeadCallFrame as a
// line of JSON, reads one LeadResultFrame line back, and closes. The node forwards the frame over its link to the
// hub under a node-chosen id and relays the answer. The hub attributes the call to `lead:<projectRef>` by matching
// `cwd` against project workspace roots and refuses calls from outside every workspace.

/** Under the node user's home directory; mode 0600. */
export const NODE_SOCKET_PATH = ".fleetd/node/node.sock";

/** `fleetd brief create --workstream W12 --json '<Brief>'`. Freezes the brief and moves a draft to running. */
export const BriefCreateCall = Schema.Struct({
  op: Schema.tag("brief_create"),
  workstreamId: WorkstreamId,
  brief: Brief,
  /** `--amend`: the human-answered ask that approved changing an already frozen brief. */
  amend: Schema.optionalKey(AskId),
});

/** `fleetd ask --key k --class c --text t --rec r [--options a,b] [--blocks "step"] [--proceeded] [--workstream W12]`. */
export const AskCall = Schema.Struct({
  op: Schema.tag("ask"),
  kind: AskKind.pipe(Schema.withDecodingDefaultKey(Effect.succeed("decide" as const))),
  key: DecisionKey,
  /** Any string: the hub refuses classes outside AskClass with the "decide this yourself" fix text. */
  class: Schema.NonEmptyString,
  text: AskText,
  recommendation: Schema.optionalKey(DecisionValue),
  options: Schema.optionalKey(AskOptions),
  steps: Schema.optionalKey(AskSteps),
  blocks: AskBlocks.pipe(Schema.withDecodingDefaultKey(Effect.succeed("nothing" as const))),
  proceededOnRec: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  workstreamId: Schema.optionalKey(WorkstreamId),
}).check(askKindRule);

/** `fleetd ask withdraw A7 [--use D3]`. */
export const AskWithdrawCall = Schema.Struct({
  op: Schema.tag("ask_withdraw"),
  askId: AskId,
  /** The existing decision that answers it. */
  use: Schema.optionalKey(DecisionId),
});

/** `fleetd decide --key k --value v [--why w] [--scope project|workstream] [--workstream W12]`. Writes source "lead". */
export const DecideCall = Schema.Struct({
  op: Schema.tag("decide"),
  key: DecisionKey,
  value: DecisionValue,
  why: Schema.optionalKey(DecisionWhy),
  scope: Schema.Literals(["project", "workstream"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("workstream" as const))),
  workstreamId: Schema.optionalKey(WorkstreamId),
});

/** `fleetd status set "<one line>" [--workstream W12]`. */
export const StatusSetCall = Schema.Struct({
  op: Schema.tag("status_set"),
  text: Headline.check(Schema.isMinLength(1)),
  workstreamId: Schema.optionalKey(WorkstreamId),
});

/** `fleetd decisions search "<q>"`, within the calling project's scope chain. */
export const DecisionsSearchCall = Schema.Struct({
  op: Schema.tag("decisions_search"),
  query: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
});

export const LeadCall = Schema.Union([BriefCreateCall, AskCall, AskWithdrawCall, DecideCall, StatusSetCall, DecisionsSearchCall])
  .pipe(Schema.toTaggedUnion("op"))
  .annotate({ identifier: "LeadCall" });
export type LeadCall = typeof LeadCall.Type;

/** Hint for the lead's next step; the CLI prints it after the result. */
const next = { next: Schema.optionalKey(Schema.String) };

export const BriefCreateResult = Schema.Struct({
  op: Schema.tag("brief_create"),
  workstreamId: WorkstreamId,
  briefHash: BriefHash,
  state: WorkstreamState,
  ...next,
});

export const AskResult = Schema.Struct({
  op: Schema.tag("ask"),
  /** "auto": answered from the log, see `decision`. "open": a new ask, or an existing one with the same key (`attached`). */
  state: AskState,
  askId: AskId,
  decision: Schema.optionalKey(Decision),
  attached: Schema.optionalKey(Schema.Boolean),
  /** Decisions that may already answer it; withdraw with `--use` if one does. */
  candidates: Schema.optionalKey(Schema.Array(Decision).check(Schema.isMaxLength(5))),
  ...next,
});

export const AskWithdrawResult = Schema.Struct({ op: Schema.tag("ask_withdraw"), askId: AskId, state: AskState, ...next });

export const DecideResult = Schema.Struct({ op: Schema.tag("decide"), decision: Decision, ...next });

export const StatusSetResult = Schema.Struct({ op: Schema.tag("status_set"), workstreamId: WorkstreamId, ...next });

export const DecisionsSearchResult = Schema.Struct({
  op: Schema.tag("decisions_search"),
  decisions: Schema.Array(Decision).check(Schema.isMaxLength(20)),
  ...next,
});

export const LeadCallResult = Schema.Union([
  BriefCreateResult,
  AskResult,
  AskWithdrawResult,
  DecideResult,
  StatusSetResult,
  DecisionsSearchResult,
])
  .pipe(Schema.toTaggedUnion("op"))
  .annotate({ identifier: "LeadCallResult" });
export type LeadCallResult = typeof LeadCallResult.Type;

const CallId = Schema.NonEmptyString;

/** CLI -> node on the local socket, and node -> hub on the link. */
export const LeadCallFrame = Schema.Struct({
  t: Schema.tag("lead_call"),
  id: CallId,
  /** The caller's absolute working directory. */
  cwd: Schema.String.check(Schema.isPattern(/^\//u)),
  call: LeadCall,
});
export type LeadCallFrame = typeof LeadCallFrame.Type;

/** Node -> CLI on the local socket, and hub -> node on the link. Exactly one of `result` and `error`. */
export const LeadResultFrame = Schema.Struct({
  t: Schema.tag("lead_result"),
  id: CallId,
  result: Schema.optionalKey(LeadCallResult),
  error: Schema.optionalKey(McpToolError),
}).check(
  Schema.makeFilter((frame) => (frame.result === undefined) !== (frame.error === undefined), {
    expected: "exactly one of result and error",
  }),
);
export type LeadResultFrame = typeof LeadResultFrame.Type;
