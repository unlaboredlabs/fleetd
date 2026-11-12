// A screen session's relay as its two nodes and the hub hold it, without the sockets (relay.ts pipes them): how long a
// side may take to dial, the largest message, a token and what the hub keeps of it, and the proof of an ended session.
import { sha256 } from "../auth/allows.ts";

/** How long the runner's node has to connect its side of a channel. */
export const DIAL_WAIT = 15_000;
/** A full-page screenshot or a large DOM is several MB; as the node's own proxy allows. */
export const MAX_MESSAGE = 128 << 20;
/** The header of the relay's own refusal of a session that ended. */
export const GONE_HEADER = "x-fleetd-relay-gone";

/** What the hub keeps of a session's token. */
export const hashToken = (token: string) => sha256(token);

/**
 * What the relay's refusal of a session that ended carries, from the SHA-256 of its token: only a party that knows
 * the token makes it, so the agent's node tells it from a refusal by something in front of the hub.
 */
export const goneProof = (tokenHash: string) =>
  new Bun.CryptoHasher("sha256").update("fleetd relay 1: gone ").update(tokenHash).digest("hex");

/** A session's one-time relay token: 64 hex digits. */
export const isToken = (t: string) => /^[0-9a-f]{64}$/.test(t);
