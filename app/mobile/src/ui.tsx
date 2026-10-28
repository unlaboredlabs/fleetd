// The few pieces every screen uses: a button, a screen header and the connection line.
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { HubState } from "./desktop";
import { color, size } from "./theme";

export function Button({ label, onPress, tone = "plain", disabled = false }: { label: string; onPress: () => void; tone?: "plain" | "accent" | "danger"; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, tone === "accent" && styles.accent, (pressed || disabled) && styles.dim]}
    >
      <Text style={[styles.buttonText, tone === "accent" && { color: color.onAccent }, tone === "danger" && { color: color.danger }]}>{label}</Text>
    </Pressable>
  );
}

export function Header({ title, detail, left, right }: { title: string; detail?: string | undefined; left?: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.header}>
      {left}
      <View style={styles.headerText}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {detail === undefined ? null : (
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
      {right}
    </View>
  );
}

export function TextButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={12} style={({ pressed }) => pressed && styles.dim}>
      <Text style={styles.link}>{label}</Text>
    </Pressable>
  );
}

/** Says what the link is doing when it isn't live; nothing while it is. */
export function ConnectionLine({ state, onPairAgain }: { state: HubState; onPairAgain: () => void }) {
  if (state.phase === "live" || state.phase === "unpaired") return null;
  const tone = state.phase === "refused" ? color.danger : color.warning;
  const text =
    state.phase === "connecting"
      ? "Connecting…"
      : state.phase === "retrying"
        ? `${state.reason}. Trying again…`
        : state.message;
  return (
    <View style={styles.line}>
      {state.phase === "connecting" ? <ActivityIndicator size="small" color={color.quiet} /> : null}
      <Text style={[styles.lineText, { color: tone }]}>{text}</Text>
      {state.phase === "refused" ? <TextButton label="Pair again" onPress={onPairAgain} /> : null}
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={styles.empty}>{text}</Text>;
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: "center",
  },
  accent: { backgroundColor: color.accentFill, borderColor: color.accentFill },
  dim: { opacity: 0.5 },
  buttonText: { color: color.text, fontSize: size.md, fontWeight: "600" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  headerText: { flex: 1 },
  title: { color: color.text, fontSize: size.lg, fontWeight: "600" },
  detail: { color: color.quiet, fontSize: size.xs, marginTop: 1 },
  link: { color: color.accent, fontSize: size.md },
  line: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 6, backgroundColor: color.raised },
  lineText: { flex: 1, fontSize: size.sm },
  empty: { color: color.quiet, fontSize: size.sm, padding: 16 },
});
