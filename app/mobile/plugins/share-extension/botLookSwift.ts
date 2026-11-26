// BotLook.swift, the share sheet's bots as the app draws them at rest (src/ui/Being.tsx with Reduce Motion on): each
// shape's body, both eyes settled, and each color's paint in light and dark, from the
// desktop's shared/bot.ts. botLookSwift.test.ts holds the file to it; `UPDATE_BOT_LOOK=1 npx vitest run botLookSwift` writes it.
import { BOT_COLORS_WERE } from "../../../desktop/src/shared/contracts";
import { advanceRig, BOT_BODIES, BOT_COLOR_DEFAULT, BOT_PAINT, CROP, drawnAt, frameOf, newRig, setRigState } from "../../../desktop/src/shared/bot";

/** The sheet's avatar sizes (ShareView.swift): the Recent row's, then a chat row's. */
export const SIZES = [58, 40] as const;

/** Both eyes of a bot at rest in a `box` pt box: still, its look straight ahead, whatever its seed. */
export const restEyes = (box: number, seed = 1): readonly [string, string] => {
  const rig = newRig("idle", drawnAt(box), seed, false);
  setRigState(rig, "idle", true);
  for (let i = 0; i < 600; i++) advanceRig(rig, 1 / 60, true);
  return frameOf(rig).eyes;
};

const hex = (color: string): string => `0x${color.slice(1).toUpperCase()}`;
const quoted = (s: string): string => JSON.stringify(s);

export const botLookSwift = (): string => {
  const bodies = Object.entries(BOT_BODIES).map(([shape, d]) => `    ${quoted(shape)}: ${quoted(d)},`);
  // The same at each of the sheet's sizes (botLookSwift.test.ts): drawn larger, a bot's small-size rules are off.
  const [left, right] = restEyes(SIZES[0]);
  const paint = (Object.entries(BOT_PAINT) as [string, (typeof BOT_PAINT)[keyof typeof BOT_PAINT]][]).map(
    ([color, p]) => `    ${quoted(color)}: (light: (body: ${hex(p.light.body)}, eye: ${hex(p.light.eye)}), dark: (body: ${hex(p.dark.body)}, eye: ${hex(p.dark.eye)})),`,
  );
  const were = Object.entries(BOT_COLORS_WERE).map(([was, now]) => `    ${quoted(was)}: ${quoted(now ?? BOT_COLOR_DEFAULT)},`);
  return `// Generated from app/desktop/src/shared/bot.ts by botLookSwift.ts: don't edit it by hand. A bot as the app draws it at
// rest, in its 100-unit box: each shape's body, both eyes, and each color's paint.
enum BotLook {
  typealias Paint = (body: UInt32, eye: UInt32)

  /** The part of the 100 box a bot shows (CROP). */
  static let crop = (x: ${CROP.x.toFixed(1)}, y: ${CROP.y.toFixed(1)}, w: ${CROP.w.toFixed(1)})

  static let bodies: [String: String] = [
${bodies.join("\n")}
  ]

  static let eyes = (
    left: ${quoted(left)},
    right: ${quoted(right)}
  )

  static let paint: [String: (light: Paint, dark: Paint)] = [
${paint.join("\n")}
  ]

  /** Colors named otherwise once (BOT_COLORS_WERE). */
  static let were: [String: String] = [
${were.join("\n")}
  ]

  static let defaultShape = "pebble"
  static let defaultColor = ${quoted(BOT_COLOR_DEFAULT)}
}
`;
};
