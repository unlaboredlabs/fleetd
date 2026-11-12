// libsodium's sealed boxes (sealed_box_core.ts, which another repository imports too) and the box key file the hub and
// a node keep.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pemOf, secretFromPem } from "./sealed_box_core.ts";

export * from "./sealed_box_core.ts";

/** The box key in `<home>/node-box-key.pem` (the hub's and a node's), or a fresh one written there with mode 0600. */
export function loadOrCreateBoxKey(home: string): Uint8Array {
  const path = join(home, "node-box-key.pem");
  if (existsSync(path)) {
    const key = secretFromPem(readFileSync(path, "utf8"));
    if (!key) throw new Error(`${path}: not a PKCS#8 key of the expected type`);
    return key;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const key = crypto.getRandomValues(new Uint8Array(32));
  writeFileSync(path, pemOf(key), { mode: 0o600, flag: "wx" });
  return key;
}
