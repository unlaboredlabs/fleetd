// The app's icons, rendered from fleetd's mark (site/icon.svg, the desktop app's: three chevrons in #6ea8fe at rising
// opacity on #1b1c1f) into assets/, which app.config.ts names:
// - icon.png: iOS's, 1024 full bleed and opaque (no alpha channel, as the App Store asks), the chevrons a little
//   larger than in the desktop's tile so they still read at 29 pt. icon-dark.png and icon-tinted.png: iOS 18's dark
//   (the chevrons on transparent, over the system's dark) and tinted (grey levels on black, which iOS tints).
// - android-icon-foreground.png, -background.png and -monochrome.png: the adaptive icon, its chevrons inside the
//   middle two thirds that every launcher's mask keeps; notification-icon.png: the chevrons in white, for the status bar.
// - splash-icon.png: the desktop's tile as it is, on the splash screen's plain ground; favicon.png for the web.
//
//   npm run icons
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";

const root = new URL("..", import.meta.url);
const mark = readFileSync(new URL("../../site/icon.svg", root), "utf8");
const BG = "#1b1c1f";
const CHEVRONS = /<g [\s\S]*<\/g>/u.exec(mark)?.[0];
if (CHEVRONS === undefined) throw new Error("site/icon.svg has no chevrons group");

/** The chevrons in `color` (each keeping its opacity unless `solid`), scaled by `scale` about the middle. */
const chevrons = (color: string, scale: number, solid = false): string => {
  const g = CHEVRONS.replace(/stroke="#[0-9a-f]{6}"/iu, `stroke="${color}"`).replace("<g ", `<g transform="translate(512 512) scale(${String(scale)}) translate(-512 -512)" `);
  return solid ? g.replace(/ opacity="[.\d]+"/gu, "") : g;
};

const svg = (body: string, ground?: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${ground === undefined ? "" : `<rect width="1024" height="1024" fill="${ground}"/>`}${body}</svg>`;

// The mark has no text: no fonts to load.
const render = (source: string, size: number) => new Resvg(source, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } }).render();

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

const write = (name: string, data: Buffer): void => {
  writeFileSync(new URL(`assets/${name}`, root), data);
  console.log(`assets/${name}`);
};

// iOS: the desktop tile's chevrons are 1.243× at full bleed; 1.12× leaves them room and keeps them bold.
const IOS = 1.12;
write("icon.png", opaquePng(svg(chevrons("#6ea8fe", IOS), BG), 1024));
write("icon-dark.png", render(svg(chevrons("#6ea8fe", IOS)), 1024).asPng());
write("icon-tinted.png", opaquePng(svg(chevrons("#ffffff", IOS), "#000000"), 1024));
write("favicon.png", opaquePng(svg(chevrons("#6ea8fe", IOS), BG), 48));
// Android: inside the middle two thirds of the 108 dp layer.
const ANDROID = 0.82;
write("android-icon-foreground.png", render(svg(chevrons("#6ea8fe", ANDROID)), 1024).asPng());
write("android-icon-background.png", opaquePng(svg("", BG), 1024));
write("android-icon-monochrome.png", render(svg(chevrons("#ffffff", ANDROID, true)), 1024).asPng());
write("notification-icon.png", render(svg(chevrons("#ffffff", 1.3, true)), 96).asPng());
write("splash-icon.png", render(mark, 1024).asPng());
