import { Schema } from "effect";
import { ProtocolVersion } from "./hello.ts";
import { MachineId, Timestamp } from "./ids.ts";

// Node link: WebSocket JSON, one message per frame, discriminated by "t".
// Hub sends `challenge` first; node answers `hello` signed over that nonce; hub replies `welcome`.

export const HubChallenge = Schema.Struct({ t: Schema.tag("challenge"), nonce: Schema.NonEmptyString });
export type HubChallenge = typeof HubChallenge.Type;

export const NodeHello = Schema.Struct({
  t: Schema.tag("hello"),
  machineId: MachineId,
  name: Schema.String,
  tags: Schema.Array(Schema.String),
  nodeVersion: Schema.String,
  protocol: ProtocolVersion,
  t3: Schema.Struct({
    /** Loopback or tailnet URL the hub can reach. */
    url: Schema.String,
    version: Schema.String,
    protocol: Schema.Int,
  }),
  /** ed25519 public key, base64. */
  pubKey: Schema.NonEmptyString,
  /** Signature over the hub's challenge nonce, base64. */
  sig: Schema.NonEmptyString,
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

/** Both directions every 15 s; a link silent for 45 s is offline. */
export const Heartbeat = Schema.Struct({ t: Schema.tag("hb"), at: Timestamp });
export type Heartbeat = typeof Heartbeat.Type;

export const NodeToHub = Schema.Union([NodeHello, NodeT3Session, Heartbeat]).pipe(Schema.toTaggedUnion("t"));
export type NodeToHub = typeof NodeToHub.Type;

export const HubToNode = Schema.Union([HubChallenge, HubWelcome, Heartbeat]).pipe(Schema.toTaggedUnion("t"));
export type HubToNode = typeof HubToNode.Type;
