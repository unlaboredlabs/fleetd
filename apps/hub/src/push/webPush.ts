// Web Push without a library: the payload is encrypted per RFC 8291 (aes128gcm, one record) and the request is
// signed per RFC 8292 (VAPID, an ES256 JWT). node:crypto has everything this needs; a test checks the encryption
// against RFC 8291's worked example.
import crypto from "node:crypto";
import fs from "node:fs";

export interface VapidKeys {
  /** base64url of the 65-byte uncompressed P-256 point, as PushManager.subscribe's applicationServerKey takes it. */
  readonly publicKey: string;
  /** base64url of the 32-byte private scalar. */
  readonly privateKey: string;
}

export interface PushTarget {
  readonly endpoint: string;
  /** base64url, from the browser's PushSubscription.toJSON(). */
  readonly p256dh: string;
  readonly auth: string;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64url = (text: string) => Buffer.from(text, "base64url");
const hmac = (key: Uint8Array, data: Uint8Array) => crypto.createHmac("sha256", key).update(data).digest();

/** One record of up to 4096 bytes is all a one-line push needs. */
const RECORD_SIZE = 4096;

export const generateVapidKeys = (): VapidKeys => {
  // JWK coordinates are always full width; ECDH.getPrivateKey() drops a leading zero byte.
  const jwk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  return { publicKey: b64url(Buffer.concat([Buffer.from([4]), unb64url(jwk.x!), unb64url(jwk.y!)])), privateKey: jwk.d! };
};

/**
 * The hub's VAPID keys from `file`, created there (0600) on first use. Generated once per hub, so a browser's
 * subscription stays valid across restarts.
 */
export const vapidKeysFromFile = (file: string): VapidKeys => {
  try {
    fs.writeFileSync(file, JSON.stringify(generateVapidKeys()), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  fs.chmodSync(file, 0o600);
  const keys = JSON.parse(fs.readFileSync(file, "utf8")) as VapidKeys;
  if (unb64url(keys.publicKey).length !== 65 || unb64url(keys.privateKey).length !== 32) throw new Error(`${file} holds no P-256 VAPID key pair`);
  return keys;
};

/**
 * RFC 8291 §3-4: the aes128gcm body for one subscription. `salt` and `ephemeralPrivateKey` are for the RFC's test
 * vector only; normally both are fresh per message.
 */
export const encryptPayload = (
  plaintext: Uint8Array,
  target: Pick<PushTarget, "p256dh" | "auth">,
  fixed: { readonly salt?: Uint8Array; readonly ephemeralPrivateKey?: Uint8Array } = {},
): Buffer => {
  const uaPublic = unb64url(target.p256dh);
  const authSecret = unb64url(target.auth);
  const ecdh = crypto.createECDH("prime256v1");
  if (fixed.ephemeralPrivateKey === undefined) ecdh.generateKeys();
  else ecdh.setPrivateKey(fixed.ephemeralPrivateKey);
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = fixed.salt ?? crypto.randomBytes(16);

  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);

  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error("push payload too large for one record");
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (only) record; no extra padding.
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
};

/** The browser's side of encryptPayload, for tests and the lab's mock push service. */
export const decryptPayload = (body: Uint8Array, receiver: { readonly privateKey: Uint8Array; readonly auth: Uint8Array }): Buffer => {
  const data = Buffer.from(body);
  const salt = data.subarray(0, 16);
  const idLength = data.readUInt8(20);
  const asPublic = data.subarray(21, 21 + idLength);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(receiver.privateKey);
  const prkKey = hmac(receiver.auth, ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const decipher = crypto.createDecipheriv(
    "aes-128-gcm",
    hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16),
    hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12),
  );
  const sealed = data.subarray(21 + idLength);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  const end = padded.lastIndexOf(2);
  if (end === -1 || padded.subarray(end + 1).some((byte) => byte !== 0)) throw new Error("bad record padding");
  return padded.subarray(0, end);
};

/** RFC 8292: the Authorization header for a push to `endpoint`, valid for 12 h from `nowMs`. */
export const vapidAuthorization = (endpoint: string, keys: VapidKeys, subject: string, nowMs: number): string => {
  const encode = (value: object) => b64url(Buffer.from(JSON.stringify(value)));
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })}`;
  const pub = unb64url(keys.publicKey);
  const key = crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const signature = crypto.sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`;
};

export interface PushRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

/** The POST that delivers `text` to one subscription. */
export const pushRequest = (target: PushTarget, text: string, keys: VapidKeys, subject: string, nowMs: number): PushRequest => ({
  url: target.endpoint,
  headers: {
    "content-type": "application/octet-stream",
    "content-encoding": "aes128gcm",
    // A day: a loud item is still worth showing when the phone comes back online.
    ttl: "86400",
    urgency: "high",
    authorization: vapidAuthorization(target.endpoint, keys, subject, nowMs),
  },
  body: encryptPayload(Buffer.from(text, "utf8"), target),
});
