// Builds the phone web app into dist/ (static files the hub serves at /), checks its size, and copies it into the
// hub's dist/pwa. Icons are drawn here, so the app has no external assets.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crc32, deflateSync, gzipSync } from "node:zlib";
import { build } from "rolldown";

/** Everything a visit loads before the first tap: page, app, service worker, manifest. */
const BUDGET_INITIAL = 60 * 1024;
/** libsodium, loaded only to seal a secret. A ceiling so it can't grow unnoticed. */
const BUDGET_LAZY = 160 * 1024;

const here = (path: string) => new URL(path, import.meta.url).pathname;
const dist = here("./dist/");
const hubCopy = here("../hub/dist/pwa/");

const THEME = { dark: "#1b1c1f", accent: "#6ea8fe" };

rmSync(dist, { recursive: true, force: true });
await build([
  {
    input: { app: here("./src/main.tsx") },
    platform: "browser",
    output: { dir: dist, format: "esm", minify: true, entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
  },
  { input: here("./src/sw.ts"), platform: "browser", output: { file: `${dist}sw.js`, format: "iife", minify: true } },
]);

writeFileSync(`${dist}index.html`, readFileSync(here("./src/index.html")));
writeFileSync(
  `${dist}manifest.webmanifest`,
  JSON.stringify({
    name: "fleetd",
    short_name: "fleetd",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: THEME.dark,
    theme_color: THEME.dark,
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  }),
);

// The icon: three dots (a fleet) on a full-bleed square, inside the maskable safe zone.
const DOTS = [0.3, 0.5, 0.7].map((x) => ({ x, y: 0.5, r: 0.085 }));
writeFileSync(
  `${dist}icon.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${THEME.dark}"/>${DOTS.map(
    (d) => `<circle cx="${d.x * 100}" cy="${d.y * 100}" r="${d.r * 100}" fill="${THEME.accent}"/>`,
  ).join("")}</svg>`,
);

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

/** An RGB PNG of the icon, 4x4 supersampled for smooth edges. */
const png = (size: number) => {
  const [bg, fg] = [rgb(THEME.dark), rgb(THEME.accent)];
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let s = 0; s < 16; s++) {
        const px = (x + ((s % 4) + 0.5) / 4) / size;
        const py = (y + (Math.floor(s / 4) + 0.5) / 4) / size;
        if (DOTS.some((d) => (px - d.x) ** 2 + (py - d.y) ** 2 <= d.r ** 2)) hits++;
      }
      for (let c = 0; c < 3; c++) rows[y * (size * 3 + 1) + 1 + x * 3 + c] = Math.round(bg[c]! + ((fg[c]! - bg[c]!) * hits) / 16);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
for (const size of [192, 512]) writeFileSync(`${dist}icon-${size}.png`, png(size));

const gz = (file: string) => gzipSync(readFileSync(`${dist}${file}`), { level: 9 }).length;
const initial = ["index.html", "app.js", "sw.js", "manifest.webmanifest"];
const lazy = readdirSync(dist).filter((file) => file.endsWith(".js") && !initial.includes(file));
const initialBytes = initial.reduce((sum, file) => sum + gz(file), 0);
const lazyBytes = lazy.reduce((sum, file) => sum + gz(file), 0);
const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
console.log(`pwa: initial ${kib(initialBytes)} gzipped (budget ${kib(BUDGET_INITIAL)}): ${initial.map((f) => `${f} ${kib(gz(f))}`).join(", ")}`);
console.log(`pwa: on demand ${kib(lazyBytes)} gzipped (budget ${kib(BUDGET_LAZY)}): ${lazy.join(", ")}`);
if (initialBytes > BUDGET_INITIAL || lazyBytes > BUDGET_LAZY) {
  console.error("pwa: over the size budget");
  process.exit(1);
}

rmSync(hubCopy, { recursive: true, force: true });
mkdirSync(hubCopy, { recursive: true });
cpSync(dist, hubCopy, { recursive: true });
