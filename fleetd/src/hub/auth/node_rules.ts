// Enroll codes' and node keys' rules and words, with no database behind them (nodes.ts keeps the rows): the code's
// form and life, the key's encoding, and what a node that can't enroll is told, cut to fit the link's close reason.
import { REASON_MAX_BYTES } from "../../shared/node_link.ts";

export const ENROLL_PREFIX = "fle_";
export const ENROLL_TTL_MS = 15 * 60_000;
/** How long a used or expired enroll code's row stays, so a node trying it again hears why. */
export const SPENT_CODE_KEPT_MS = 24 * 60 * 60_000;
/** Hex digits of an enroll code's hash that name it in `fleetd pair --worker-codes` and `--worker-revoke`. */
export const ENROLL_CODE_ID_LEN = 12;
/** An enroll code's machine_id when it names no machine: never a valid machine id. */
export const NAMELESS = "";
export const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, unpadded. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** `prefix` and 32 random bytes in base32. */
export const secret = (prefix: string) => `${prefix}${base32(crypto.getRandomValues(new Uint8Array(32)))}`;

/** A node's refusal, in the shape the MCP error has: the link's close reason is `reason()`. */
export class Unauthorized extends Error {
  readonly code = "forbidden";
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "Unauthorized";
  }

  /** "<message>. Fix: <fix>", as a node reads it in the link's close reason. */
  reason(): string {
    return this.fix === undefined ? this.message : `${this.message}. Fix: ${this.fix}`;
  }
}

/** From `forms` of (message, fix), fullest first: the first that fits a close reason; else the last. */
export function refusal(forms: [string, string][]): Unauthorized {
  const all = forms.map(([m, f]) => new Unauthorized(m, f));
  return all.find((r) => Buffer.byteLength(r.reason()) <= REASON_MAX_BYTES) ?? (all[all.length - 1] as Unauthorized);
}

/** A node already enrolled as `theirs` asked to enroll under another id. */
export function enrolledAs(theirs: string): Unauthorized {
  const message = `enrolled as ${theirs}`;
  return refusal([
    [message, `fleetd pair --worker ${theirs} and run its line, or fleetd machine remove ${theirs} first`],
    [message, `fleetd pair --worker ${theirs}, or fleetd machine remove ${theirs}`],
    [message, `fleetd pair --worker ${theirs}, or remove it`],
  ]);
}

/** Why an enroll code that didn't burn for `machineId` is refused, from its row (undefined: none); `now` is ms. */
export function codeRefusal(row: { machine_id: string; expires_ms: number; used_ms: number | null } | undefined, machineId: string, now: number): Unauthorized {
  const m = machineId;
  let why: string;
  if (!row) why = "unknown, replaced or revoked enrollment token";
  else if (row.used_ms !== null) why = "enrollment token was already used";
  else if (row.expires_ms <= now) why = "enrollment token expired";
  else {
    // A name typed in by hand for a code made for another: the code still works.
    const machine = row.machine_id;
    const why = `enrollment token is for machine ${machine}, not ${m}`;
    return refusal([
      [why, `join as ${machine} (--machine-id ${machine}), or on the hub run fleetd pair --worker ${m} for a code for ${m}`],
      [why, `join as ${machine} (--machine-id ${machine})`],
      [`the code is for ${machine}`, `--machine-id ${machine}`],
    ]);
  }
  if (row?.machine_id === NAMELESS) return refusal([[why, "ask the hub for a new join line"]]);
  return refusal([
    [why, `on the hub, run fleetd pair --worker ${m} for a new code`],
    [why, `fleetd pair --worker ${m} on the hub`],
  ]);
}

/** `machineId` is already another computer's (its fingerprint differs). */
export const anotherComputer = (machineId: string) =>
  refusal([
    [`${machineId} is another computer's machine id`, `use an id of its own, or fleetd machine remove ${machineId} first`],
    ["this id is another computer's", `use another id, or fleetd machine remove ${machineId} first`],
  ]);

/** The `k`th try at a free id for `wish` (2, 3, …): `wish-k`, cut to fit 32 characters. */
export function suffixed(wish: string, k: number): string {
  const suffix = `-${k}`;
  return `${wish.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
}
