// Bot icons: original little beings for a Navi's or a project's round avatar, in a 100×100 box on a round field.
// Each is one plain body in the mark's colour with a face of two or three marks cut into it in the field's colour:
// the silhouette and where the eyes sit carry all the character, so it reads as someone at 24px.
//
// A being's body is SVG with paint tokens, so one being takes any palette colour:
//   {M}  the mark's fill (the body)   {F}  the field's fill (an eye)   {FS} a stroke in the field (a shut eye)
// Everything is clipped to the field, so a body may run off its edge (a being peeking in).

/** A rounded rectangle as path data. */
const rect = (x, y, w, h, r) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
  `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;

const body = (d) => `<path {M} d="${d}"/>`;
const round = (cx, cy, r) => `<circle {M} cx="${cx}" cy="${cy}" r="${r}"/>`;
const eye = (x, y, r = 4.5) => `<circle {F} cx="${x}" cy="${y}" r="${r}"/>`;
const eyes = (x1, x2, y, r) => eye(x1, y, r) + eye(x2, y, r);
/** Tall eyes: upright ovals, an alert look. */
const ovals = (x1, x2, y) => `<ellipse {F} cx="${x1}" cy="${y}" rx="3.6" ry="6"/><ellipse {F} cx="${x2}" cy="${y}" rx="3.6" ry="6"/>`;
/** A shut eye or a mouth: a short round-capped line. */
const dash = (d, w = 4.5) => `<path {FS} stroke-width="${w}" d="${d}"/>`;

export const FAMILIES = [
  {
    letter: "A",
    name: "Rounds",
    about: "A plain round body: only the eyes change.",
    shapes: [
      { name: "Mo", mood: "calm", body: round(50, 50, 26) + eyes(40, 60, 47, 5.2) },
      { name: "Wee", mood: "shy", body: round(50, 50, 26) + eyes(44, 56, 59, 4.6) },
      { name: "Peep", mood: "curious", body: round(50, 50, 26) + eyes(55, 69, 43, 5.2) },
      { name: "Nap", mood: "sleepy", body: `<ellipse {M} cx="50" cy="52" rx="30" ry="22"/>` + dash("M34 51h10M56 51h10", 5) },
      { name: "Cy", mood: "focused", body: round(50, 50, 26) + eye(55, 43, 6.5) },
      { name: "Wink", mood: "cheeky", body: round(50, 50, 26) + eye(40, 47, 5.2) + dash("M54 47h11", 5) },
    ],
  },
  {
    letter: "B",
    name: "Blocks",
    about: "A soft square body: sturdy, a little robotic.",
    shapes: [
      { name: "Bit", mood: "alert", body: body(rect(24, 26, 52, 48, 16)) + ovals(41, 59, 49) },
      { name: "Wide", mood: "goofy", body: body(rect(18, 32, 64, 38, 15)) + eyes(31, 69, 50, 5.2) },
      { name: "Box", mood: "content", body: body(rect(24, 26, 52, 48, 16)) + eyes(40, 60, 46, 5) + dash("M45 60h10", 4.5) },
      { name: "Tower", mood: "stoic", body: body(rect(29, 22, 42, 56, 13)) + eyes(41, 59, 38, 5) },
      { name: "Tilt", mood: "playful", body: `<g transform="rotate(12 50 50)">${body(rect(25, 27, 50, 46, 15))}${eyes(40, 60, 46, 5)}</g>` },
      { name: "Grit", mood: "determined", body: body(rect(24, 26, 52, 48, 16)) + dash("M34 45l11 3.5M66 45l-11 3.5", 5) },
    ],
  },
  {
    letter: "C",
    name: "Talls",
    about: "An upright body, pill or drop or egg: a being standing up.",
    shapes: [
      { name: "Pill", mood: "upbeat", body: body(rect(34, 19, 32, 62, 16)) + eyes(44, 56, 36, 4) },
      { name: "Bean", mood: "laid back", body: `<g transform="rotate(16 50 50)">${body(rect(34, 19, 32, 62, 16))}${eyes(44, 56, 37, 4)}</g>` },
      { name: "Drop", mood: "gentle", body: body("M50 18C60 34 74 44 74 60A24 24 0 1 1 26 60C26 44 40 34 50 18Z") + eyes(43, 57, 61, 4.5) },
      { name: "Egg", mood: "wondering", body: `<ellipse {M} cx="50" cy="52" rx="22" ry="29"/>` + eye(53, 42, 6.5) },
      { name: "Arch", mood: "dozy", body: body("M29 79V45A21 21 0 0 1 71 45V79Z") + dash("M38 47h8M54 47h8") },
      { name: "Gum", mood: "steady", body: body("M29 78Q22 78 25 71L44 29Q50 17 56 29L75 71Q78 78 71 78Z") + eyes(44, 56, 60, 4) },
    ],
  },
  {
    letter: "D",
    name: "Peekers",
    about: "A body that runs off the edge: someone looking in.",
    shapes: [
      { name: "Rise", mood: "hopeful", body: round(50, 96, 42) + eyes(39, 61, 70, 6) },
      { name: "Lean", mood: "nosy", body: round(90, 52, 40) + eyes(61, 77, 47, 6) },
      { name: "Corner", mood: "sly", body: round(18, 88, 46) + eyes(31, 47, 64, 6) },
      { name: "Hang", mood: "upside down", body: round(50, 4, 42) + eyes(39, 61, 31, 6) },
      { name: "Lurk", mood: "watchful", body: `<ellipse {M} cx="50" cy="94" rx="42" ry="36"/>` + eye(50, 72, 8) },
      { name: "Sneak", mood: "mischievous", body: round(10, 50, 40) + eye(23, 46, 6) + dash("M34 46h9", 6) },
    ],
  },
];

/** Every being with its number (A1…D6), in gallery order. */
export const SHAPES = FAMILIES.flatMap((f) => f.shapes.map((s, i) => ({ ...s, id: `${f.letter}${i + 1}`, family: f.name })));

let drawn = 0;

/** One icon as a standalone SVG string, `size` pixels square, in a palette colour. */
export function iconSvg(shape, colour, size = 100) {
  const id = `i${++drawn}`;
  const paint = {
    M: `fill="${colour.mark}"`,
    F: `fill="${colour.field}"`,
    FS: `fill="none" stroke="${colour.field}" stroke-linecap="round" stroke-linejoin="round"`,
  };
  const body = shape.body.replace(/\{(FS|M|F)\}/g, (_, k) => paint[k]);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">` +
    `<clipPath id="field-${id}"><circle cx="50" cy="50" r="50"/></clipPath>` +
    `<circle cx="50" cy="50" r="50" fill="${colour.field}"/><g clip-path="url(#field-${id})">${body}</g></svg>`
  );
}
