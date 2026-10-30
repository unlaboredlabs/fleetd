// iMessage's bubble: the person's in the accent on the right, the lead's grey on the left, and the tail only on a
// burst's last. The tail is two shapes, the bubble's color and then the ground's over it, as iMessage's web clones draw
// it: no SVG needed.
// `time` sits small in the bubble's bottom corner, as Telegram's; the text leaves room for it (Markdown's `room`).
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { type, useTheme } from "../theme";

export function Bubble({ side, tail, children, tone, time }: { side: "me" | "them"; tail: boolean; children: ReactNode; tone?: "accent" | "neutral" | "danger"; time?: string | undefined }) {
  const t = useTheme();
  const shade = tone ?? (side === "me" ? "accent" : "neutral");
  const fill = shade === "accent" ? t.accentFill : shade === "danger" ? t.danger : t.bubble;
  const mine = side === "me";
  return (
    <View style={[styles.bubble, { backgroundColor: fill }, mine ? styles.mine : styles.theirs]}>
      {tail ? (
        <>
          <View style={[styles.tail, mine ? styles.tailRight : styles.tailLeft, { backgroundColor: fill }]} />
          <View style={[styles.mask, mine ? styles.maskRight : styles.maskLeft, { backgroundColor: t.bg }]} />
        </>
      ) : null}
      {children}
      {time === undefined ? null : (
        <Text style={[type.caption2, styles.time, { color: shade === "neutral" ? t.secondary : "rgba(255,255,255,0.75)" }]} maxFontSizeMultiplier={1.4} accessible={false}>
          {time}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  time: { position: "absolute", right: 11, bottom: 5, fontVariant: ["tabular-nums"] },
  bubble: { borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7, maxWidth: "100%" },
  mine: { alignSelf: "flex-end" },
  theirs: { alignSelf: "flex-start" },
  tail: { position: "absolute", bottom: 0, width: 20, height: 20 },
  tailRight: { right: -7, borderBottomLeftRadius: 16 },
  tailLeft: { left: -7, borderBottomRightRadius: 16 },
  mask: { position: "absolute", bottom: 0, width: 26, height: 24 },
  maskRight: { right: -26, borderBottomLeftRadius: 12 },
  maskLeft: { left: -26, borderBottomRightRadius: 12 },
});
