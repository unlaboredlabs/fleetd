// The Rounds, polished: one hand-tuned body shared by every being, crafted eyes, and three finishes to choose from.
//
// The body is a squircle with its weight low: widest below its middle, a fuller curve at the bottom than the top, so
// it sits rather than floats. Eyes are soft tilted ovals with a shine, or tapered lids that thin to points.
// Finishes: "flat" (the shapes alone), "soft" (a top light on the body, a rim of light, a contact shadow) and "glass"
// (a frosted pale body tinted by the field behind it, dark eyes, a specular highlight and a bright edge, like iOS 26's
// Liquid Glass).

const TOP = 25;
const BOTTOM = 79;
const WAIST = 55;
const HALF = 29;

/** The body: a squircle from TOP to BOTTOM, widest at WAIST, rounder at the top than at its heavier bottom. */
const BODY = (() => {
  const up = WAIST - TOP;
  const down = BOTTOM - WAIST;
  const r = (n) => +n.toFixed(2);
  return (
    `M50 ${TOP}C${r(50 + 0.6 * HALF)} ${TOP} ${50 + HALF} ${r(WAIST - 0.6 * up)} ${50 + HALF} ${WAIST}` +
    `C${50 + HALF} ${r(WAIST + 0.7 * down)} ${r(50 + 0.7 * HALF)} ${BOTTOM} 50 ${BOTTOM}` +
    `C${r(50 - 0.7 * HALF)} ${BOTTOM} ${50 - HALF} ${r(WAIST + 0.7 * down)} ${50 - HALF} ${WAIST}` +
    `C${50 - HALF} ${r(WAIST - 0.6 * up)} ${r(50 - 0.6 * HALF)} ${TOP} 50 ${TOP}Z`
  );
})();

/** How much larger an eye is drawn than its numbers, so faces hold at 24px. */
const GROW = 1.12;

/** An open eye: a soft oval tilted by `tilt` degrees, with a shine up and to the right. */
const eye = (x, y, w, h, tilt = 0, shine = true, rx = w * GROW, ry = h * GROW) =>
  `<ellipse {E} cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" transform="rotate(${tilt} ${x} ${y})"/>` +
  (shine ? `<circle {H} cx="${+(x + rx * 0.32).toFixed(2)}" cy="${+(y - ry * 0.38).toFixed(2)}" r="${+(rx * 0.3).toFixed(2)}"/>` : "");

/** A shut eye: a crescent from x1 to x2 that bows by `depth` (down for a doze, negative for a smile) and thins to
 * softly rounded tips at both ends, `thick` across at its middle. */
const lid = (x1, x2, y, depth, thick = 5.4) => {
  const m = (x1 + x2) / 2;
  const inner = depth > 0 ? y + depth - 2 * thick : y + depth + 2 * thick;
  return `<path {E} {K} stroke-width="1.8" stroke-linejoin="round" d="M${x1} ${y}Q${m} ${y + depth} ${x2} ${y}Q${m} ${inner} ${x1} ${y}Z"/>`;
};

/** An eye with its top shut flat along a line from (x1, y1) to (x2, y2): a half-lidded look. */
const lidded = (x, y, rx, ry, x1, y1, x2, y2) =>
  `<clipPath id="lid-{ID}"><path d="M${x1} ${y1}L${x2} ${y2}V100H${x1}Z"/></clipPath>` +
  `<g clip-path="url(#lid-{ID})">${eye(x, y, rx, ry, 0, false)}</g>`;

export const ROUNDS = [
  { id: "A1", name: "Mo", mood: "calm", face: eye(40, 50, 4.3, 5.6, -6) + eye(60, 50, 4.3, 5.6, 6) },
  { id: "A2", name: "Wee", mood: "shy", face: eye(45, 59, 3.4, 4.4, -4) + eye(55, 59, 3.4, 4.4, 4) },
  { id: "A3", name: "Peep", mood: "curious", face: eye(56, 45, 4.4, 5.8, 4) + eye(69.5, 45.5, 3.8, 5.1, 8) },
  { id: "A4", name: "Nap", mood: "sleepy", face: lid(32, 46, 50, 7) + lid(54, 68, 50, 7) },
  { id: "A5", name: "Cy", mood: "focused", face: eye(53, 46, 6.6, 8.2, 4) },
  { id: "A6", name: "Wink", mood: "cheeky", face: eye(40, 50, 4.3, 5.6, -6) + lid(53, 68, 55, -10) },
  { id: "A7", name: "Joy", mood: "delighted", face: lid(31, 46, 56, -11) + lid(54, 69, 56, -11), fresh: true },
  { id: "A8", name: "Huh", mood: "skeptical", face: eye(40, 50, 4.3, 5.6, -6) + lidded(60, 51, 4.6, 5.6, 52, 48.5, 68, 50.5), fresh: true },
  {
    id: "A9",
    name: "Wow",
    mood: "amazed",
    face: eye(38, 47, 5, 5.8, -4) + eye(62, 47, 5, 5.8, 4) + `<ellipse {E} cx="50" cy="64" rx="3" ry="3.8"/>`,
    fresh: true,
  },
];

export const FINISHES = [
  { id: "flat", name: "Refined flat", about: "Crafted curves and eye shine, no gradient." },
  { id: "soft", name: "Soft light", about: "A gentle top light, a rim of light and a soft contact shadow." },
  { id: "glass", name: "Glass", about: "A frosted body tinted by its field, with a specular highlight and a bright edge, like iOS 26's Liquid Glass." },
];

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
/** `a` moved toward `b` by t (0–1). */
const mix = (a, b, t) =>
  `#${hex(a)
    .map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, "0"))
    .join("")}`;

let drawn = 0;

/** One Round as a standalone SVG string, `size` pixels square, in a palette colour and a finish. */
export function roundSvg(being, colour, size = 100, finish = "flat") {
  const id = `r${++drawn}`;
  const { field, mark } = colour;
  // Glass is always pale, so its eyes are the field taken dark.
  const ink = finish === "glass" ? mix(field, "#000000", 0.55) : field;
  const face = being.face.replaceAll("{ID}", id).replaceAll("{E}", `fill="${ink}"`).replaceAll("{K}", `stroke="${ink}"`).replaceAll("{H}", `fill="#fff" fill-opacity=".9"`);
  const ring = `<clipPath id="f-${id}"><circle cx="50" cy="50" r="50"/></clipPath><clipPath id="b-${id}"><path d="${BODY}"/></clipPath>`;
  let defs = ring;
  let ground = `<circle cx="50" cy="50" r="50" fill="${field}"/>`;
  let body = `<path d="${BODY}" fill="${mark}"/>`;
  if (finish === "soft") {
    defs +=
      `<linearGradient id="g-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(field, "#ffffff", 0.1)}"/>` +
      `<stop offset="1" stop-color="${mix(field, "#000000", 0.06)}"/></linearGradient>` +
      `<linearGradient id="t-${id}" x1="0" y1="${TOP}" x2="0" y2="${BOTTOM}" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="${mix(mark, "#ffffff", 0.2)}"/><stop offset="1" stop-color="${mix(mark, "#000000", 0.12)}"/></linearGradient>` +
      `<linearGradient id="rim-${id}" x1="0" y1="${TOP}" x2="0" y2="${BOTTOM}" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
      `<filter id="s-${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8"/></filter>`;
    ground = `<circle cx="50" cy="50" r="50" fill="url(#g-${id})"/>`;
    body =
      `<ellipse cx="50" cy="${BOTTOM + 1.5}" rx="21" ry="3.4" fill="#000" fill-opacity=".2" filter="url(#s-${id})"/>` +
      `<path d="${BODY}" fill="url(#t-${id})"/>` +
      `<path d="${BODY}" fill="none" stroke="url(#rim-${id})" stroke-width="2.4" clip-path="url(#b-${id})"/>`;
  }
  if (finish === "glass") {
    defs +=
      `<radialGradient id="g-${id}" cx=".3" cy=".2" r="1"><stop offset="0" stop-color="${mix(field, "#ffffff", 0.16)}"/>` +
      `<stop offset="1" stop-color="${mix(field, "#000000", 0.1)}"/></radialGradient>` +
      `<linearGradient id="sheen-${id}" x1="0" y1="${TOP}" x2="0" y2="${BOTTOM}" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/>` +
      `<stop offset="1" stop-color="#000" stop-opacity=".1"/></linearGradient>` +
      `<linearGradient id="edge-${id}" x1="25" y1="${TOP}" x2="75" y2="${BOTTOM}" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".5" stop-color="#fff" stop-opacity=".15"/>` +
      `<stop offset="1" stop-color="#fff" stop-opacity=".55"/></linearGradient>` +
      `<filter id="s-${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter>` +
      `<filter id="h-${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.1"/></filter>`;
    ground = `<circle cx="50" cy="50" r="50" fill="url(#g-${id})"/>`;
    body =
      `<ellipse cx="50" cy="${BOTTOM + 2}" rx="22" ry="3.6" fill="#000" fill-opacity=".22" filter="url(#s-${id})"/>` +
      `<path d="${BODY}" fill="${mix(field, "#ffffff", 0.75)}" fill-opacity=".86"/>` +
      `<path d="${BODY}" fill="url(#sheen-${id})"/>` +
      `<g clip-path="url(#b-${id})"><ellipse cx="38" cy="32" rx="13" ry="5" transform="rotate(-24 38 32)" fill="#fff" fill-opacity=".55" filter="url(#h-${id})"/>` +
      `<path d="${BODY}" fill="none" stroke="url(#edge-${id})" stroke-width="2.6"/></g>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"><defs>${defs}</defs>` +
    `<g clip-path="url(#f-${id})">${ground}${body}${face}</g></svg>`
  );
}
