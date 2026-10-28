// Over-the-air updates for the phone app as static files, per the expo-updates protocol (D219): no EAS, no server.
// build-release.yml runs it on each release, after `expo export`:
//
//   node scripts/updates.ts --dist dist --out <dir> --url https://fleetd.sh/updates --channel edge \
//     --key private-key.pem --config expo-config.json --runtime ios=<runtime version> --runtime android=<...>
//
// <dir> becomes the channel's directory under the update URL (site/mobile-updates.sh unpacks it into site/updates/):
// - <runtime version>/<platform>: the signed manifest, a whole multipart/mixed response body. Static hosting can't
//   set a signature header per file, so the signature travels in the manifest part's own headers, which expo-updates
//   reads there; site/vercel.json routes the request's expo-channel-name, expo-runtime-version and expo-platform to
//   it and sets the response headers (BOUNDARY below is the one it names).
// - assets/<md5><ext>: the bundle and its assets, which the client checks against the manifest's hashes.
// - updates.txt: "<platform> <runtime version> <update id>" per manifest, which the release compares with what it
//   holds, so an unchanged release doesn't redeploy fleetd.sh.
//
// A manifest's id comes from its contents, so a release whose JavaScript didn't change publishes the same id and no
// phone downloads it again.
import { createHash, sign } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const BOUNDARY = "fleetd-update";
/** The code signing metadata app.config.ts gives expo-updates. */
export const KEY_ID = "main";
export const ALG = "rsa-v1_5-sha256";

export type Platform = "ios" | "android";
export type Asset = { hash: string; key: string; contentType: string; fileExtension: string; url: string };
export type Manifest = {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: Asset;
  assets: Asset[];
  metadata: Record<string, never>;
  extra: { expoClient?: unknown };
};
/** `expo export`'s dist/metadata.json. */
type ExportMetadata = { fileMetadata: Partial<Record<Platform, { bundle: string; assets: { path: string; ext: string }[] }>> };

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  json: "application/json",
};

const base64url = (b: Buffer) => b.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

/** One file of the export as the manifest names it, and where it goes under the channel's directory. */
function asset(dist: string, path: string, ext: string, launch: boolean, base: string): { asset: Asset; file: string } {
  const bytes = readFileSync(join(dist, path));
  const key = createHash("md5").update(bytes).digest("hex");
  const fileExtension = launch ? ".bundle" : `.${ext}`;
  const file = `assets/${key}${fileExtension}`;
  return {
    asset: {
      hash: base64url(createHash("sha256").update(bytes).digest()),
      key,
      contentType: launch ? "application/javascript" : (TYPES[ext] ?? "application/octet-stream"),
      fileExtension,
      url: `${base}/${file}`,
    },
    file,
  };
}

/** A platform's manifest and the export's files it needs (source in dist, destination under the channel). */
export function manifest(opts: {
  dist: string;
  platform: Platform;
  runtimeVersion: string;
  url: string;
  channel: string;
  createdAt: string;
  expoClient?: unknown;
}): { manifest: Manifest; files: [string, string][] } {
  const meta = (JSON.parse(readFileSync(join(opts.dist, "metadata.json"), "utf8")) as ExportMetadata).fileMetadata[opts.platform];
  if (meta === undefined) throw new Error(`the export has no ${opts.platform} bundle`);
  const base = `${opts.url.replace(/\/+$/u, "")}/${opts.channel}`;
  const launch = asset(opts.dist, meta.bundle, "bundle", true, base);
  const rest = meta.assets.map((a) => asset(opts.dist, a.path, a.ext, false, base));
  const id = createHash("sha256")
    .update([opts.runtimeVersion, opts.platform, launch.asset.hash, ...rest.map((r) => r.asset.hash).sort()].join("\n"))
    .digest("hex");
  return {
    manifest: {
      id: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`,
      createdAt: opts.createdAt,
      runtimeVersion: opts.runtimeVersion,
      launchAsset: launch.asset,
      assets: rest.map((r) => r.asset),
      metadata: {},
      extra: opts.expoClient === undefined ? {} : { expoClient: opts.expoClient },
    },
    files: [[meta.bundle, launch.file], ...meta.assets.map((a, i): [string, string] => [a.path, rest[i]!.file])],
  };
}

/** The manifest as a multipart/mixed body whose manifest part carries its expo-signature (RSA-SHA256 over the part's
 * bytes, as a structured-field dictionary). */
export function signedBody(m: Manifest, privateKeyPem: string): string {
  const json = JSON.stringify(m);
  if (json.includes(`--${BOUNDARY}`)) throw new Error("the manifest contains the multipart boundary");
  const sig = sign("sha256", Buffer.from(json, "utf8"), privateKeyPem).toString("base64");
  return [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="manifest"',
    "Content-Type: application/json; charset=utf-8",
    `expo-signature: sig="${sig}", keyid="${KEY_ID}", alg="${ALG}"`,
    "",
    json,
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

/** Writes the channel's directory: each platform's signed manifest and the files they name. */
export function publish(opts: {
  dist: string;
  out: string;
  url: string;
  channel: string;
  privateKeyPem: string;
  runtimes: Partial<Record<Platform, string>>;
  createdAt: string;
  expoClient?: unknown;
}): { platform: Platform; manifest: Manifest }[] {
  const written: { platform: Platform; manifest: Manifest }[] = [];
  for (const [platform, runtimeVersion] of Object.entries(opts.runtimes) as [Platform, string][]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runtimeVersion)) throw new Error(`runtime version ${runtimeVersion} isn't one site/vercel.json routes`);
    const { manifest: m, files } = manifest({ ...opts, platform, runtimeVersion });
    for (const [from, to] of files) {
      mkdirSync(dirname(join(opts.out, to)), { recursive: true });
      copyFileSync(join(opts.dist, from), join(opts.out, to));
    }
    mkdirSync(join(opts.out, runtimeVersion), { recursive: true });
    writeFileSync(join(opts.out, runtimeVersion, platform), signedBody(m, opts.privateKeyPem));
    written.push({ platform, manifest: m });
  }
  writeFileSync(join(opts.out, "updates.txt"), written.map((w) => `${w.platform} ${w.manifest.runtimeVersion} ${w.manifest.id}\n`).join(""));
  return written;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      dist: { type: "string", default: "dist" },
      out: { type: "string" },
      url: { type: "string" },
      channel: { type: "string" },
      key: { type: "string" },
      config: { type: "string" },
      runtime: { type: "string", multiple: true },
    },
  });
  const { out, url, channel, key } = values;
  if (!out || !url || !channel || !key || !values.runtime?.length) {
    throw new Error("usage: updates.ts --out <dir> --url <update URL> --channel <name> --key <pem> --runtime <platform>=<version>...");
  }
  const runtimes: Partial<Record<Platform, string>> = {};
  for (const r of values.runtime) {
    const [platform, version] = r.split("=", 2);
    if ((platform !== "ios" && platform !== "android") || !version) throw new Error(`--runtime ${r}: want ios=<version> or android=<version>`);
    runtimes[platform] = version;
  }
  for (const { platform, manifest: m } of publish({
    dist: values.dist,
    out,
    url,
    channel,
    privateKeyPem: readFileSync(key, "utf8"),
    runtimes,
    createdAt: new Date().toISOString(),
    expoClient: values.config === undefined ? undefined : JSON.parse(readFileSync(values.config, "utf8")),
  })) {
    console.log(`${channel} ${platform} ${m.runtimeVersion}: update ${m.id}`);
  }
}
