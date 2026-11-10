// The designs: the profile picture an SVG on a 1024 grid, the banner a 1500×500 page. Colours and type are the landing
// page's (site/home.html: its paper, IBM Plex Sans SemiBold set tight); Pebble is the app's own (pebble.ts), in the
// app icon's paint (app/icon/ios-dark.svg).
import { readFileSync } from "node:fs";
import { pebble } from "./pebble";

/** The landing page's face, inlined, so the banner renders the same anywhere. */
const FONT = `@font-face{font-family:"Plex";src:url(data:font/woff2;base64,${readFileSync(new URL("../../fonts/plex-sans-SemiBold.woff2", import.meta.url)).toString("base64")}) format("woff2");font-weight:600}`;

/** The landing page's dark paper (site/home.html's :root). */
const PAPER = "#121212";

/** The app icon's paint: Pebble's body top to bottom, and its eyes with the lid's faint shade. */
const ICON_DEFS = `
<linearGradient id="slate" x1="0" y1="22" x2="0" y2="85" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#748bac"/><stop offset="1" stop-color="#5b7499"/></linearGradient>
<linearGradient id="eye" x1="0" y1="50" x2="0" y2="66" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#d9dee6"/><stop offset=".45" stop-color="#f9fcff"/></linearGradient>`;

/** Pebble at `k` times the rig's box, its optical centre (50, 54.6: shared/bot.ts's CROP) at (x, y). */
const centred = (k: number, x: number, y: number, inner: string): string => `<g transform="translate(${String(x - 50 * k)} ${String(y - 54.6 * k)}) scale(${String(k)})">${inner}</g>`;

/**
 * The profile picture: the app icon's Pebble on the landing page's dark paper, whole and big in the circle X cuts (72%
 * of its width, clear of the edge all round). Its eyes are a touch larger than the app draws them (1.12), so they hold
 * at 32 px.
 */
export const avatar = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>${ICON_DEFS}</defs><rect width="1024" height="1024" fill="${PAPER}"/>${centred(10.4, 512, 512, pebble({ body: "url(#slate)", eye: "url(#eye)", eyes: 1.12 }))}</svg>`;

/** The banner's ground: a shade under the landing page's paper, so a light has somewhere to fall. */
const GROUND = "#101011";

/** Fine grain over the whole banner: it keeps the dark from banding and gives the ground a surface. */
const GRAIN = `<svg class="a" width="1500" height="500"><filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="11"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  .12 0 0 0 -.05"/></filter><rect width="1500" height="500" filter="url(#grain)"/></svg>`;

/**
 * The banner. It has nothing to read: X sets the name right under it. It is the name as material, as large as the
 * banner holds, a tone above the ground, lit in Pebble's slate from the lower left, where X sets the profile picture:
 * bright beside the picture, gone by the far end, so the picture's Pebble is the lamp and the banner what it lights.
 * Each letter is drawn twice, a brighter one a pixel and a half toward the light under the face, which gives it a lit
 * edge. The phone cuts about 100 px off each side and lays its clock, island and round buttons over the top: at 570 px
 * the name still shows from its f to its d there.
 */
export const banner = `<!doctype html><meta charset="utf-8"><style>
${FONT}
html,body{margin:0}
body{width:1500px;height:500px;overflow:hidden;position:relative;background:${GROUND};font-family:"Plex";font-weight:600;font-kerning:normal;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.a{position:absolute;inset:0}
.glow{background:radial-gradient(52% 130% at 15% 100%,rgba(116,139,172,.22),rgba(116,139,172,.06) 50%,transparent 75%)}
.w{inset:auto;left:50%;top:-38px;transform:translateX(-50%);font-size:570px;line-height:1;letter-spacing:-.055em;white-space:nowrap;-webkit-background-clip:text;background-clip:text;color:transparent}
.edge{margin:1.5px 0 0 -1.5px;background-image:radial-gradient(62% 150% at 10% 89%,#9fb0cb,#586680 30%,#33363b 62%,#2c2d31 88%)}
.face{background-image:radial-gradient(64% 150% at 10% 89%,#516078,#333b48 30%,#25272b 60%,#222326 88%)}
</style><body><div class="a glow"></div><div class="a w edge">fleetd</div><div class="a w face">fleetd</div>${GRAIN}`;
