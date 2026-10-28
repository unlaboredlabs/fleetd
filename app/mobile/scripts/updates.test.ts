// The update manifests as expo-updates reads them: the multipart body its iOS reader splits, the expo-signature
// dictionary checked against a code signing certificate made as `npx expo-updates codesigning:generate` makes one, the
// asset hashes, and site/vercel.json's route from the request's headers to the file the release writes.
import { createHash, verify, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
} from "@expo/code-signing-certificates";
import { parseDictionary } from "structured-headers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ALG, BOUNDARY, KEY_ID, type Manifest, publish } from "./updates";

const RUNTIME = "c000c8604aa0d2894156f26ad966e2a8e5ec81ae";
const URL = "https://fleetd.sh/updates";

let keyPem: string;
let certPem: string;
beforeAll(() => {
  const keyPair = generateKeyPair();
  const now = new Date();
  certPem = convertCertificateToCertificatePEM(
    generateSelfSignedCodeSigningCertificate({
      keyPair,
      validityNotBefore: now,
      validityNotAfter: new Date(now.getTime() + 86_400_000),
      commonName: "fleetd",
    }),
  );
  keyPem = convertKeyPairToPEM(keyPair).privateKeyPEM;
});

/** An `expo export` output: a bundle per platform and one image. */
function exported(iosBundle = "ios bytecode"): string {
  const dist = mkdtempSync(join(tmpdir(), "updates-dist-"));
  mkdirSync(join(dist, "_expo/static/js/ios"), { recursive: true });
  mkdirSync(join(dist, "_expo/static/js/android"), { recursive: true });
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "_expo/static/js/ios/index-1.hbc"), iosBundle);
  writeFileSync(join(dist, "_expo/static/js/android/index-2.hbc"), "android bytecode");
  writeFileSync(join(dist, "assets/0f1e"), "png bytes");
  writeFileSync(
    join(dist, "metadata.json"),
    JSON.stringify({
      version: 0,
      bundler: "metro",
      fileMetadata: {
        ios: { bundle: "_expo/static/js/ios/index-1.hbc", assets: [{ path: "assets/0f1e", ext: "png" }] },
        android: { bundle: "_expo/static/js/android/index-2.hbc", assets: [{ path: "assets/0f1e", ext: "png" }] },
      },
    }),
  );
  return dist;
}

function published(dist: string, privateKeyPem = keyPem): string {
  const out = mkdtempSync(join(tmpdir(), "updates-out-"));
  publish({
    dist,
    out,
    url: URL,
    channel: "edge",
    privateKeyPem,
    runtimes: { ios: RUNTIME, android: RUNTIME },
    createdAt: "2026-10-28T12:00:00.000Z",
    expoClient: { name: "fleetd", slug: "fleetd" },
  });
  return out;
}

/** Splits a multipart body as expo-updates' UpdatesMultipartStreamReader does, into each part's headers and body. */
function parts(body: string): { headers: Map<string, string>; body: string }[] {
  const first = `--${BOUNDARY}\r\n`;
  const close = `\r\n--${BOUNDARY}--\r\n`;
  expect(body.startsWith(first)).toBe(true);
  expect(body.endsWith(close)).toBe(true);
  return body
    .slice(first.length, -close.length)
    .split(`\r\n--${BOUNDARY}\r\n`)
    .map((part) => {
      const at = part.indexOf("\r\n\r\n");
      const headers = new Map(
        part
          .slice(0, at)
          .split("\r\n")
          .map((l): [string, string] => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]),
      );
      return { headers, body: part.slice(at + 4) };
    });
}

/** The manifest part, checked as expo-updates checks it: the signature dictionary's sig, keyid and alg, then
 * RSA-SHA256 over the part's bytes with the certificate's key. */
function verified(file: string): Manifest {
  const all = parts(readFileSync(file, "utf8"));
  expect(all).toHaveLength(1);
  const [part] = all;
  expect(part!.headers.get("content-disposition")).toBe('form-data; name="manifest"');
  expect(part!.headers.get("content-type")).toMatch(/^application\/json/u);
  const sig = parseDictionary(part!.headers.get("expo-signature")!);
  expect(sig.get("keyid")?.[0]).toBe(KEY_ID);
  expect(sig.get("alg")?.[0]).toBe(ALG);
  const signature = Buffer.from(String(sig.get("sig")?.[0]), "base64");
  const ok = verify("sha256", Buffer.from(part!.body, "utf8"), new X509Certificate(certPem).publicKey, signature);
  if (!ok) throw new Error("Incorrect signature");
  return JSON.parse(part!.body) as Manifest;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("base64url");

describe("update manifests", () => {
  it("are signed with the certificate's key, per platform, for the runtime version", () => {
    const out = published(exported());
    for (const platform of ["ios", "android"]) {
      const m = verified(join(out, RUNTIME, platform));
      expect(m.runtimeVersion).toBe(RUNTIME);
      expect(m.createdAt).toBe("2026-10-28T12:00:00.000Z");
      expect(m.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
      expect(m.metadata).toEqual({});
      expect(m.extra).toEqual({ expoClient: { name: "fleetd", slug: "fleetd" } });
    }
  });

  it("name every file by a URL under the channel, with the hash the client checks", () => {
    const out = published(exported());
    const m = verified(join(out, RUNTIME, "ios"));
    expect(m.launchAsset).toMatchObject({ contentType: "application/javascript", fileExtension: ".bundle" });
    expect(m.assets).toEqual([expect.objectContaining({ contentType: "image/png", fileExtension: ".png" })]);
    for (const a of [m.launchAsset, ...m.assets]) {
      expect(a.url.startsWith(`${URL}/edge/assets/`)).toBe(true);
      const bytes = readFileSync(join(out, a.url.slice(`${URL}/edge/`.length)));
      expect(a.hash).toBe(sha256(bytes));
      expect(a.key).toBe(createHash("md5").update(bytes).digest("hex"));
    }
    expect(readFileSync(join(out, m.launchAsset.url.slice(`${URL}/edge/`.length)), "utf8")).toBe("ios bytecode");
  });

  it("keep their id while the bundle is the same, so phones don't download it again", () => {
    const out = published(exported());
    const same = verified(join(out, RUNTIME, "ios")).id;
    const android = verified(join(out, RUNTIME, "android")).id;
    expect(readFileSync(join(out, "updates.txt"), "utf8")).toBe(`ios ${RUNTIME} ${same}\nandroid ${RUNTIME} ${android}\n`);
    expect(verified(join(published(exported()), RUNTIME, "ios")).id).toBe(same);
    expect(verified(join(published(exported("new bytecode")), RUNTIME, "ios")).id).not.toBe(same);
    expect(verified(join(published(exported()), RUNTIME, "android")).id).not.toBe(same);
  });

  it("fail verification when signed by another key or changed", () => {
    const other = convertKeyPairToPEM(generateKeyPair()).privateKeyPEM;
    expect(() => verified(join(published(exported(), other), RUNTIME, "ios"))).toThrow("Incorrect signature");
    const file = join(published(exported()), RUNTIME, "ios");
    writeFileSync(file, readFileSync(file, "utf8").replace(RUNTIME, "0".repeat(40)));
    expect(() => verified(file)).toThrow("Incorrect signature");
  });

  it("refuse a runtime version the route wouldn't match", () => {
    expect(() =>
      publish({ dist: exported(), out: mkdtempSync(join(tmpdir(), "updates-out-")), url: URL, channel: "edge", privateKeyPem: keyPem, runtimes: { ios: "../x" }, createdAt: "" }),
    ).toThrow("isn't one site/vercel.json routes");
  });
});

type Rule = { source: string; has?: { type: string; key: string; value: string }[]; destination: string };
type HeaderRule = { source: string; headers: { key: string; value: string }[] };
const vercel = JSON.parse(readFileSync(join(__dirname, "../../../site/vercel.json"), "utf8")) as { rewrites: Rule[]; headers: HeaderRule[] };

/** The path Vercel rewrites a request to: the first rule for the path whose header conditions all match (anchored, as
 * Vercel's are), with their named groups put in the destination. */
function route(path: string, headers: Record<string, string>): string | undefined {
  for (const rule of vercel.rewrites) {
    if (rule.source !== path) continue;
    const params: Record<string, string> = {};
    const all = (rule.has ?? []).every((h) => {
      const value = headers[h.key.toLowerCase()];
      const m = h.type === "header" && value !== undefined ? new RegExp(`^${h.value}$`, "u").exec(value) : null;
      Object.assign(params, m?.groups);
      return m !== null;
    });
    if (all) return rule.destination.replace(/:([a-z]+)/gu, (_, name: string) => params[name] ?? `:${name}`);
  }
  return undefined;
}

describe("site/vercel.json", () => {
  const ask = { "expo-channel-name": "edge", "expo-runtime-version": RUNTIME, "expo-platform": "ios" };

  it("routes the app's request to the manifest the release writes for its channel, runtime version and platform", () => {
    const out = published(exported());
    const to = route("/updates", ask);
    expect(to).toBe(`/updates/edge/${RUNTIME}/ios`);
    // site/mobile-updates.sh unpacks a channel's files into updates/<channel>/.
    verified(join(out, to!.slice("/updates/edge/".length)));
    expect(route("/updates", { ...ask, "expo-channel-name": "stable", "expo-platform": "android" })).toBe(`/updates/stable/${RUNTIME}/android`);
  });

  it("routes nothing else", () => {
    expect(route("/updates", { ...ask, "expo-channel-name": "" })).toBeUndefined();
    expect(route("/updates", { "expo-runtime-version": RUNTIME, "expo-platform": "ios" })).toBeUndefined();
    expect(route("/updates", { ...ask, "expo-channel-name": "main" })).toBeUndefined();
    expect(route("/updates", { ...ask, "expo-platform": "web" })).toBeUndefined();
    expect(route("/updates", { ...ask, "expo-runtime-version": "../../docs/index" })).toBeUndefined();
    expect(route("/updates", { ...ask, "expo-runtime-version": ".." })).toBeUndefined();
  });

  it("answers with the expo-updates protocol's headers and the manifests' boundary", () => {
    const rule = vercel.headers.find((h) => h.source === "/updates");
    const headers = Object.fromEntries((rule?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]));
    expect(headers).toMatchObject({
      "content-type": `multipart/mixed; boundary=${BOUNDARY}`,
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
    });
    expect(headers["cache-control"]).toMatch(/max-age=0/u);
  });
});

describe("app.config.ts", () => {
  async function config(env: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const { default: make } = await import("../app.config");
    vi.unstubAllEnvs();
    return make({ projectRoot: join(__dirname, ".."), staticConfig: null, packageJsonPath: null, config: {} } as never);
  }

  it("takes no updates without a certificate", async () => {
    expect((await config({ FLEETD_UPDATES_CERT: "" })).updates).toEqual({ enabled: false });
  });

  it("asks the update URL for its channel's manifests, signed with the key the manifests name", async () => {
    const updates = (await config({ FLEETD_UPDATES_CERT: "updates-cert.pem", FLEETD_UPDATES_CHANNEL: "stable", FLEETD_UPDATES_URL: "" })).updates;
    expect(updates).toMatchObject({
      enabled: true,
      url: URL,
      requestHeaders: { "expo-channel-name": "stable" },
      codeSigningCertificate: "updates-cert.pem",
      codeSigningMetadata: { keyid: KEY_ID, alg: ALG },
    });
    // A fork with its own certificate points its builds at its own manifests.
    expect((await config({ FLEETD_UPDATES_CERT: "updates-cert.pem", FLEETD_UPDATES_URL: "https://example.com/updates" })).updates).toMatchObject({
      url: "https://example.com/updates",
      requestHeaders: { "expo-channel-name": "edge" },
    });
  });
});
