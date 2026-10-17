// Standard Webhooks signing (https://www.standardwebhooks.com): HMAC-SHA256 over `id.timestamp.body`, with a
// `whsec_`-prefixed base64 secret.
import crypto from "node:crypto";

const PREFIX = "whsec_";

/** 32 random bytes, base64, `whsec_`-prefixed: the format Standard Webhooks libraries accept as-is. */
export const newSecret = (): string => PREFIX + crypto.randomBytes(32).toString("base64");

const keyBytes = (secret: string) => Buffer.from(secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret, "base64");

/** The `webhook-signature` value for one delivery attempt: `v1,<base64 hmac-sha256>`. */
export const sign = (secret: string, id: string, timestampSec: number, body: string): string =>
  `v1,${crypto.createHmac("sha256", keyBytes(secret)).update(`${id}.${timestampSec}.${body}`).digest("base64")}`;

export interface SignedHeaders {
  readonly "webhook-id": string;
  readonly "webhook-timestamp": string;
  readonly "webhook-signature": string;
}

/** Receiver-side check: one of the space-separated `v1` signatures matches and the timestamp is within tolerance. */
export const verify = (secret: string, headers: SignedHeaders, body: string, nowSec: number, toleranceSec = 300): boolean => {
  const timestamp = Number(headers["webhook-timestamp"]);
  if (!Number.isInteger(timestamp) || Math.abs(nowSec - timestamp) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, headers["webhook-id"], timestamp, body));
  return headers["webhook-signature"].split(" ").some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
};
