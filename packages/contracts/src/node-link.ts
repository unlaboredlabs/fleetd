import { Schema } from "effect";
import { ProtocolVersion } from "./hello.ts";
import { MachineId, Timestamp } from "./ids.ts";
import { LeadCallFrame, LeadResultFrame } from "./lead-calls.ts";
import { AskId, DecisionKey, EnvName, GatedArgv, GatedCwd, GatedTimeoutSec, SecretEnv } from "./ledger.ts";
import { BoxPublicKey, SealedSecret, SecretFingerprint, SecretSink } from "./secrets.ts";

// Node link: WebSocket JSON, one message per frame, discriminated by "t".
// Hub sends `challenge` first; node answers `hello` signed over that nonce; hub replies `welcome`.
// The hub refuses or ends a link by closing the socket with one of these codes and a plain-language reason.

export const NodeLinkClose = {
  /** A frame that does not decode, or arrives out of order. */
  badFrame: 4000,
  /** Bad signature, unknown key, or an invalid, used or expired enroll token. Retrying will not help. */
  unauthorized: 4001,
  /** The two sides speak different protocol versions. Retrying will not help. */
  protocolMismatch: 4002,
  /** A newer link for the same machine took over. */
  replaced: 4003,
  /** No frame for 45 s. */
  heartbeatTimeout: 4008,
} as const;

export const HubChallenge = Schema.Struct({ t: Schema.tag("challenge"), nonce: Schema.NonEmptyString });
export type HubChallenge = typeof HubChallenge.Type;

/** Where and which T3 the node supervises. */
export const NodeT3Endpoint = Schema.Struct({
  /** Loopback or tailnet URL the hub can reach. */
  url: Schema.String,
  version: Schema.String,
  protocol: Schema.Int,
});
export type NodeT3Endpoint = typeof NodeT3Endpoint.Type;

export const NodeHello = Schema.Struct({
  t: Schema.tag("hello"),
  machineId: MachineId,
  name: Schema.String,
  tags: Schema.Array(Schema.String),
  nodeVersion: Schema.String,
  protocol: ProtocolVersion,
  /** Absent when T3 is down at node start; the hub shows the machine as degraded. */
  t3: Schema.optionalKey(NodeT3Endpoint),
  /** ed25519 public key, base64. */
  pubKey: Schema.NonEmptyString,
  /** Signature over the hub's challenge nonce (its UTF-8 bytes), base64. */
  sig: Schema.NonEmptyString,
  /** One-time token from `fleetd hub token create`; sent only until the hub has registered `pubKey`. */
  enrollToken: Schema.optionalKey(Schema.NonEmptyString),
  /** M8: the X25519 key browsers seal this machine's secrets to. Absent on nodes from before M8, which take no secrets. */
  boxPubKey: Schema.optionalKey(BoxPublicKey),
});
export type NodeHello = typeof NodeHello.Type;

export const HubWelcome = Schema.Struct({
  t: Schema.tag("welcome"),
  hubId: Schema.String,
  protocol: ProtocolVersion,
  nonce: Schema.optionalKey(Schema.String),
});
export type HubWelcome = typeof HubWelcome.Type;

/** Sent on connect and on each re-mint. */
export const NodeT3Session = Schema.Struct({
  t: Schema.tag("t3session"),
  bearer: Schema.NonEmptyString,
  expiresAt: Timestamp,
});
export type NodeT3Session = typeof NodeT3Session.Type;

/** The node's view of its local T3, sent when it changes. */
export const NodeT3State = Schema.Struct({
  t: Schema.tag("t3state"),
  state: Schema.Literals(["up", "down", "restarting"]),
  reason: Schema.optionalKey(Schema.String),
  /** Sent with "up", so the hub can attach a machine whose T3 was down when the node said hello. */
  t3: Schema.optionalKey(NodeT3Endpoint),
  at: Timestamp,
});
export type NodeT3State = typeof NodeT3State.Type;

/** Both directions every 15 s; a link silent for 45 s is offline. */
export const Heartbeat = Schema.Struct({ t: Schema.tag("hb"), at: Timestamp });
export type Heartbeat = typeof Heartbeat.Type;

/** Hub -> node: run a `cmd` check. argv only, never through a shell. */
export const CmdCheck = Schema.Struct({
  t: Schema.tag("cmd_check"),
  id: Schema.NonEmptyString,
  /** Absolute; the project workspace unless the check says otherwise. */
  cwd: Schema.String.check(Schema.isPattern(/^\//u)),
  argv: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  timeoutSec: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
});
export type CmdCheck = typeof CmdCheck.Type;

/** Node -> hub, one per `cmd_check`. */
export const CmdResult = Schema.Struct({
  t: Schema.tag("cmd_result"),
  id: Schema.NonEmptyString,
  /** Null when the process did not exit on its own: it timed out, was killed by a signal, or could not start. */
  exitCode: Schema.NullOr(Schema.Int),
  /** Last 2000 characters of stdout and stderr interleaved, secrets scrubbed; the start error when it could not start. */
  outputTail: Schema.String.check(Schema.isMaxLength(2000)),
  timedOut: Schema.Boolean,
});
export type CmdResult = typeof CmdResult.Type;

const FrameError = Schema.NonEmptyString.check(Schema.isMaxLength(500));

/** Hub -> node: a secret sealed in the browser to this node's `boxPubKey`; the hub never sees the plaintext. */
export const SecretDeliver = Schema.Struct({
  t: Schema.tag("secret_deliver"),
  id: Schema.NonEmptyString,
  /** On this machine. */
  sink: SecretSink,
  sealed: SealedSecret,
  /** The ask's key; `secretEnv` entries name the secret by it. */
  secretKey: DecisionKey,
  /** An env: sink's variable; absent means `secretEnvName(secretKey)`. */
  envName: Schema.optionalKey(EnvName),
});
export type SecretDeliver = typeof SecretDeliver.Type;

/** Node -> hub, one per `secret_deliver`: the sink was written (0600) and the buffer wiped, or why not. */
export const SecretResult = Schema.Struct({
  t: Schema.tag("secret_result"),
  id: Schema.NonEmptyString,
  fingerprint: Schema.optionalKey(SecretFingerprint),
  /** Plain language, never the value: a sink outside the command roots, a box that does not open, a write error. */
  error: Schema.optionalKey(FrameError),
}).check(
  Schema.makeFilter((frame) => (frame.fingerprint === undefined) !== (frame.error === undefined), {
    expected: "exactly one of fingerprint and error",
  }),
);
export type SecretResult = typeof SecretResult.Type;

/** Hub -> node: run an approved ask's stored command, confined like a `cmd_check`. */
export const GatedRun = Schema.Struct({
  t: Schema.tag("gated_run"),
  id: Schema.NonEmptyString,
  askId: AskId,
  argv: GatedArgv,
  /** The spec's cwd, or the project workspace when it has none: the node never picks one itself. */
  cwd: GatedCwd,
  timeoutSec: GatedTimeoutSec,
  /** Read from the node's own sinks and scrubbed from the output. */
  secretEnv: Schema.optionalKey(SecretEnv),
});
export type GatedRun = typeof GatedRun.Type;

/** Node -> hub, one per `gated_run`. */
export const GatedResult = Schema.Struct({
  t: Schema.tag("gated_result"),
  id: Schema.NonEmptyString,
  /** Null when the process did not exit on its own: it timed out, was killed by a signal, or could not start. */
  exitCode: Schema.NullOr(Schema.Int),
  /** Last 2000 characters of stdout and stderr interleaved, with every injected secret value scrubbed. */
  outputTail: Schema.String.check(Schema.isMaxLength(2000)),
  timedOut: Schema.Boolean,
  /** Why it did not run: a cwd outside the command roots, a missing secret, a start error. */
  error: Schema.optionalKey(FrameError),
});
export type GatedResult = typeof GatedResult.Type;

export const NodeToHub = Schema.Union([
  NodeHello,
  NodeT3Session,
  NodeT3State,
  Heartbeat,
  LeadCallFrame,
  CmdResult,
  SecretResult,
  GatedResult,
]).pipe(Schema.toTaggedUnion("t"));
export type NodeToHub = typeof NodeToHub.Type;

export const HubToNode = Schema.Union([HubChallenge, HubWelcome, Heartbeat, LeadResultFrame, CmdCheck, SecretDeliver, GatedRun]).pipe(
  Schema.toTaggedUnion("t"),
);
export type HubToNode = typeof HubToNode.Type;
