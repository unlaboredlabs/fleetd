// iMessage's bubble: the person's in the accent on the right, the lead's grey on the left, and the tail only on a
// burst's last. The tail is two shapes, the bubble's color and then the ground's over it, as iMessage's web clones draw
// it: no SVG needed.
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "../theme";

export function Bubble({ side, tail, children, tone }: { side: "me" | "them"; tail: boolean; children: ReactNode; tone?: "accent" | "neutral" | "danger" }) {
  const t = useTheme();
  const shade = tone ?? (side === "me" ? "accent" : "neutral");
  const fill = shade === "accent" ? t.accent : shade === "danger" ? t.danger : t.bubble;
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
    </View>
  );
}

const styles = StyleSheet.create({
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
