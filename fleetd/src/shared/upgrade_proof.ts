// An enrolled node's proof on its link upgrade: request headers naming its machine and key, the time, the host and path
// it dials, and its link key's ed25519 signature over them. The open hub ignores them; a hub that holds sockets before
// their hello (fleetd cloud) can let a proven machine skip the wait. The challenge and hello stay as they are, so a
// replayed upgrade still has to sign the hub's nonce.
//
// The signed message starts with UPGRADE_PROOF_CONTEXT and has newlines in it; a hello signs the hub's nonce, which is
// base64url, so neither signature verifies as the other, and the node refuses to sign a nonce that starts with the
// context (`isUpgradeProofMessage`).
import { createPublicKey, verify } from "node:crypto";

export const UPGRADE_PROOF_CONTEXT = "fleetd node link upgrade v1";

/** The upgrade's request headers. Never log them. */
export const UPGRADE_PROOF_HEADERS = {
  machineId: "x-fleetd-machine",
  /** The hello's `pubKey`: raw 32-byte ed25519 public key, base64. */
  pubKey: "x-fleetd-key",
  /** Epoch milliseconds. */
  at: "x-fleetd-at",
  /** The host the node dialled, with its port when the URL has one (`URL.host`). */
  host: "x-fleetd-host",
  path: "x-fleetd-path",
  /** Signature over `upgradeProofMessage`, base64. */
  sig: "x-fleetd-sig",
} as const;

export type UpgradeProof = { machineId: string; pubKey: string; at: number; host: string; path: string; sig: string };

export type UpgradeProofCheck = { ok: true } | { ok: false; why: string };

/** What the node signs. */
export const upgradeProofMessage = (p: Omit<UpgradeProof, "pubKey" | "sig">) =>
  [UPGRADE_PROOF_CONTEXT, p.host, p.path, p.machineId, String(p.at)].join("\n");

export const isUpgradeProofMessage = (text: string) => text.startsWith(UPGRADE_PROOF_CONTEXT);

/** The headers an enrolled node sends on its upgrade to `url`; `sign` signs a message's UTF-8 bytes with its link key,
 * base64. */
export function makeUpgradeProof(input: {
  url: string;
  machineId: string;
  pubKey: string;
  now: number;
  sign: (message: string) => string;
}): Record<string, string> {
  const { host, pathname: path } = new URL(input.url);
  const at = Math.floor(input.now);
  const sig = input.sign(upgradeProofMessage({ machineId: input.machineId, at, host, path }));
  const h = UPGRADE_PROOF_HEADERS;
  return { [h.machineId]: input.machineId, [h.pubKey]: input.pubKey, [h.at]: String(at), [h.host]: host, [h.path]: path, [h.sig]: sig };
}

/** The proof in an upgrade's headers; undefined when any part is missing or the time isn't a number. */
export function readUpgradeProof(headers: Headers): UpgradeProof | undefined {
  const h = UPGRADE_PROOF_HEADERS;
  const [machineId, pubKey, at, host, path, sig] = [h.machineId, h.pubKey, h.at, h.host, h.path, h.sig].map((n) => headers.get(n) ?? "");
  if (!machineId || !pubKey || !host || !path || !sig || !/^\d{1,16}$/.test(at!)) return undefined;
  return { machineId: machineId!, pubKey: pubKey!, at: Number(at), host: host!, path: path!, sig: sig! };
}

/** Whether `proof` is `enrolled`'s, made for this `host` and `path` within `skewMs` of `now` either way. */
export function verifyUpgradeProof(
  proof: UpgradeProof,
  expect: { machineId: string; pubKey: string; host: string; path: string; now: number; skewMs: number },
): UpgradeProofCheck {
  if (proof.machineId !== expect.machineId) return { ok: false, why: "the proof names another machine" };
  if (proof.pubKey !== expect.pubKey) return { ok: false, why: "the proof names another key than the machine's" };
  if (proof.host.toLowerCase() !== expect.host.toLowerCase()) return { ok: false, why: "the proof was made for another host" };
  if (proof.path !== expect.path) return { ok: false, why: "the proof was made for another path" };
  if (proof.at < expect.now - expect.skewMs) return { ok: false, why: "the proof is too old" };
  if (proof.at > expect.now + expect.skewMs) return { ok: false, why: "the proof's time is ahead of the clock" };
  if (!verifyEd25519(expect.pubKey, upgradeProofMessage(proof), proof.sig)) return { ok: false, why: "the proof's signature does not verify" };
  return { ok: true };
}

/** Raw 32-byte ed25519 public key (base64) verifying `sig` (base64) over `message`'s UTF-8 bytes. */
export function verifyEd25519(pubKey: string, message: string, sig: string): boolean {
  try {
    const raw = Buffer.from(pubKey, "base64");
    const signature = Buffer.from(sig, "base64");
    if (raw.length !== 32 || signature.length !== 64) return false;
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    return verify(null, Buffer.from(message), key, signature);
  } catch {
    return false;
  }
}
