// An enrolled node's proof on its link upgrade (src/shared/upgrade_proof.ts): made with the node's link key, checked
// against the enrolled key, host, path and a clock of the test's own, and of no use as a hello's signature or back.
import { expect, test } from "bun:test";
import { NodeIdentity } from "../src/node/identity.ts";
import { verifyNonceSignature } from "../src/hub/link/server.ts";
import {
  makeUpgradeProof,
  readUpgradeProof,
  UPGRADE_PROOF_HEADERS as H,
  upgradeProofMessage,
  verifyUpgradeProof,
  type UpgradeProof,
} from "../src/shared/upgrade_proof.ts";

const NOW = 1_800_000_000_000;
const SKEW = 60_000;
const id = new NodeIdentity(new Uint8Array(32).fill(7));
const other = new NodeIdentity(new Uint8Array(32).fill(9));

const proofAt = (now: number, who = id, url = "wss://devbox:4790/node/link", machineId = "devbox") =>
  readUpgradeProof(new Headers(makeUpgradeProof({ url, machineId, pubKey: who.pubKey(), now, sign: (m) => who.signUpgrade(m) })))!;
const expected = { machineId: "devbox", pubKey: id.pubKey(), host: "devbox:4790", path: "/node/link", now: NOW, skewMs: SKEW };

test("a proof made for the hub's host and path verifies against the machine's enrolled key", () => {
  const headers = makeUpgradeProof({ url: "wss://devbox:4790/node/link", machineId: "devbox", pubKey: id.pubKey(), now: NOW, sign: (m) => id.signUpgrade(m) });
  expect(Object.keys(headers).sort()).toEqual(Object.values(H).sort());
  expect(headers).toMatchObject({ [H.machineId]: "devbox", [H.pubKey]: id.pubKey(), [H.at]: String(NOW), [H.host]: "devbox:4790", [H.path]: "/node/link" });
  const proof = readUpgradeProof(new Headers(headers))!;
  expect(verifyUpgradeProof(proof, expected)).toEqual({ ok: true });
  // Within the skew either way.
  expect(verifyUpgradeProof(proofAt(NOW - SKEW), expected)).toEqual({ ok: true });
  expect(verifyUpgradeProof(proofAt(NOW + SKEW), expected)).toEqual({ ok: true });
  // A host's case doesn't matter; the default port isn't in it.
  expect(verifyUpgradeProof(proof, { ...expected, host: "DEVBOX:4790" })).toEqual({ ok: true });
  expect(proofAt(NOW, id, "wss://devbox/node/link").host).toBe("devbox");
});

test("each wrong part is refused with its own why", () => {
  const proof = proofAt(NOW);
  const whys = [
    verifyUpgradeProof(proof, { ...expected, host: "devbox-2:4790" }),
    verifyUpgradeProof(proof, { ...expected, path: "/app" }),
    verifyUpgradeProof(proof, { ...expected, machineId: "devbox-2" }),
    verifyUpgradeProof(proof, { ...expected, pubKey: other.pubKey() }),
    verifyUpgradeProof(proofAt(NOW - SKEW - 1), expected),
    verifyUpgradeProof(proofAt(NOW + SKEW + 1), expected),
    verifyUpgradeProof({ ...proof, sig: other.signUpgrade(upgradeProofMessage(proof)) }, expected),
  ].map((r) => {
    expect(r.ok).toBe(false);
    return (r as { why: string }).why;
  });
  expect(new Set(whys).size).toBe(whys.length);
  expect(whys).toEqual([
    "the proof was made for another host",
    "the proof was made for another path",
    "the proof names another machine",
    "the proof names another key than the machine's",
    "the proof is too old",
    "the proof's time is ahead of the clock",
    "the proof's signature does not verify",
  ]);
});

test("a header changed after signing breaks the signature", () => {
  const proof = proofAt(NOW);
  const bad = "the proof's signature does not verify";
  const tamper = (p: Partial<UpgradeProof>, e: Partial<typeof expected> = {}) => verifyUpgradeProof({ ...proof, ...p }, { ...expected, ...e });
  expect(tamper({ at: NOW + 1 })).toEqual({ ok: false, why: bad });
  expect(tamper({ host: "devbox-2:4790" }, { host: "devbox-2:4790" })).toEqual({ ok: false, why: bad });
  expect(tamper({ path: "/app" }, { path: "/app" })).toEqual({ ok: false, why: bad });
  expect(tamper({ machineId: "devbox-2" }, { machineId: "devbox-2" })).toEqual({ ok: false, why: bad });
  const flipped = Buffer.from(proof.sig, "base64");
  flipped[0]! ^= 1;
  expect(tamper({ sig: flipped.toString("base64") })).toEqual({ ok: false, why: bad });
  expect(tamper({ sig: "not base64 at all" })).toEqual({ ok: false, why: bad });
});

test("a hello's signature is no upgrade proof, and a proof's signature is no hello", () => {
  // The hub's nonce, signed for a hello, offered as the proof's signature.
  const nonce = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg";
  const proof = proofAt(NOW);
  expect(verifyUpgradeProof({ ...proof, sig: id.sign(nonce) }, expected)).toEqual({ ok: false, why: "the proof's signature does not verify" });
  // A proof's signature offered as a hello's, over any nonce the hub sent.
  expect(verifyNonceSignature(id.pubKey(), nonce, proof.sig)).toBe(false);
  // A hub that sends a proof's message as its nonce gets no signature for it.
  expect(() => id.sign(upgradeProofMessage(proof))).toThrow("the hub's challenge is not a nonce");
  expect(() => id.signUpgrade(nonce)).toThrow("not an upgrade proof");
});

test("an upgrade missing any part of the proof, or with a time that isn't a number, carries none", () => {
  const headers = makeUpgradeProof({ url: "ws://devbox:4790/node/link", machineId: "devbox", pubKey: id.pubKey(), now: NOW, sign: (m) => id.signUpgrade(m) });
  expect(readUpgradeProof(new Headers())).toBeUndefined();
  for (const name of Object.values(H)) {
    const h = new Headers(headers);
    h.delete(name);
    expect(readUpgradeProof(h)).toBeUndefined();
  }
  expect(readUpgradeProof(new Headers({ ...headers, [H.at]: "soon" }))).toBeUndefined();
});
