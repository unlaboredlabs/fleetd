// fleetd's icon on every surface, rendered from its masters in app/icon/ (Peek: Pebble close up, rising from the
// bottom edge of a pale wall; decision ui.app-icon). The masters are drawn by hand, each for its frame:
// - mac.svg: the macOS tile (824 on the 1024 grid, continuous corners, a soft shadow and light catching its top edge);
//   mac-small.svg: the same, redrawn for 16 and 32 px (a bigger figure, larger eyes, no shading, shadow or rim).
// - ios-light.svg, ios-dark.svg, ios-tinted.svg: full bleed, for iOS's three appearances.
// - android-foreground.svg, -background.svg, -monochrome.svg: the adaptive icon's layers, the art in the middle 72 of
//   the 108 dp layer, which the launcher's mask crops.
// - silhouette.svg: Pebble whole in black, its eyes cut out, for the menu bar and notifications.
// - tab.svg: Pebble whole on its tile, drawn for a browser tab at 16 and 32 px (cropped at the tile's edge, the
//   app icon reads as a cut-off picture there).
//
// It writes:
// - app/mobile/assets/: icon.png, icon-dark.png and icon-tinted.png (1024, opaque, as the App Store asks), the
//   adaptive icon's three layers, notification-icon.png (the silhouette in white) and splash-icon.png (the tile).
// - app/desktop/build/: icon.png (the tile at 1024), icon.icns (macOS, every size from 32 px, the small master at 32)
//   and icons/<n>x<n>.png (Linux, the same).
// - app/desktop/src/main/trayIcon.ts: the menu bar's template image, at 1x and 2x.
// - The favicons: tab.svg as site/icon.svg (fleetd.sh), docs/site/public/favicon.svg and the web app's
//   public/favicon.svg, and the .ico of it (16, 32 and 48 px) for the web app and fleetd.sh.
// - site/apple-touch-icon.png: fleetd.sh's home-screen icon, the iOS icon at 180 px.
// - The web app's install icons in app/desktop/src/web/public/: icon-192.png and icon-512.png (the tile) and
//   icon-maskable-512.png (the iOS icon, full bleed).
// - docs/site/src/assets/icon.svg, the docs' logo: the small master, cropped to its tile.
//
//   npm run icons
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";

const repo = new URL("../../../", import.meta.url);
const master = (name: string): string => readFileSync(new URL(`app/icon/${name}.svg`, repo), "utf8");

// The masters have no text: no fonts to load.
const render = (source: string, size: number) => new Resvg(source, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } }).render();
const png = (source: string, size: number): Buffer => render(source, size).asPng();

const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** An RGB PNG, no alpha channel: what an iOS app icon must be. */
const opaquePng = (source: string, size: number): Buffer => {
  // Read once: each read of `pixels` copies them.
  const pixels = render(source, size).pixels;
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      pixels.copy(rows, y * (size * 3 + 1) + 1 + x * 3, from, from + 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
};

/** An .icns of PNGs, by type: each entry its type, its length (header included) and its PNG. */
const icns = (entries: readonly (readonly [string, Buffer])[]): Buffer => {
  const parts = entries.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
};

/** An .ico of PNGs, by size: its header, then each one's size, colour depth, length and offset, then the PNGs. */
const ico = (entries: readonly (readonly [number, Buffer])[]): Buffer => {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = entries.map(([size, data]) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size, 0);
    entry.writeUInt8(size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([head, ...dir, ...entries.map(([, data]) => data)]);
};

const write = (path: string, data: Buffer | string): void => {
  writeFileSync(new URL(path, repo), data);
  console.log(path);
};

/** `source` scaled by `k` about the middle of its 1024 box. */
const scaled = (source: string, k: number): string =>
  source.replace(/(<svg [^>]*>)([\s\S]*)<\/svg>/u, `$1<g transform="translate(512 512) scale(${String(k)}) translate(-512 -512)">$2</g></svg>`);

const mac = master("mac");
const macSmall = master("mac-small");
const silhouette = master("silhouette");
/** The tile at `size` px: the small master at 16 and 32. */
const tile = (size: number): Buffer => png(size <= 32 ? macSmall : mac, size);

// The phone.
write("app/mobile/assets/icon.png", opaquePng(master("ios-light"), 1024));
write("app/mobile/assets/icon-dark.png", opaquePng(master("ios-dark"), 1024));
write("app/mobile/assets/icon-tinted.png", opaquePng(master("ios-tinted"), 1024));
write("app/mobile/assets/android-icon-foreground.png", png(master("android-foreground"), 1024));
write("app/mobile/assets/android-icon-background.png", opaquePng(master("android-background"), 1024));
write("app/mobile/assets/android-icon-monochrome.png", png(master("android-monochrome"), 1024));
write("app/mobile/assets/notification-icon.png", png(scaled(silhouette.replace(/fill="#000"/u, 'fill="#fff"'), 0.9), 96));
write("app/mobile/assets/splash-icon.png", png(mac, 1024));

// The desktop app.
write("app/desktop/build/icon.png", tile(1024));
// The types macOS reads PNGs from: 32, 64, 128, 256, 512 and 1024 px, as 1x and 2x of the point sizes. Not icp4 and
// icp5 (16 and 32 px at 1x): macOS decodes a PNG there as coloured noise, which showed as fleetd's 16 pt icon in Finder
// and a disk image's title bar; 16 and 32 pt come from ic11 and ic12 (the small master at 32 px, and 64) instead.
write(
  "app/desktop/build/icon.icns",
  icns([
    ["ic11", tile(32)],
    ["ic12", tile(64)],
    ["ic07", tile(128)],
    ["ic13", tile(256)],
    ["ic08", tile(256)],
    ["ic14", tile(512)],
    ["ic09", tile(512)],
    ["ic10", tile(1024)],
  ]),
);
mkdirSync(new URL("app/desktop/build/icons/", repo), { recursive: true });
for (const size of [16, 32, 48, 64, 128, 256, 512]) write(`app/desktop/build/icons/${String(size)}x${String(size)}.png`, tile(size));
// The menu bar's: 18 pt, Pebble 14 pt wide, black on clear for macOS to tint.
const tray = scaled(silhouette, 0.83);
const trayFile = "app/desktop/src/main/trayIcon.ts";
const trayTs = readFileSync(new URL(trayFile, repo), "utf8")
  .replace(/const AT_1X = "[^"]*";/u, `const AT_1X = "data:image/png;base64,${png(tray, 18).toString("base64")}";`)
  .replace(/const AT_2X = "[^"]*";/u, `const AT_2X = "data:image/png;base64,${png(tray, 36).toString("base64")}";`);
write(trayFile, trayTs);

// The favicons: the tab's master, and the .ico of it for what asks /favicon.ico itself.
const tab = master("tab");
for (const path of ["site/icon.svg", "docs/site/public/favicon.svg", "app/desktop/src/web/public/favicon.svg"]) write(path, tab);
const favicon = ico([16, 32, 48].map((size) => [size, png(tab, size)] as const));
for (const path of ["site/favicon.ico", "app/desktop/src/web/public/favicon.ico"]) write(path, favicon);
write("site/apple-touch-icon.png", opaquePng(master("ios-light"), 180));
// The web app's install icons (its manifest.webmanifest): the tile, as the desktop app's, for a dock or a taskbar; and
// the iOS icon, full bleed, as the "maskable" one a phone's launcher crops to its own shape.
for (const size of [192, 512]) write(`app/desktop/src/web/public/icon-${String(size)}.png`, tile(size));
write("app/desktop/src/web/public/icon-maskable-512.png", opaquePng(master("ios-light"), 512));
// The docs' logo: the small master's tile, edge to edge.
write("docs/site/src/assets/icon.svg", macSmall.replace(/ width="1024" height="1024" viewBox="0 0 1024 1024"/u, ' viewBox="100 100 824 824"'));
