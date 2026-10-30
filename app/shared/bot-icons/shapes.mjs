// Bot icons: original little beings for a Navi's or a project's round avatar, in a 100×100 box on a round field.
// Each is a body in the mark's colour with a face cut into it in the field's colour, so it reads as someone at 24px.
//
// A being's body is SVG with paint tokens, so one being takes any palette colour:
//   {M}  the mark's fill                   {MR} the mark's fill with a round-joined edge (soft tips on ears, horns)
//   {F}  the field's fill (eyes, mouths)   {C}  the field at 45% (cheeks)
//   {MS} a stroke in the mark (antennae)   {FS} a stroke in the field (lids, smiles, brows)
// Everything is clipped to the field, so a body may run off its edge (a being peeking in).

/** A rounded rectangle as path data. */
const rect = (x, y, w, h, r) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
  `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;

/** A star of `n` points as path data. */
const star = (cx, cy, outer, inner, n) => {
  const points = [];
  for (let i = 0; i < 2 * n; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 === 0 ? outer : inner;
    points.push(`${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return `M${points.join("L")}Z`;
};

const body = (d) => `<path {M} d="${d}"/>`;
const dot = (x, y, r = 4.5) => `<circle {F} cx="${x}" cy="${y}" r="${r}"/>`;
/** A wide eye: a white in the field's colour, a pupil in the mark's, set off by (dx, dy) to give a look. */
const wide = (x, y, r, dx, dy, p = r / 2) => `${dot(x, y, r)}<circle {M} cx="${x + dx}" cy="${y + dy}" r="${p}"/>`;
const line = (d, w = 4.5) => `<path {FS} stroke-width="${w}" d="${d}"/>`;
const cheeks = (x1, x2, y) =>
  `<ellipse {C} cx="${x1}" cy="${y}" rx="5" ry="3.2"/><ellipse {C} cx="${x2}" cy="${y}" rx="5" ry="3.2"/>`;
/** Drowsy eyes: lower half discs, lids shut flat across the top. */
const lids = (x1, x2, y, r = 5.5) =>
  `<path {F} d="M${x1 - r} ${y}a${r} ${r} 0 0 0 ${2 * r} 0ZM${x2 - r} ${y}a${r} ${r} 0 0 0 ${2 * r} 0Z"/>`;

export const FAMILIES = [
  {
    letter: "A",
    name: "Blobs",
    about: "Soft round bodies: the plainest beings, all mood and no limbs.",
    shapes: [
      { name: "Mo", mood: "calm", body: body(rect(21, 27, 58, 52, 26)) + dot(40, 50, 5) + dot(60, 50, 5) + line("M45 61q5 4 10 0", 4) },
      {
        name: "Puff",
        mood: "happy",
        body: body(rect(17, 32, 66, 46, 23)) + line("M33 53l5-5 5 5M57 53l5-5 5 5") + cheeks(29, 71, 61) + line("M47 60q3 3 6 0", 3.5),
      },
      {
        name: "Gloop",
        mood: "curious",
        body:
          body("M22 54A28 28 0 0 1 78 54V68a6 6 0 0 1 -12 0V62a4 4 0 0 0 -8 0V74a6 6 0 0 1 -12 0V62a4 4 0 0 0 -8 0V70a8 8 0 0 1 -16 0Z") +
          wide(40, 46, 8, 2, -3) +
          wide(60, 46, 8, 2, -3),
      },
      {
        name: "Dumpling",
        mood: "sleepy",
        body:
          body("M24 76H76A4 4 0 0 0 80 72V62A30 30 0 0 0 20 62V72A4 4 0 0 0 24 76Z") +
          `<path {MS} stroke-width="5" d="M50 33c0-7 6-9 10-6"/>` +
          lids(40, 60, 58),
      },
      {
        name: "Pip",
        mood: "chirpy",
        body: `<circle {M} cx="50" cy="42" r="20"/>` + body(rect(28, 56, 44, 40, 18)) + dot(43, 42) + dot(57, 42) + line("M47 50q3 2.5 6 0", 3.5),
      },
      { name: "Bub", mood: "shy", body: `<circle {M} cx="50" cy="94" r="42"/>` + wide(38, 68, 8, -3.5, 0) + wide(62, 68, 8, -3.5, 0) },
      {
        name: "Jelly",
        mood: "dreamy",
        body:
          body("M23 56A27 27 0 0 1 77 56Q77 60 73 60H27Q23 60 23 56Z") +
          `<path {MS} stroke-width="5" d="M34 58v8q0 5-4 9M50 58v18M66 58v8q0 5 4 9"/>` +
          dot(41, 46, 4) +
          dot(59, 46, 4),
      },
      {
        name: "Squish",
        mood: "surprised",
        body: body(rect(15, 34, 70, 42, 21)) + wide(39, 50, 8, 0, 0, 3.5) + wide(61, 50, 8, 0, 0, 3.5) + dot(50, 65, 4),
      },
    ],
  },
  {
    letter: "B",
    name: "Bots",
    about: "Little machines: square heads, antennae, visors, a glow for eyes.",
    shapes: [
      {
        name: "Bit",
        mood: "eager",
        body:
          body(rect(26, 36, 48, 40, 12)) +
          `<path {MS} stroke-width="4" d="M50 38V24"/><circle {M} cx="50" cy="22" r="5"/>` +
          dot(40, 54, 5) +
          dot(60, 54, 5) +
          line("M45 65h10", 4),
      },
      {
        name: "Visor",
        mood: "cool",
        body:
          body(rect(22, 30, 56, 46, 20)) +
          body(rect(16, 46, 8, 14, 4) + rect(76, 46, 8, 14, 4)) +
          `<path {F} d="${rect(29, 43, 42, 16, 8)}"/>` +
          `<circle {M} cx="41" cy="51" r="3.8"/><circle {M} cx="59" cy="51" r="3.8"/>`,
      },
      {
        name: "Mono",
        mood: "curious",
        body: body(rect(24, 32, 52, 46, 14)) + `<path {MS} stroke-width="4" d="M50 34L58 21"/><circle {M} cx="59" cy="20" r="4.5"/>` + wide(50, 54, 13, 3, -3, 6),
      },
      {
        name: "Boop",
        mood: "unimpressed",
        body:
          `<circle {M} cx="50" cy="57" r="26"/><path {MS} stroke-width="4" d="M40 34L33 21M60 34L67 21"/>` +
          `<circle {M} cx="32" cy="19" r="4.5"/><circle {M} cx="68" cy="19" r="4.5"/>` +
          `<path {F} d="${rect(34, 51, 13, 6, 3) + rect(53, 51, 13, 6, 3)}"/>`,
      },
      {
        name: "Can",
        mood: "focused",
        body:
          body(rect(31, 22, 38, 60, 16)) +
          `<path {F} d="${rect(37, 39, 26, 10, 5)}"/><circle {M} cx="57" cy="44" r="3.3"/>` +
          line("M44 62h12M44 68h12", 3.5),
      },
      {
        name: "Pixel",
        mood: "pleased",
        body:
          body(rect(24, 28, 52, 48, 10)) +
          `<path {F} d="${rect(34, 40, 9, 9, 2) + rect(57, 40, 9, 9, 2) + rect(33, 57, 7, 7, 1.5) + rect(40, 62, 20, 7, 1.5) + rect(60, 57, 7, 7, 1.5)}"/>`,
      },
      {
        name: "Wink",
        mood: "cheeky",
        body:
          body(rect(26, 34, 48, 42, 14)) +
          `<path {MS} stroke-width="4" d="M60 36q0-9 8-12"/><circle {M} cx="69" cy="23" r="4.5"/>` +
          dot(40, 52, 5) +
          line("M55 52q5 4 10 0") +
          line("M41 63q9 7 18-2", 4),
      },
      {
        name: "Helm",
        mood: "determined",
        body:
          body("M24 76V56A26 26 0 0 1 76 56V76Z") +
          `<path {MR} stroke-width="4" d="M44 32Q50 14 56 32Z"/>` +
          dot(40, 58, 5) +
          dot(60, 58, 5) +
          line("M33 47L45 51M67 47L55 51", 4),
      },
    ],
  },
  {
    letter: "C",
    name: "Critters",
    about: "Ears, tufts, beaks, horns: animals of no particular species.",
    shapes: [
      {
        name: "Mew",
        mood: "content",
        body:
          body(rect(22, 36, 56, 44, 22)) +
          `<path {MR} stroke-width="4" d="M26 46L28 22L46 37ZM74 46L72 22L54 37Z"/>` +
          dot(40, 56) +
          dot(60, 56) +
          line("M45 64q2.5 3 5 0q2.5 3 5 0", 3.5),
      },
      {
        name: "Hop",
        mood: "sleepy",
        body:
          `<path {M} transform="rotate(-10 40 44)" d="${rect(34, 12, 12, 36, 6)}"/>` +
          `<path {M} transform="rotate(10 60 44)" d="${rect(54, 12, 12, 36, 6)}"/><circle {M} cx="50" cy="61" r="24"/>` +
          lids(41, 59, 60, 5) +
          dot(50, 69, 2.5),
      },
      {
        name: "Owl",
        mood: "wise",
        body:
          body(rect(24, 30, 52, 50, 22)) +
          `<path {MR} stroke-width="4" d="M27 39L24 21L41 31ZM73 39L76 21L59 31Z"/>` +
          wide(39, 50, 9.5, 0, 0, 4.5) +
          wide(61, 50, 9.5, 0, 0, 4.5) +
          `<path {F} d="M46 62H54L50 68Z"/>`,
      },
      {
        name: "Chick",
        mood: "chatty",
        body:
          `<circle {M} cx="46" cy="56" r="25"/><path {MR} stroke-width="4" d="M69 48L81 54L69 60Z"/>` +
          `<path {MS} stroke-width="5" d="M42 32q-1-9 7-11"/>` +
          dot(57, 49) +
          line("M33 61q7 7 16 2", 4),
      },
      {
        name: "Imp",
        mood: "mischievous",
        body:
          body(rect(24, 34, 52, 44, 20)) +
          `<path {MR} stroke-width="4" d="M31 40Q24 27 33 21Q32 30 39 35ZM69 40Q76 27 67 21Q68 30 61 35Z"/>` +
          dot(40, 52) +
          dot(60, 52) +
          `<path {F} d="M37 61Q50 75 63 61Z"/>`,
      },
      {
        name: "Mole",
        mood: "peeking",
        body:
          `<circle {M} cx="28" cy="60" r="8"/><circle {M} cx="72" cy="60" r="8"/><circle {M} cx="50" cy="98" r="42"/>` +
          dot(40, 71) +
          dot(60, 71) +
          `<ellipse {F} cx="50" cy="80" rx="5" ry="3.5"/>`,
      },
      {
        name: "Frog",
        mood: "grinning",
        body:
          `<circle {M} cx="34" cy="40" r="12"/><circle {M} cx="66" cy="40" r="12"/>` +
          body(rect(18, 42, 64, 36, 18)) +
          wide(34, 40, 6.5, 0, 1, 3.2) +
          wide(66, 40, 6.5, 0, 1, 3.2) +
          line("M33 61q17 11 34 0"),
      },
      {
        name: "Bug",
        mood: "wondering",
        body: `<circle {M} cx="50" cy="59" r="24"/><path {MS} stroke-width="4" d="M42 37q-3-14-14-12M58 37q3-14 14-12"/>` + wide(41, 56, 7, 0, 3, 3.5) + wide(59, 56, 7, 0, 3, 3.5),
      },
    ],
  },
  {
    letter: "D",
    name: "Spirits",
    about: "Ghosts, drops, flames and stars: beings made of weather and light.",
    shapes: [
      {
        name: "Boo",
        mood: "playful",
        body:
          `<g transform="rotate(-6 50 50)">${body("M26 76V50A24 24 0 0 1 74 50V76a8 8 0 0 1 -16 0a8 8 0 0 1 -16 0a8 8 0 0 1 -16 0Z")}` +
          `<ellipse {F} cx="41" cy="50" rx="4" ry="6"/><ellipse {F} cx="59" cy="50" rx="4" ry="6"/><ellipse {F} cx="50" cy="63" rx="3.5" ry="4.5"/></g>`,
      },
      {
        name: "Drip",
        mood: "serene",
        body: body("M50 18C60 34 74 44 74 60A24 24 0 1 1 26 60C26 44 40 34 50 18Z") + line("M37 60q5 5 10 0M53 60q5 5 10 0") + cheeks(36, 64, 69),
      },
      {
        name: "Flick",
        mood: "fired up",
        body:
          body("M50 16C56 30 74 38 74 58C74 72 63 81 50 81C37 81 26 72 26 58C26 48 32 42 36 36C38 44 42 46 46 46C44 36 46 26 50 16Z") +
          dot(42, 63) +
          dot(58, 63) +
          line("M35 55L46 58M65 55L54 58", 4),
      },
      {
        name: "Twinkle",
        mood: "cheeky",
        body: `<path {MR} stroke-width="9" d="${star(50, 53, 31, 17, 5)}"/>` + dot(44, 52, 3.8) + line("M52 52q3.5-3.5 7 0", 3.5) + line("M46 60q4 3.5 8 0", 3.5),
      },
      {
        name: "Halo",
        mood: "kind",
        body: `<circle {M} cx="50" cy="59" r="22"/><ellipse {MS} stroke-width="4.5" cx="50" cy="27" rx="15" ry="4.5"/>` + line("M38 58q4 4 8 0M54 58q4 4 8 0", 4),
      },
      {
        name: "Wisp",
        mood: "on the go",
        body: `<circle {M} cx="58" cy="50" r="22"/><path {MS} stroke-width="5" d="M18 42H30M14 52H28M20 62H31"/>` + dot(58, 47) + dot(71, 47) + line("M60 59q4 3 8 0", 4),
      },
      {
        name: "Cloud",
        mood: "drowsy",
        body:
          `<circle {M} cx="35" cy="58" r="14"/><circle {M} cx="52" cy="47" r="18"/><circle {M} cx="68" cy="58" r="13"/>` +
          body(rect(24, 56, 54, 17, 8.5)) +
          lids(42, 60, 58, 5),
      },
      { name: "Moon", mood: "dozing", body: `<circle {M} cx="50" cy="50" r="29"/><circle {F} cx="65" cy="40" r="23"/>` + line("M28 51q4 4 8 0", 4) + line("M33 64q5 3 10 0", 4) },
    ],
  },
  {
    letter: "E",
    name: "Oddballs",
    about: "Characters with one strong trait: a giant eye, a lean, shades, a shout.",
    shapes: [
      {
        name: "Cyclo",
        mood: "curious",
        body: body(rect(22, 24, 56, 54, 26)) + body(rect(35, 72, 9, 9, 4) + rect(56, 72, 9, 9, 4)) + wide(50, 47, 14, 3, -4, 6.5) + line("M46 66q4 3 8 0", 4),
      },
      { name: "Bean", mood: "laid back", body: `<g transform="rotate(14 50 50)">${body(rect(34, 18, 32, 66, 16))}${dot(43, 40)}${dot(57, 40)}${line("M46 52q4 3 8 0", 4)}</g>` },
      { name: "Shy", mood: "shy", body: `<circle {M} cx="88" cy="56" r="38"/>` + wide(64, 48, 7.5, -3.5, 0) + wide(82, 48, 7.5, -3.5, 0) + `<ellipse {C} cx="68" cy="61" rx="5" ry="3.2"/>` },
      { name: "Grump", mood: "grumpy", body: body(rect(24, 30, 52, 48, 12)) + lids(40, 60, 54, 5.5) + line("M33 45L46 49M67 45L54 49", 4) + line("M43 68q7-5 14 0", 4) },
      { name: "Noodle", mood: "wiggly", body: `<path {MS} stroke-width="14" d="M20 76Q26 56 40 62T60 44"/><circle {M} cx="64" cy="38" r="14"/>` + dot(61, 36, 3.8) + dot(71, 36, 3.8) },
      { name: "Yell", mood: "excited", body: `<circle {M} cx="50" cy="54" r="27"/>` + dot(40, 43, 4) + dot(60, 43, 4) + `<path {F} d="M36 53H64A14 14 0 0 1 36 53Z"/>` },
      {
        name: "Sprout",
        mood: "fresh",
        body:
          body(rect(28, 42, 44, 38, 19)) +
          `<path {MS} stroke-width="4" d="M50 44V30"/><path {M} d="M50 32Q50 19 63 19Q63 32 50 32ZM50 34Q50 25 40 25Q40 34 50 34Z"/>` +
          dot(42, 58) +
          dot(58, 58) +
          cheeks(36, 64, 67),
      },
      {
        name: "Shades",
        mood: "cool",
        body: body(rect(22, 30, 56, 50, 24)) + `<path {F} d="${rect(27, 44, 21, 13, 5) + rect(52, 44, 21, 13, 5) + rect(45, 46, 10, 4, 2)}"/>` + line("M48 67q6 2 11-3", 4),
      },
    ],
  },
];

/** Every being with its number (A1…E8), in gallery order. */
export const SHAPES = FAMILIES.flatMap((f) => f.shapes.map((s, i) => ({ ...s, id: `${f.letter}${i + 1}`, family: f.name })));

let drawn = 0;

/** One icon as a standalone SVG string, `size` pixels square, in a palette colour. */
export function iconSvg(shape, colour, size = 100) {
  const id = `i${++drawn}`;
  const paint = {
    M: `fill="${colour.mark}"`,
    MR: `fill="${colour.mark}" stroke="${colour.mark}" stroke-linejoin="round"`,
    F: `fill="${colour.field}"`,
    C: `fill="${colour.field}" fill-opacity=".45"`,
    MS: `fill="none" stroke="${colour.mark}" stroke-linecap="round" stroke-linejoin="round"`,
    FS: `fill="none" stroke="${colour.field}" stroke-linecap="round" stroke-linejoin="round"`,
  };
  const body = shape.body.replace(/\{(MR|MS|FS|M|F|C)\}/g, (_, k) => paint[k]);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">` +
    `<clipPath id="field-${id}"><circle cx="50" cy="50" r="50"/></clipPath>` +
    `<circle cx="50" cy="50" r="50" fill="${colour.field}"/><g clip-path="url(#field-${id})">${body}</g></svg>`
  );
}
