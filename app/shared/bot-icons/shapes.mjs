// Bot icons: original shapes for a Navi's or a project's round avatar, in a 100×100 box on a round field.
//
// A shape's body is SVG with paint tokens, so one shape takes any palette colour:
//   {M}  the mark's fill            {S}  the mark at 55%, a second tone (a facet, a far side)
//   {F}  the field's fill, painted over the mark to cut it (a hole, a slot, a gap)
//   {MS} a stroke in the mark       {FS} a stroke in the field (a gap line, a closed eye)
//   {ID} an id unique to one drawn icon, for a clip path
// Marks are drawn in the box 20–80 and shown a tenth larger, clipped to the field, so a cut never shows past the circle.

/** A circle as path data, so it can sit in a compound path with fill-rule evenodd (a hole). */
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

/** A rounded rectangle as path data. */
const rect = (x, y, w, h, r) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
  `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;

/** The 3×3 grid of fleetd's state glyph, scaled up: cell i (0–8, row by row) as a rounded square. */
const CELL = 13;
const PITCH = 17.5;
const cell = (i) => rect(26 + (i % 3) * PITCH, 26 + Math.floor(i / 3) * PITCH, CELL, CELL, 3.5);
const grid = (cells) => `<path {M} d="${cells.map(cell).join("")}"/>`;

/** A semicircle spiral: half turns, all clockwise, of growing radius about two centres `step` apart. */
const spiral = (step, halves) => {
  const a = 50 - step;
  let x = a + step;
  let d = `M${x} 50`;
  for (let k = 1; k <= halves; k++) {
    const r = k * step;
    const c = k % 2 === 1 ? a : a + step;
    const to = x < c ? c + r : c - r;
    d += `A${r} ${r} 0 0 1 ${to} 50`;
    x = to;
  }
  return d;
};

export const FAMILIES = [
  {
    letter: "A",
    name: "Critters",
    about: "Soft geometric bodies with dot eyes: a little character, never a face in detail.",
    shapes: [
      { name: "Pebble", body: `<path {M} fill-rule="evenodd" d="${rect(25, 28, 50, 46, 21)}${circle(40, 47, 5)}${circle(57, 47, 5)}"/>` },
      {
        name: "Drop",
        body: `<path {M} fill-rule="evenodd" d="M50 21C58 33 70 44 70 58A20 20 0 1 1 30 58C30 44 42 33 50 21Z${circle(55, 58, 6)}"/>`,
      },
      {
        name: "Bean",
        body: `<path {M} fill-rule="evenodd" transform="rotate(-28 50 50)" d="${rect(21, 35, 58, 30, 15)}${circle(56, 46, 4.5)}${circle(67, 46, 4.5)}"/>`,
      },
      {
        name: "Mochi",
        body: `<path {M} fill-rule="evenodd" d="M30 74H70A4 4 0 0 0 74 70V58A24 24 0 0 0 26 58V70A4 4 0 0 0 30 74Z${circle(43, 59, 4.5)}${circle(57, 59, 4.5)}"/>`,
      },
      {
        name: "Cyclops",
        body: `<path {M} fill-rule="evenodd" d="${rect(26, 27, 48, 46, 17)}${circle(50, 50, 12)}"/><circle {M} cx="54" cy="48" r="5.5"/>`,
      },
      {
        name: "Peek",
        body: `<path {M} fill-rule="evenodd" d="${circle(50, 90, 37)}${circle(39, 70, 5)}${circle(61, 70, 5)}"/>`,
      },
      {
        name: "Sprout",
        body: `<path {M} fill-rule="evenodd" d="${rect(34, 41, 32, 35, 16)}${circle(44, 57, 4)}${circle(56, 57, 4)}"/><path {M} d="M50 37Q50 22 66 21Q66 36 50 37Z"/>`,
      },
      { name: "Doze", body: `<circle {M} cx="50" cy="51" r="26"/><path {FS} stroke-width="5" d="M36 50q5 6 10 0M54 50q5 6 10 0"/>` },
    ],
  },
  {
    letter: "B",
    name: "Orbits",
    about: "Two primitives held in a relation: apart, overlapping, offset, balanced.",
    shapes: [
      { name: "Planet", body: `<circle {M} cx="45" cy="55" r="21"/><circle {M} cx="72" cy="28" r="8"/>` },
      { name: "Link", body: `<path {M} fill-rule="evenodd" d="${circle(39, 50, 19)}${circle(61, 50, 19)}"/>` },
      {
        name: "Notch",
        body: `<g transform="rotate(-35 50 50)"><path {M} d="${rect(20, 37, 60, 26, 13)}"/><circle {F} cx="50" cy="37" r="8"/></g>`,
      },
      { name: "Shift", body: `<path {M} d="${rect(23, 31, 42, 16, 8)}${rect(35, 53, 42, 16, 8)}"/>` },
      { name: "Halo", body: `<circle {M} cx="50" cy="60" r="17"/><ellipse {MS} stroke-width="6" cx="50" cy="31" rx="17" ry="5"/>` },
      { name: "Slip", body: `<path {M} d="M22 47A24 24 0 0 1 70 47ZM30 53A24 24 0 0 0 78 53Z"/>` },
      { name: "Arch", body: `<path {MS} stroke-width="11" d="M30 66A20 20 0 0 1 70 66"/><circle {M} cx="50" cy="64" r="6"/>` },
      {
        name: "Balance",
        body: `<path {M} transform="rotate(-14 50 62)" d="${rect(22, 58, 56, 11, 5.5)}"/><circle {M} cx="61" cy="39" r="11"/>`,
      },
    ],
  },
  {
    letter: "C",
    name: "Grid",
    about: "fleetd's own 3×3 state glyph, grown up: lit cells make a figure.",
    shapes: [
      { name: "Five", body: grid([0, 2, 4, 6, 8]) },
      { name: "Plus", body: grid([1, 3, 4, 5, 7]) },
      { name: "Rise", body: grid([2, 4, 6]) },
      { name: "Steps", body: grid([2, 4, 5, 6, 7, 8]) },
      { name: "Ring", body: grid([0, 1, 2, 3, 5, 6, 7, 8]) },
      { name: "Face", body: grid([0, 2, 6, 7, 8]) },
      { name: "Hop", body: grid([0, 1, 4, 7, 8]) },
      { name: "Block", body: `<path {M} d="${rect(26, 26, 30.5, 30.5, 6)}${cell(8)}"/>` },
    ],
  },
  {
    letter: "D",
    name: "Strokes",
    about: "One thick round-capped line, drawn in a single gesture.",
    shapes: [
      { name: "Loop", body: `<path {MS} stroke-width="8" d="M23 64C40 66 60 56 60 42C60 31 42 30 42 43C42 57 60 66 77 60"/>` },
      { name: "Zig", body: `<path {MS} stroke-width="8" d="M25 41L37.5 59L50 41L62.5 59L75 41"/>` },
      { name: "Wave", body: `<path {MS} stroke-width="9" d="M24 55C32 37 42 37 50 50S68 63 76 45"/>` },
      { name: "Spiral", body: `<path {MS} stroke-width="7" d="${spiral(6, 4)}"/>` },
      { name: "Wink", body: `<path {MS} stroke-width="8" d="M32 56Q50 74 68 56"/><circle {M} cx="38" cy="38" r="6"/>` },
      { name: "Knot", body: `<path {MS} stroke-width="8" d="M50 50C58 38 76 36 76 50S58 62 50 50S24 36 24 50S42 62 50 50Z"/>` },
      { name: "Stair", body: `<path {MS} stroke-width="8" d="M27 72V58H42V44H58V30H73"/>` },
      { name: "Comet", body: `<path {MS} stroke-width="5" d="M24 74Q34 46 56 40"/><circle {M} cx="63" cy="37" r="11"/>` },
    ],
  },
  {
    letter: "E",
    name: "Cut-outs",
    about: "A solid form with a piece taken out: the field shows through.",
    shapes: [
      { name: "Crescent", body: `<circle {M} cx="50" cy="50" r="26"/><circle {F} cx="62" cy="40" r="20"/>` },
      { name: "Window", body: `<path {M} d="${rect(26, 26, 48, 48, 13)}"/><circle {F} cx="59" cy="41" r="8"/>` },
      { name: "Visor", body: `<path {M} d="${rect(26, 27, 48, 46, 15)}"/><path {F} d="${rect(33, 39, 34, 12, 6)}"/>` },
      { name: "Door", body: `<path {M} d="${rect(26, 26, 48, 48, 13)}"/><path {F} d="M41 78V62A9 9 0 0 1 59 62V78Z"/>` },
      { name: "Corner", body: `<path {M} d="${rect(26, 26, 48, 48, 10)}"/><circle {F} cx="74" cy="26" r="22"/>` },
      { name: "Eye", body: `<path {M} d="M21 50Q50 16 79 50Q50 84 21 50Z"/><circle {F} cx="50" cy="50" r="9"/>` },
      { name: "Hollow", body: `<circle {M} cx="50" cy="50" r="26"/><circle {F} cx="57" cy="43" r="11"/>` },
      { name: "Ticket", body: `<path {M} d="${rect(23, 31, 54, 38, 9)}"/><circle {F} cx="23" cy="50" r="8"/><circle {F} cx="77" cy="50" r="8"/>` },
    ],
  },
  {
    letter: "F",
    name: "Gems",
    about: "Faceted solids in two tones of the mark: flat, but with a light side.",
    shapes: [
      {
        name: "Cube",
        body:
          `<path {M} d="M50 23L73.4 36.5L50 50L26.6 36.5Z"/><path {S} d="M26.6 36.5L50 50V77L26.6 63.5Z"/>` +
          `<path {M} d="M73.4 36.5V63.5L50 77V50Z"/><path {FS} stroke-width="3" d="M50 50V77M50 50L26.6 36.5M50 50L73.4 36.5"/>`,
      },
      {
        name: "Pyramid",
        body: `<path {S} d="M50 22L22 50H50ZM50 78L78 50H50Z"/><path {M} d="M50 22L78 50H50ZM50 78L22 50H50Z"/>`,
      },
      { name: "Brilliant", body: `<path {S} d="M34 29H66L78 43H22Z"/><path {M} d="M22 47H78L50 76Z"/>` },
      { name: "Prism", body: `<path {S} d="M50 21L22 71H50Z"/><path {M} d="M50 21L78 71H50Z"/>` },
      { name: "Facet", body: `<path {S} d="M24 50L37 27.5H50V72.5H37Z"/><path {M} d="M50 27.5H63L76 50L63 72.5H50Z"/>` },
      { name: "Crystal", body: `<path {S} d="M50 20L36 36V64L50 80Z"/><path {M} d="M50 20L64 36V64L50 80Z"/>` },
      {
        name: "Bevel",
        body:
          `<clipPath id="bevel-{ID}"><path d="${rect(27, 27, 46, 46, 11)}"/></clipPath>` +
          `<g clip-path="url(#bevel-{ID})"><path {S} d="M20 20H80L20 80Z"/><path {M} d="M80 20V80H20Z"/></g>`,
      },
      {
        name: "Compass",
        body:
          `<path {M} d="M50 20L57 43L50 50ZM80 50L57 57L50 50ZM50 80L43 57L50 50ZM20 50L43 43L50 50Z"/>` +
          `<path {S} d="M50 20L43 43L50 50ZM80 50L57 43L50 50ZM50 80L57 57L50 50ZM20 50L43 57L50 50Z"/>`,
      },
    ],
  },
];

/** Every shape with its number (A1…F8), in gallery order. */
export const SHAPES = FAMILIES.flatMap((f) => f.shapes.map((s, i) => ({ ...s, id: `${f.letter}${i + 1}`, family: f.name })));

let drawn = 0;

/** One icon as a standalone SVG string, `size` pixels square, in a palette colour. */
export function iconSvg(shape, colour, size = 100) {
  const id = `i${++drawn}`;
  const paint = {
    M: `fill="${colour.mark}"`,
    S: `fill="${colour.mark}" fill-opacity=".55"`,
    F: `fill="${colour.field}"`,
    MS: `fill="none" stroke="${colour.mark}" stroke-linecap="round" stroke-linejoin="round"`,
    FS: `fill="none" stroke="${colour.field}" stroke-linecap="round" stroke-linejoin="round"`,
    ID: id,
  };
  const body = shape.body.replace(/\{(MS|FS|M|S|F|ID)\}/g, (_, k) => paint[k]);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">` +
    `<clipPath id="field-${id}"><circle cx="50" cy="50" r="50"/></clipPath>` +
    `<circle cx="50" cy="50" r="50" fill="${colour.field}"/>` +
    `<g clip-path="url(#field-${id})"><g transform="translate(50 50) scale(1.1) translate(-50 -50)">${body}</g></g></svg>`
  );
}
