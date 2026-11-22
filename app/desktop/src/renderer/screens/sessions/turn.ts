// How a phone screen moves in the live view when its device changes shape (D652). A phone's live frames come upright
// at the device's own shape: turned, its frame lies on its side (an iPhone 17's 1206 × 2622 becomes 2622 × 1206), and
// a Duo opened shows its wide inner panel. Rather than jumping to the new shape, the phone turns there from where it
// stood (the session's orientation, which comes a moment before the frame, says which way), or grows or shrinks to it.
// Plain numbers, so it is unit-tested; the views play the move (the desktop with the Web Animations API, the phone
// with a spring).

/** A box as laid out, in pixels or points. */
export interface Box {
  readonly width: number;
  readonly height: number;
}

/** A device's turn, clockwise on screen: its top to the left is a quarter anticlockwise. */
const ANGLE: Readonly<Record<string, number>> = { portrait: 0, landscape_left: -90, landscape_right: 90, portrait_upside_down: 180 };

/** How far the device turned from one orientation to the other, clockwise, the short way: ±90, 180, or 0 unknown. */
export const turnBetween = (was: string | undefined, now: string | undefined): number => {
  const a = was === undefined ? undefined : ANGLE[was];
  const b = now === undefined ? undefined : ANGLE[now];
  if (a === undefined || b === undefined) return 0;
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
};

/** Whether the new shape is the old one on its side, near enough: a quarter turn. */
export const swapped = (a: Box, b: Box): boolean => {
  if (a.width === 0 || a.height === 0 || b.width === 0 || b.height === 0) return false;
  const was = a.width / a.height;
  const now = b.width / b.height;
  return was < 1 !== now < 1 && Math.abs(was * now - 1) < 0.12;
};

/** The move a view plays from the old box to the new one, back to rest. */
export type Move =
  | { readonly kind: "turn"; readonly degrees: number; readonly scale: number }
  | { readonly kind: "resize"; readonly scaleX: number; readonly scaleY: number };

/**
 * The move from the old box to the new one, or null where there is nothing to play (the same size, or a box not laid
 * out yet). The device turned a quarter (`turned`, degrees clockwise, from its orientation) and its sides swapped: it
 * turns, played back from the old pose at the size it stood at. Any other change of shape grows or shrinks to it: a
 * Duo opened is nearly its closed shape on its side, so the shape alone never says it turned.
 */
export const moveOf = (old: Box, next: Box, turned = 0): Move | null => {
  if (old.width === 0 || old.height === 0 || next.width === 0 || next.height === 0) return null;
  if (Math.abs(old.width - next.width) < 1 && Math.abs(old.height - next.height) < 1) return null;
  if (Math.abs(turned) === 90 && swapped(old, next)) {
    return { kind: "turn", degrees: -turned, scale: round(Math.min(old.width / next.height, old.height / next.width)) };
  }
  return { kind: "resize", scaleX: round(old.width / next.width), scaleY: round(old.height / next.height) };
};

/** The keyframes that play a move back to rest. */
export const keyframesOf = (move: Move): Keyframe[] =>
  move.kind === "turn"
    ? [{ transform: `rotate(${String(move.degrees)}deg) scale(${String(move.scale)})` }, { transform: "none" }]
    : [{ transform: `scale(${String(move.scaleX)}, ${String(move.scaleY)})` }, { transform: "none" }];

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** How long a move takes: unhurried, never in the way. */
export const MOVE_MS = 420;
