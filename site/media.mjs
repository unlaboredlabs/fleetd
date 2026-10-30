// The landing page's clips and posters (showcase-*.{webm,mp4,jpg}) on Cloudflare R2 (D240, site/README.md, Media).
// Each file is the object <name>.<first 16 hex of its sha256>.<ext> in the fleetd-media bucket, served at BASE: a
// new recording gets new names, so the immutable cache never serves a stale clip.
//
//   node site/media.mjs upload     CI on main (.github/workflows/site-media.yml): puts each file the bucket doesn't hold
//                                  yet, with a year's immutable Cache-Control, then, while production's page still
//                                  serves any of them from Vercel, calls the SITE_DEPLOY_HOOK so it switches. Skips,
//                                  and passes, while the R2 secrets aren't set.
//   node media.mjs build           the Vercel build (vercel.json, from site/): points home.html at each file BASE already
//                                  serves; the rest stay on the repo's own files. So the page never names an object the
//                                  upload hasn't finished. Never fails the build.
//   node media.mjs unchanged       with mobile-updates.sh's, the Ignored Build Step: exits 1 (build) when production's
//                                  page still serves a file from Vercel that BASE now has.
//   node site/media.mjs check      CI's `site` job (.github/site-check.mjs): every media file home.html names is in the
//                                  upload set, and a build with all of them uploaded leaves none on Vercel.
//
// Without a build (a local preview, docs-serve.mjs, CI's layout check) home.html loads the repo's files.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the bucket is served: the one place to change it.
const BASE = "https://media.unlabored.net";
const BUCKET = "fleetd-media";
const SITE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(SITE, "home.html");
const TYPES = { jpg: "image/jpeg", mp4: "video/mp4", webm: "video/webm" };
const MEDIA = /^showcase-[a-z0-9-]+\.(jpg|mp4|webm)$/u;
// A path to a media file in an attribute (src, srcset): "/showcase-x.jpg" or "..., /showcase-x.jpg 2800w".
const LITERAL = /(?<=["'\s,=])\/(showcase-[a-z0-9-]+\.(?:jpg|mp4|webm))(?=[\s"',>])/gu;
// The clips' script picks a clip by name from this map, filled by the build; empty, it loads /<name>.
const MAP = "var fleetdMedia={};";

/** The upload set: each media file in site/, by name, with its object key and Content-Type. */
function files() {
  return fs
    .readdirSync(SITE)
    .filter((name) => MEDIA.test(name))
    .sort()
    .map((name) => {
      const hash = createHash("sha256").update(fs.readFileSync(path.join(SITE, name))).digest("hex").slice(0, 16);
      const dot = name.lastIndexOf(".");
      const ext = name.slice(dot + 1);
      return { name, key: `${name.slice(0, dot)}.${hash}.${ext}`, type: TYPES[ext] };
    });
}

/** home.html with each media file in `urls` (name -> URL) loaded from there, and the rest from site/. */
function rewrite(html, urls) {
  const clips = Object.fromEntries([...urls].filter(([name]) => !name.endsWith(".jpg")));
  return html.replace(LITERAL, (whole, name) => urls.get(name) ?? whole).replace(MAP, `var fleetdMedia=${JSON.stringify(clips)};`);
}

/** The media file names home.html loads: its attribute paths (and og:image), and each clip's in both themes and sizes. */
function referenced(html) {
  const names = new Set([...html.matchAll(/showcase-[a-z0-9-]+\.(?:jpg|mp4|webm)/gu)].map((m) => m[0]));
  for (const [, clip] of html.matchAll(/data-clip="([a-z0-9-]+)"/gu))
    for (const theme of ["light", "dark"])
      for (const size of ["", "-small"]) for (const ext of ["webm", "mp4"]) names.add(`showcase-${clip}-${theme}${size}.${ext}`);
  return names;
}

/** name -> URL for each file BASE already serves. A query string skips Cloudflare's cache of an earlier 404. */
async function served() {
  const probe = Date.now();
  const urls = new Map();
  await Promise.all(
    files().map(async ({ name, key }) => {
      const url = `${BASE}/${key}`;
      try {
        const res = await fetch(`${url}?probe=${probe}`, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
        if (res.ok) urls.set(name, url);
      } catch {}
    }),
  );
  return urls;
}

async function upload() {
  const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: id, R2_SECRET_ACCESS_KEY: secret } = process.env;
  const missing = [["R2_ACCOUNT_ID variable", account], ["R2_ACCESS_KEY_ID secret", id], ["R2_SECRET_ACCESS_KEY secret", secret]]
    .filter(([, value]) => !value)
    .map(([what]) => what);
  if (missing.length > 0) {
    console.log(`::notice::Media upload skipped: no ${missing.join(", ")}. fleetd.sh serves its clips from Vercel until they're set (site/README.md, Media).`);
    return;
  }
  // R2 takes no region, and wants checksums only where the S3 API requires them. The keys reach aws through its
  // environment only; nothing here prints them.
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: id,
    AWS_SECRET_ACCESS_KEY: secret,
    AWS_DEFAULT_REGION: "auto",
    AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
    AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
  };
  const aws = (...args) =>
    execFileSync("aws", [...args, "--endpoint-url", `https://${account}.r2.cloudflarestorage.com`, "--output", "json"], {
      env,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
  const held = new Set(JSON.parse(aws("s3api", "list-objects-v2", "--bucket", BUCKET, "--prefix", "showcase-", "--query", "Contents[].Key") || "null") ?? []);
  const all = files();
  const fresh = all.filter(({ key }) => !held.has(key));
  for (const { name, key, type } of fresh) {
    aws("s3api", "put-object", "--bucket", BUCKET, "--key", key, "--body", path.join(SITE, name), "--content-type", type, "--cache-control", "public, max-age=31536000, immutable");
    console.log(`uploaded ${name} as ${BASE}/${key}`);
  }
  console.log(`media: ${fresh.length} uploaded, ${all.length - fresh.length} already in ${BUCKET}`);
  // The deploy that came with this push may have run before the upload finished, and kept these on Vercel; so may an
  // earlier run's, when the hook wasn't set then.
  if (await live(all.map(({ key }) => `${BASE}/${key}`))) {
    console.log("media: production already serves all of them from R2");
  } else if (process.env.SITE_DEPLOY_HOOK) {
    const res = await fetch(process.env.SITE_DEPLOY_HOOK, { method: "POST" });
    if (!res.ok) throw new Error(`the deploy hook answered ${res.status}`);
    console.log("media: asked Vercel for a fresh deploy of main");
  } else {
    console.log("::notice::No SITE_DEPLOY_HOOK secret: fleetd.sh switches to the new media with its next deploy.");
  }
}

async function build() {
  const urls = await served();
  if (urls.size > 0) fs.writeFileSync(PAGE, rewrite(fs.readFileSync(PAGE, "utf8"), urls));
  console.log(`media: ${urls.size} of ${files().length} from ${BASE}, the rest from site/`);
}

async function unchanged() {
  if (process.env.VERCEL_ENV !== "production") return 0;
  const urls = await served();
  if (urls.size === 0 || (await live([...urls.values()]))) return 0;
  console.log(`media: production still serves some of ${BASE}'s media from Vercel`);
  return 1;
}

/** Whether production's landing page names each of `urls`; false when it can't be read. */
async function live(urls) {
  try {
    const res = await fetch(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || "fleetd.sh"}/home`, { signal: AbortSignal.timeout(10_000) });
    const page = await res.text();
    return res.ok && urls.every((url) => page.includes(url));
  } catch {
    return false;
  }
}

function check() {
  const html = fs.readFileSync(PAGE, "utf8");
  const all = files();
  const set = new Set(all.map(({ name }) => name));
  const errors = [...referenced(html)].filter((name) => !set.has(name)).map((name) => `${name} isn't in site/, so it isn't uploaded`);
  if (!html.includes(MAP)) errors.push(`no \`${MAP}\` for the build to fill: the clips would stay on Vercel`);
  const built = rewrite(html, new Map(all.map(({ name, key }) => [name, `${BASE}/${key}`])));
  for (const [, name] of built.matchAll(LITERAL)) errors.push(`/${name} stays on Vercel after a build`);
  if (errors.length > 0) {
    console.error(`site/home.html's media:\n${errors.map((e) => `  ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`site/home.html names ${referenced(html).size} media files, all in the upload set of ${all.length}`);
}

const command = process.argv[2];
if (command === "upload") await upload();
else if (command === "build") await build();
else if (command === "unchanged") process.exit(await unchanged());
else if (command === "check") check();
else {
  console.error("usage: node media.mjs upload|build|unchanged|check");
  process.exit(2);
}
