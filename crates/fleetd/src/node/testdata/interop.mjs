// Interop vectors for the Rust node, made the way the browser makes them (a node:crypto key in PKCS#8 PEM,
// libsodium-wrappers crypto_box_seal). LIBSODIUM_WRAPPERS is the package directory.
//   node interop.mjs gen > interop.json   a box key and a value sealed to it
//   node interop.mjs open <pem file> <sealed base64>   prints what libsodium opens, base64
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.join(process.env.LIBSODIUM_WRAPPERS, "package.json"));
const sodium = require(process.env.LIBSODIUM_WRAPPERS);
await sodium.ready;
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const raw = (key, part) => Buffer.from(key.export({ format: "jwk" })[part], "base64url");

const [mode, ...args] = process.argv.slice(2);
if (mode === "gen") {
  const box = generateKeyPairSync("x25519").privateKey;
  const value = "fake-secret-abcDEF-secretValue";
  process.stdout.write(`${JSON.stringify({
    boxKeyPem: box.export({ format: "pem", type: "pkcs8" }),
    boxPubKey: b64(raw(box, "x")),
    value,
    sealed: b64(sodium.crypto_box_seal(new TextEncoder().encode(value), raw(box, "x"))),
  }, null, 2)}\n`);
} else if (mode === "open") {
  const key = createPrivateKey(fs.readFileSync(args[0], "utf8"));
  process.stdout.write(b64(sodium.crypto_box_seal_open(Buffer.from(args[1], "base64"), raw(key, "x"), raw(key, "d"))));
} else {
  throw new Error("usage: interop.mjs gen | open <pem file> <sealed base64>");
}
