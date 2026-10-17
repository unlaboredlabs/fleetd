import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import sodium from "libsodium-wrappers";
import fs from "node:fs";
import path from "node:path";

export interface NodeIdentity {
  /** Raw 32-byte ed25519 public key, base64. */
  readonly pubKey: string;
  /** Signature over the nonce's UTF-8 bytes, base64. */
  readonly sign: (nonce: string) => string;
}

const KEY_FILE = "node-key.pem";

const fromPrivateKey = (privateKey: KeyObject): NodeIdentity => {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return {
    pubKey: Buffer.from(jwk.x ?? "", "base64url").toString("base64"),
    sign: (nonce) => sign(null, Buffer.from(nonce, "utf8"), privateKey).toString("base64"),
  };
};

/** The node's ed25519 key from `<home>/node-key.pem`, created (mode 0600) on first use. */
export const loadOrCreateIdentity = (home: string): NodeIdentity => {
  const file = path.join(home, KEY_FILE);
  if (fs.existsSync(file)) return fromPrivateKey(createPrivateKey(fs.readFileSync(file, "utf8")));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  return fromPrivateKey(privateKey);
};

export interface NodeBoxKey {
  /** Raw 32-byte X25519 public key, standard base64: what browsers seal this machine's secrets to. */
  readonly publicKey: string;
  /** Opens a libsodium sealed box; undefined when it was not sealed to this key or was tampered with. */
  readonly open: (sealed: Uint8Array) => Uint8Array | undefined;
}

const BOX_KEY_FILE = "node-box-key.pem";

const boxKeyFrom = (privateKey: KeyObject): NodeBoxKey => {
  const jwk = privateKey.export({ format: "jwk" });
  const publicKey = Buffer.from(jwk.x ?? "", "base64url");
  const secretKey = Buffer.from(jwk.d ?? "", "base64url");
  return {
    publicKey: publicKey.toString("base64"),
    open: (sealed) => {
      try {
        return sodium.crypto_box_seal_open(sealed, publicKey, secretKey);
      } catch {
        return undefined;
      }
    },
  };
};

/**
 * The node's X25519 key for sealed secrets from `<home>/node-box-key.pem`, created (mode 0600) on first use, so a
 * node that joined before M8 gets one on its next start. Kept apart from the ed25519 identity, which only signs.
 */
export const loadOrCreateBoxKey = async (home: string): Promise<NodeBoxKey> => {
  await sodium.ready;
  const file = path.join(home, BOX_KEY_FILE);
  if (fs.existsSync(file)) return boxKeyFrom(createPrivateKey(fs.readFileSync(file, "utf8")));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("x25519");
  fs.writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  return boxKeyFrom(privateKey);
};
