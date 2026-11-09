// iMessage's bubble: the person's in the deep accent on the right, the lead's grey on the left, a plain rounded shape
// with no tail on either side. Its geometry is Messages' own, measured (../bubble.ts).
// No time inside it, as Messages has none: bubbles size to their words alone. A few emoji alone draw big, with no
// bubble (Jumbo).
import type { ReactNode } from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { bubble, bubbleMax } from "../bubble";
import { useTheme } from "../theme";

export function Bubble({ side, children, tone }: { side: "me" | "them"; children: ReactNode; tone?: "accent" | "neutral" | "danger" }) {
  const t = useTheme();
  const shade = tone ?? (side === "me" ? "accent" : "neutral");
  const fill = shade === "accent" ? t.accentDeep : shade === "danger" ? t.danger : t.bubble;
  const mine = side === "me";
  const { width } = useWindowDimensions();
  return (
    <View style={[styles.bubble, { backgroundColor: fill, maxWidth: bubbleMax(width) }, mine ? styles.mine : styles.theirs]}>
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

const styles = StyleSheet.create({
  bubble: { borderRadius: bubble.radius, borderCurve: "continuous", paddingHorizontal: bubble.padX, paddingVertical: bubble.padY },
  mine: { alignSelf: "flex-end" },
  theirs: { alignSelf: "flex-start" },
  // Laid out as a bubble's words are, with its side padding, so the emoji line up with the bubbles around them.
  jumbo: { paddingHorizontal: bubble.padX },
  jumboOne: { fontSize: bubble.jumbo.one, lineHeight: bubble.jumbo.oneLineHeight },
  jumboFew: { fontSize: bubble.jumbo.few, lineHeight: bubble.jumbo.fewLineHeight },
});
