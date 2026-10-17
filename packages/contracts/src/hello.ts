import { Schema } from "effect";

/**
 * Version of the hub <-> node/app/cli wire protocol. Bump on any breaking change to a
 * schema in this package; peers refuse a hello whose version they do not speak.
 */
export const PROTOCOL_VERSION = 1;

export const ProtocolVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ProtocolVersion"),
);
export type ProtocolVersion = typeof ProtocolVersion.Type;

/** First frame the hub sends on every connection. */
export const HubHello = Schema.Struct({
  _tag: Schema.tag("HubHello"),
  protocolVersion: ProtocolVersion,
  hubVersion: Schema.String,
  /** T3 commit the hub's vendored wire client was built from (vendor/t3/pin.json). */
  t3Pin: Schema.String,
});
export type HubHello = typeof HubHello.Type;
