// Webhook secrets at rest: AES-256-GCM under a key that lives in its own 0600 file in the hub home, so a copy of
// hub.sqlite alone does not reveal them.
import crypto from "node:crypto";
import fs from "node:fs";

export interface SecretBox {
  readonly seal: (plain: string) => string;
  /** Throws when `sealed` was not sealed under this key. */
  readonly open: (sealed: string) => string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const fromKey = (key: Buffer): SecretBox => {
  if (key.length !== KEY_BYTES) throw new Error(`webhook key must be ${KEY_BYTES} bytes, got ${key.length}`);
  return {
    seal: (plain) => {
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const sealed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64");
    },
    open: (sealed) => {
      const bytes = Buffer.from(sealed, "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
      decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    },
  };
};

/** Reads the key in `file`, creating it (0600, exclusive, so two processes can't each write one) if missing. */
export const fromKeyFile = (file: string): SecretBox => {
  try {
    fs.writeFileSync(file, crypto.randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  fs.chmodSync(file, 0o600);
  return fromKey(fs.readFileSync(file));
};
