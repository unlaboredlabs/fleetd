// iMessage's bubble: the person's in the accent on the right, the lead's grey on the left, and the tail only on a
// burst's last. Its geometry is Messages' own, measured (../bubble.ts). The tail is iOS 26's hook under the bottom
// corner, two shapes: a turned bar in the bubble's color, then a circle of the ground over the pinch. No SVG needed.
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
      {tail ? (
        <>
          <View style={[styles.tail, mine ? styles.tailRight : styles.tailLeft, { backgroundColor: fill }]} />
          <View style={[styles.notch, mine ? styles.notchRight : styles.notchLeft, { backgroundColor: t.thread }]} />
        </>
      ) : null}
      {children}
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
  notch: { position: "absolute", bottom: -tail.notchDrop, width: tail.notch, height: tail.notch, borderRadius: tail.notch / 2 },
  notchRight: { right: -tail.notchInset },
  notchLeft: { left: -tail.notchInset },
  // Laid out as a bubble's words are, with its side padding, so the emoji line up with the bubbles around them.
  jumbo: { paddingHorizontal: bubble.padX },
  jumboOne: { fontSize: bubble.jumbo.one, lineHeight: bubble.jumbo.oneLineHeight },
  jumboFew: { fontSize: bubble.jumbo.few, lineHeight: bubble.jumbo.fewLineHeight },
});
