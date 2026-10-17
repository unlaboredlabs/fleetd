import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decryptPayload, encryptPayload, generateVapidKeys, pushRequest, vapidKeysFromFile } from "./webPush.ts";

const unb64 = (text: string) => Buffer.from(text, "base64url");

// RFC 8291 Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("Web Push encryption (RFC 8291)", () => {
  it("matches the RFC's worked example byte for byte", () => {
    const body = encryptPayload(Buffer.from(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: unb64(RFC.salt), ephemeralPrivateKey: unb64(RFC.asPrivate) });
    expect(body.toString("base64url")).toBe(RFC.body);
    expect(decryptPayload(unb64(RFC.body), { privateKey: unb64(RFC.uaPrivate), auth: unb64(RFC.auth) }).toString()).toBe(RFC.plaintext);
  });

  it("round-trips a fresh message to a browser-like key pair", () => {
    const ua = crypto.createECDH("prime256v1");
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const body = encryptPayload(Buffer.from("A3 irreversible: deploy (+2 more)"), { p256dh: ua.getPublicKey("base64url"), auth: auth.toString("base64url") });
    expect(decryptPayload(body, { privateKey: ua.getPrivateKey(), auth }).toString()).toBe("A3 irreversible: deploy (+2 more)");
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs an ES256 JWT for the endpoint's origin that verifies with the advertised key", () => {
    const keys = generateVapidKeys();
    const ua = crypto.createECDH("prime256v1");
    ua.generateKeys();
    const now = Date.parse("2026-10-17T10:00:00Z");
    const request = pushRequest(
      { endpoint: "https://push.example.com/send/abc?x=1", p256dh: ua.getPublicKey("base64url"), auth: crypto.randomBytes(16).toString("base64url") },
      "hi",
      keys,
      "https://github.com/wynn-dev/fleetd",
      now,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/u.exec(request.headers.authorization!);
    expect(match).not.toBeNull();
    const [, header, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(unb64(header!).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(unb64(claims!).toString())).toEqual({ aud: "https://push.example.com", exp: now / 1000 + 12 * 3600, sub: "https://github.com/wynn-dev/fleetd" });
    const pub = unb64(keys.publicKey);
    const verifier = crypto.createPublicKey({
      key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") },
      format: "jwk",
    });
    expect(crypto.verify("sha256", Buffer.from(`${header}.${claims}`), { key: verifier, dsaEncoding: "ieee-p1363" }, unb64(signature!))).toBe(true);
    expect(request.headers["content-encoding"]).toBe("aes128gcm");
  });

  it("generates the hub's keys once, 0600, and reads the same keys back", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-vapid-")), "vapid.json");
    const first = vapidKeysFromFile(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(vapidKeysFromFile(file)).toEqual(first);
    expect(unb64(first.publicKey)).toHaveLength(65);
  });
});
