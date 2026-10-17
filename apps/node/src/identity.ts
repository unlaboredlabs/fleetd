import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
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
