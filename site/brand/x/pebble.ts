// Pebble as the app draws it, for a still picture: the body's outline and the eyes straight from the app's own rig
// (app/desktop/src/shared/bot.ts), settled in its idle pose with no breath or glance on top, as an SVG group in the
// rig's 100×100 box. Nothing here redraws the character.
import { BODY, frameOf, matrixAttr, MOODS, newRig } from "../../../app/desktop/src/shared/bot";

export interface Look {
  /** The fills: a colour, or `url(#id)` of a gradient the page defines. */
  readonly body: string;
  readonly eye: string;
  /** The eyes' size, of the rig's own: 1 at large sizes, 1.2 in a list (the rig's rule below 44 px, and the small
   * icon master's). Their gap follows as the rig's does. */
  readonly eyes?: number;
}

/** Pebble in the rig's 100×100 box: its body spans x 14.5 to 85.5 and y 22 to 85, resting on y 85. */
export const pebble = ({ body, eye, eyes = 1 }: Look): string => {
  const rig = newRig("idle", 200, 0);
  rig.x = MOODS.idle.pose.slice();
  rig.eyeK = eyes;
  rig.gapK = 1 + (eyes - 1) / 4;
  const frame = frameOf(rig);
  return `<g transform="${matrixAttr(frame.body)}"><path d="${BODY}" fill="${body}"/><path d="${frame.eyes[0]}${frame.eyes[1]}" fill="${eye}"/></g>`;
};
