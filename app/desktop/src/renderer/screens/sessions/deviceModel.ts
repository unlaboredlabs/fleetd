// The device a phone screen shows, as plain numbers: which body goes around the picture, how it stands (an iPhone Duo
// shut, half open, open or stood as a laptop; turned on its side or not), and where the picture lies on it. Built from
// the simulator's own display sizes (its device type's capabilities: pixels at 460 ppi, each display's corner radii)
// and the body sizes Apple publishes, never from someone's 3D model. The picture is the truth for its shape: a
// session's fold and orientation come a moment before the frame that shows them, so where the two disagree the
// picture's size says which panel is lit and which way the device is turned.
// Pure, so it is unit-tested, and the phone app can read it as it is (app/mobile/src/desktop.ts).

/** Millimetres per pixel of a 3x iPhone display (460 ppi). */
export const MM_PER_PX = 25.4 / 460;

/** A display: its size in millimetres, and its corners' radii (upper left, upper right, lower right, lower left). */
export interface Panel {
  readonly width: number;
  readonly height: number;
  readonly radii: readonly [number, number, number, number];
}

/** A body around one display: an iPhone, or a plain phone (an Android's). */
export interface PhoneBody {
  readonly kind: "phone";
  /** Its display, standing up. */
  readonly screen: Panel;
  /** The glass's black border around the display, all round. */
  readonly bezel: number;
  /** Front to back. */
  readonly depth: number;
  /** An iPhone's Dynamic Island, from the display's top edge; none on a plain phone. */
  readonly island?: { readonly width: number; readonly height: number; readonly top: number };
  /** The frame's finish. */
  readonly finish: Finish;
}

/** An iPhone Duo: two halves on a hinge, the inner display across both, the cover display on the left half's back. */
export interface DuoBody {
  readonly kind: "duo";
  /** The inner display, open and held upright: wide, the crease down its middle. */
  readonly inner: Panel;
  /** The cover display, standing up; its square corners are on the hinge's side. */
  readonly cover: Panel;
  readonly bezel: number;
  /** One half, front to back: shut, the Duo is twice as thick. */
  readonly depth: number;
  readonly finish: Finish;
}

export type Body = PhoneBody | DuoBody;

/** The metal's colour and the back's. */
export interface Finish {
  readonly frame: number;
  readonly back: number;
}

const SILVER: Finish = { frame: 0xc9ccd1, back: 0xdfe1e4 };
const STAR_WHITE: Finish = { frame: 0xe3ddd2, back: 0xefebe4 };
const GRAPHITE: Finish = { frame: 0x3b3d42, back: 0x2c2e33 };

const px = (n: number) => n * MM_PER_PX;
/** A corner radius in points, at 3x, in millimetres. */
const pt = (n: number) => px(n * 3);
const round4 = (r: number): readonly [number, number, number, number] => [r, r, r, r];

/** The iPhone Duo's displays, as its device type gives them: the cover 1398 × 2034, the inner 2853 × 2007 held open. */
export const DUO_COVER_PX = { width: 1398, height: 2034 } as const;
export const DUO_INNER_PX = { width: 2853, height: 2007 } as const;

/**
 * What a model's name says of its body: its display's height in pixels (its device type's), its depth (Apple's
 * published sizes), its display's corners in points, and whether it has an island. The first that matches.
 */
const IPHONES: readonly { readonly match: RegExp; readonly height: number; readonly depth: number; readonly corner: number; readonly island: boolean }[] = [
  { match: /\bAir\b/u, height: 2736, depth: 5.64, corner: 62, island: true },
  { match: /\bPro Max\b/u, height: 2868, depth: 8.75, corner: 62, island: true },
  { match: /\bPro\b/u, height: 2622, depth: 8.75, corner: 62, island: true },
  { match: /\b1[6-9]e\b/u, height: 2532, depth: 7.8, corner: 47, island: false },
  { match: /\biPhone\b/u, height: 2622, depth: 7.95, corner: 55, island: true },
];
const GENERIC_IPHONE = { height: 2622, depth: 7.95, corner: 55, island: true } as const;

/** The body of `model` ("iPhone Duo", "iPhone 17 Pro"; absent from older nodes) on a screen of `kind`, around a picture of `size`. */
export function bodyOf(kind: string | undefined, model: string | undefined, size: { width: number; height: number } | undefined): Body | undefined {
  if (kind !== "ios" && kind !== "android") return undefined;
  if (kind === "ios" && (model === undefined ? looksDuo(size) : /\bDuo\b/u.test(model))) return DUO;
  // The display's shape is the picture's (which may come scaled down), standing up; its size the model's.
  const shape = size === undefined || size.width === 0 || size.height === 0 ? 1206 / 2622 : Math.min(size.width, size.height) / Math.max(size.width, size.height);
  if (kind === "android") {
    // A plain phone: its display at its own shape, about a phone's size, round corners, a camera dot.
    const height = 150;
    return { kind: "phone", screen: { width: height * shape, height, radii: round4(6) }, bezel: 2.4, depth: 8.2, finish: GRAPHITE };
  }
  const known = IPHONES.find((i) => i.match.test(model ?? "iPhone")) ?? GENERIC_IPHONE;
  // A 3x iPhone's display at 460 ppi.
  const screen = { width: px(known.height * shape), height: px(known.height), radii: round4(pt(known.corner)) };
  return {
    kind: "phone",
    screen,
    bezel: 2.6,
    depth: known.depth,
    ...(known.island ? { island: { width: pt(125), height: pt(37), top: pt(11) } } : {}),
    finish: SILVER,
  };
}

const DUO: DuoBody = {
  kind: "duo",
  inner: { width: px(DUO_INNER_PX.width), height: px(DUO_INNER_PX.height), radii: round4(pt(55)) },
  // Upper and lower left are the hinge's side.
  cover: { width: px(DUO_COVER_PX.width), height: px(DUO_COVER_PX.height), radii: [pt(8), pt(59), pt(59), pt(8)] },
  bezel: 2.3,
  depth: 4.6,
  finish: STAR_WHITE,
};

/** How far `a` is from `b` as shapes go (a ratio's distance, either way round). */
const apart = (a: number, b: number) => Math.abs(Math.log(a / b));

/** Whether a picture of `size` is one of an iPhone Duo's panels (an older node's session says no model). */
function looksDuo(size: { width: number; height: number } | undefined): boolean {
  if (size === undefined || size.width === 0 || size.height === 0) return false;
  const shape = size.width / size.height;
  const cover = DUO_COVER_PX.width / DUO_COVER_PX.height;
  const inner = DUO_INNER_PX.width / DUO_INNER_PX.height;
  return [cover, 1 / cover, inner, 1 / inner].some((s) => apart(shape, s) < 0.015);
}

/** How a device stands. */
export interface Pose {
  /** The hinge's opening in degrees: 0 shut, 180 flat; a plain phone's is 180. */
  readonly hinge: number;
  /** Which display is lit: a Duo's cover or its inner one; a phone's only one. */
  readonly panel: "cover" | "inner" | "screen";
  /** Its turn on screen, degrees anticlockwise: 90 is its top to the left (landscape_left). */
  readonly roll: 0 | 90 | 180 | -90;
  /** Stood as a laptop: half open on its side, the lower half lying flat. */
  readonly laptop: boolean;
}

/** The hinge's opening for each of a Duo's folds (agent-device's presets: half-open is 130°). */
export const HALF_OPEN = 130;

const ROLL: Readonly<Record<string, Pose["roll"]>> = { portrait: 0, landscape_left: 90, landscape_right: -90, portrait_upside_down: 180 };

/**
 * How `body` stands, from the session's `fold` and `orientation` and the picture's `size`. The picture decides what
 * it can: which of a Duo's panels is lit (the one whose shape it has), and whether the device is on its side (the lit
 * display's shape turned); the orientation then says which side, and the fold how far a lit inner display is open.
 */
export function poseOf(body: Body, fold: string | undefined, orientation: string | undefined, size: { width: number; height: number } | undefined): Pose {
  const said = ROLL[orientation ?? ""] ?? 0;
  if (body.kind === "phone") return { hinge: 180, panel: "screen", roll: rollFor(body.screen.width / body.screen.height, size, said), laptop: false };
  const shape = size === undefined || size.width === 0 || size.height === 0 ? undefined : size.width / size.height;
  const coverShape = body.cover.width / body.cover.height;
  const innerShape = body.inner.width / body.inner.height;
  // The panel whose shape, standing or turned, is nearest the picture's; without a picture, the fold's.
  const panel: "cover" | "inner" =
    shape === undefined
      ? fold === undefined || fold === "closed"
        ? "cover"
        : "inner"
      : Math.min(apart(shape, coverShape), apart(shape, 1 / coverShape)) <= Math.min(apart(shape, innerShape), apart(shape, 1 / innerShape))
        ? "cover"
        : "inner";
  const hinge = panel === "cover" ? 0 : fold === "half-open" || fold === "laptop" ? HALF_OPEN : 180;
  const roll = rollFor(panel === "cover" ? coverShape : innerShape, size, said);
  return { hinge, panel, roll, laptop: panel === "inner" && hinge < 180 && Math.abs(roll) === 90 };
}

/**
 * The device's turn: the orientation's, unless the picture says otherwise. A display standing as `native` (its width
 * over its height upright) shown in a picture the other way round is on its side; one the same way round isn't.
 */
function rollFor(native: number, size: { width: number; height: number } | undefined, said: Pose["roll"]): Pose["roll"] {
  if (size === undefined || size.width === 0 || size.height === 0) return said;
  const sideways = native < 1 !== size.width / size.height < 1;
  const saysSideways = Math.abs(said) === 90;
  if (sideways === saysSideways) return said;
  return sideways ? 90 : 0;
}

/** The lit display's size as the viewer sees it, turned by the pose's roll: the picture's shape, in millimetres. */
export function shownPanel(body: Body, pose: Pose): { width: number; height: number } {
  const p = body.kind === "phone" ? body.screen : pose.panel === "cover" ? body.cover : body.inner;
  return Math.abs(pose.roll) === 90 ? { width: p.height, height: p.width } : { width: p.width, height: p.height };
}

/**
 * Where a point of the lit display lies in the picture, as texture coordinates (u right, v up, 0 to 1): `x` and `y`
 * in millimetres from the display's centre as the device stands upright (y up), turned by the pose's roll.
 */
export function uvOf(x: number, y: number, panel: { width: number; height: number }, roll: Pose["roll"]): [number, number] {
  const a = (roll * Math.PI) / 180;
  const c = Math.round(Math.cos(a));
  const s = Math.round(Math.sin(a));
  const rx = x * c - y * s;
  const ry = x * s + y * c;
  const w = Math.abs(roll) === 90 ? panel.height : panel.width;
  const h = Math.abs(roll) === 90 ? panel.width : panel.height;
  return [rx / w + 0.5, ry / h + 0.5];
}

/** The corner radii of `panel` as the viewer sees it, turned by `roll` (upper left, upper right, lower right, lower left). */
export function radiiShown(panel: Panel, roll: Pose["roll"]): readonly [number, number, number, number] {
  // Anticlockwise by a quarter: the upper right corner comes to the upper left.
  const steps = (((roll / 90) % 4) + 4) % 4;
  const [a, b, c, d] = panel.radii;
  const r = [a, b, c, d, a, b, c];
  return [r[steps] ?? a, r[steps + 1] ?? b, r[steps + 2] ?? c, r[steps + 3] ?? d];
}

/**
 * A rectangle given on the display standing upright (millimetres from its centre, y up), as fractions of the display
 * as the viewer sees it (from its top left): where an iPhone's island lies once the device is turned by `roll`.
 */
export function placeShown(
  rect: { x: number; y: number; width: number; height: number },
  panel: { width: number; height: number },
  roll: Pose["roll"],
): { left: number; top: number; width: number; height: number } {
  const [u0, v0] = uvOf(rect.x - rect.width / 2, rect.y - rect.height / 2, panel, roll);
  const [u1, v1] = uvOf(rect.x + rect.width / 2, rect.y + rect.height / 2, panel, roll);
  return { left: Math.min(u0, u1), top: 1 - Math.max(v0, v1), width: Math.abs(u1 - u0), height: Math.abs(v1 - v0) };
}

/**
 * The Duo cover's camera, a punch hole its picture leaves room for: its centre as a share of the cover's width and
 * height from its top left, standing up, and its size as a share of the width.
 */
export const COVER_CAMERA = { x: 0.895, y: 0.07, size: 0.07 } as const;

/** A flat frame's shape: its size over the shown display's, its corners, the display's corners, where the island and crease go. */
export function flatOf(body: Body, pose: Pose) {
  const panel = body.kind === "phone" ? body.screen : pose.panel === "cover" ? body.cover : body.inner;
  const shown = shownPanel(body, pose);
  const bezel = body.bezel;
  const width = shown.width + bezel * 2;
  const height = shown.height + bezel * 2;
  const screenRadii = radiiShown(panel, pose.roll);
  const hole = body.kind === "duo" ? COVER_CAMERA.size * body.cover.width : 0;
  const island =
    body.kind === "phone"
      ? body.island === undefined
        ? undefined
        : placeShown({ x: 0, y: panel.height / 2 - body.island.top - body.island.height / 2, width: body.island.width, height: body.island.height }, panel, pose.roll)
      : pose.panel === "cover"
        ? placeShown({ x: (COVER_CAMERA.x - 0.5) * panel.width, y: (0.5 - COVER_CAMERA.y) * panel.height, width: hole, height: hole }, panel, pose.roll)
        : undefined;
  return {
    /** The frame's width over its height, and the display's. */
    aspect: width / height,
    screenAspect: shown.width / shown.height,
    /** The bezel as a share of the frame's width and of its height. */
    bezelX: bezel / width,
    bezelY: bezel / height,
    /** Each corner's radius as a share of the frame's width (upper left, upper right, lower right, lower left). */
    outer: screenRadii.map((r) => (r + bezel) / width) as unknown as readonly [number, number, number, number],
    inner: screenRadii.map((r) => r / width) as unknown as readonly [number, number, number, number],
    island,
    /** An open Duo's crease: down the middle, or across it on its side. */
    crease: body.kind === "duo" && pose.panel === "inner" ? (Math.abs(pose.roll) === 90 ? ("across" as const) : ("down" as const)) : undefined,
  };
}
