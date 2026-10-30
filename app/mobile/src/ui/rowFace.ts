// The face of a row that swipes (Chats). Its actions sit under it at rest, laid out at full width
// (ReanimatedSwipeable draws both sides behind the row and only moves the row), so the face is all that hides them: it
// is never see-through, pressed or not. A translucent pressed fill showed Unread, Pin and Mute through the row.
import type { Palette } from "../theme";

const channels = (color: string): readonly [number, number, number, number] => {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex !== null) {
    const n = Number.parseInt(hex[1] ?? "", 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
  if (rgba === null) throw new Error(`not a color: ${color}`);
  return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
};

/** How opaque a color is, 0 to 1. */
export const alphaOf = (color: string): number => channels(color)[3];

/** `fill` laid over the opaque `bg`, as the one opaque color it shows. */
export const over = (fill: string, bg: string): string => {
  const [r, g, b, a] = channels(fill);
  const [R, G, B] = channels(bg);
  const mix = (top: number, under: number) => Math.round(top * a + under * (1 - a));
  return `rgb(${String(mix(r, R))},${String(mix(g, G))},${String(mix(b, B))})`;
};

/** The row's background: the screen's, or pressed, the quiet fill over it, as it looked on the screen before. */
export const rowFace = (p: Pick<Palette, "bg" | "fillQuiet">, pressed: boolean): string => (pressed ? over(p.fillQuiet, p.bg) : p.bg);
