// iMessage's bubble: the person's in the accent on the right, the lead's grey on the left, and the tail only on a
// burst's last. Its geometry is Messages' own, measured (../bubble.ts). The tail is iOS 26's hook under the bottom
// corner, two shapes: a turned bar in the bubble's color, then a circle of the ground over the pinch. No SVG needed.
// A picture's tail is cut from the picture, as Messages': the bar shows it through (Tail's `picture`).
// No time inside it, as Messages has none: bubbles size to their words alone. A few emoji alone draw big, with no
// bubble (Jumbo).
import type { ReactNode } from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { bubble, bubbleMax } from "../bubble";
import { useTheme } from "../theme";

export function Bubble({ side, tail, children, tone }: { side: "me" | "them"; tail: boolean; children: ReactNode; tone?: "accent" | "neutral" | "danger" }) {
  const t = useTheme();
  const shade = tone ?? (side === "me" ? "accent" : "neutral");
  const fill = shade === "accent" ? t.accentFill : shade === "danger" ? t.danger : t.bubble;
  const mine = side === "me";
  const { width } = useWindowDimensions();
  return (
    <View style={[styles.bubble, { backgroundColor: fill, maxWidth: bubbleMax(width) }, mine ? styles.mine : styles.theirs]}>
      {tail ? <Tail side={side} fill={fill} /> : null}
      {children}
    </View>
  );
}

/**
 * A burst's last tail, under the bottom corner of what holds it: in `fill`, or a picture showing through. `picture` is
 * drawn in the holder's box (`size`), reaching TAIL_REACH below it, so the tail shows the picture's own pixels there.
 */
export function Tail({ side, fill, picture }: { side: "me" | "them"; fill?: string; picture?: { node: ReactNode; size: { width: number; height: number } } }) {
  const t = useTheme();
  const mine = side === "me";
  return (
    <>
      <View style={[styles.tail, mine ? styles.tailRight : styles.tailLeft, fill === undefined ? styles.clip : { backgroundColor: fill }]}>
        {picture === undefined ? null : <Through mine={mine} size={picture.size}>{picture.node}</Through>}
      </View>
      <View style={[styles.notch, mine ? styles.notchRight : styles.notchLeft, { backgroundColor: t.thread }]} />
    </>
  );
}

/** How far a tail reaches below what holds it: a picture with a tail is drawn this much taller, and cut. */
export const TAIL_REACH = 8;

/**
 * Inside the turned bar, the picture back where it is under it: a frame centred on the bar, turned back, so the
 * picture lands in the holder's place without turning.
 */
function Through({ mine, size, children }: { mine: boolean; size: { width: number; height: number }; children: ReactNode }) {
  const frame = 2 * (size.width + size.height + TAIL_REACH);
  // The bar's middle, in the holder's box.
  const x = mine ? size.width - tail.inset - tail.width / 2 : tail.inset + tail.width / 2;
  const y = size.height + tail.drop - tail.height / 2;
  return (
    <View style={{ position: "absolute", left: tail.width / 2 - frame / 2, top: tail.height / 2 - frame / 2, width: frame, height: frame, transform: [{ rotate: `${String(mine ? -tail.angle : tail.angle)}deg` }] }}>
      <View style={{ position: "absolute", left: frame / 2 - x, top: frame / 2 - y }}>{children}</View>
    </View>
  );
}

/** Emoji alone, as Messages draws one to three of them (`count`): big, on the ground. */
export function Jumbo({ side, text, count }: { side: "me" | "them"; text: string; count: number }) {
  return (
    <View style={[styles.jumbo, side === "me" ? styles.mine : styles.theirs]}>
      <Text style={count === 1 ? styles.jumboOne : styles.jumboFew} maxFontSizeMultiplier={1.2}>
        {text.trim()}
      </Text>
    </View>
  );
}

const tail = bubble.tail;

const styles = StyleSheet.create({
  bubble: { borderRadius: bubble.radius, borderCurve: "continuous", paddingHorizontal: bubble.padX, paddingVertical: bubble.padY },
  mine: { alignSelf: "flex-end" },
  theirs: { alignSelf: "flex-start" },
  tail: { position: "absolute", bottom: -tail.drop, width: tail.width, height: tail.height },
  tailRight: { right: tail.inset, borderBottomRightRadius: tail.tipRadius, transform: [{ rotate: `${String(tail.angle)}deg` }] },
  tailLeft: { left: tail.inset, borderBottomLeftRadius: tail.tipRadius, transform: [{ rotate: `${String(-tail.angle)}deg` }] },
  clip: { overflow: "hidden" },
  notch: { position: "absolute", bottom: -tail.notchDrop, width: tail.notch, height: tail.notch, borderRadius: tail.notch / 2 },
  notchRight: { right: -tail.notchInset },
  notchLeft: { left: -tail.notchInset },
  // Laid out as a bubble's words are, with its side padding, so the emoji line up with the bubbles around them.
  jumbo: { paddingHorizontal: bubble.padX },
  jumboOne: { fontSize: bubble.jumbo.one, lineHeight: bubble.jumbo.oneLineHeight },
  jumboFew: { fontSize: bubble.jumbo.few, lineHeight: bubble.jumbo.fewLineHeight },
});
