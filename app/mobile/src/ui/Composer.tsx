// iMessage's composer: a pill to write in on the chat's own ground, above the keyboard and clear of the home
// indicator, with a round send button that shows once there is something to send. Return makes a new line; the
// button sends.
import { useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { space, type, useTheme } from "../theme";
import { haptics } from "./haptics";
import { Icon } from "./Icon";

export function Composer({ onSend, bottomInset, placeholder = "Message" }: { onSend: (text: string) => void; bottomInset: number; placeholder?: string }) {
  const t = useTheme();
  const [text, setText] = useState("");
  const ready = text.trim() !== "";
  // The send button grows in as the first letter is typed, and out when the text is gone.
  const shown = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(shown, { toValue: ready ? 1 : 0, useNativeDriver: Platform.OS !== "web", speed: 40, bounciness: 6 }).start();
  }, [ready, shown]);
  const send = () => {
    if (!ready) return;
    haptics.tap();
    onSend(text);
    setText("");
  };
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(bottomInset, space.sm), backgroundColor: t.bg }]}>
      <View style={[styles.pill, { borderColor: t.separator, backgroundColor: t.dark ? t.cell : t.bg }]}>
        <TextInput
          style={[type.body, styles.input, { color: t.label }]}
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={t.tertiary}
          multiline
          // Starts one line tall and grows: iOS and Android size to the text, a web textarea needs telling.
          {...(Platform.OS === "web" ? { rows: 1 } : {})}
          accessibilityLabel="Message"
          keyboardAppearance={t.dark ? "dark" : "light"}
        />
        <Animated.View style={[styles.sendSlot, { opacity: shown, transform: [{ scale: shown }] }]} pointerEvents={ready ? "auto" : "none"}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityElementsHidden={!ready}
            importantForAccessibility={ready ? "yes" : "no-hide-descendants"}
            onPress={send}
            hitSlop={8}
            style={({ pressed }) => [styles.send, { backgroundColor: t.accent }, pressed && styles.pressed]}
          >
            <Icon name="send" size={16} color="#FFFFFF" weight="bold" />
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space.md, paddingTop: space.sm },
  pill: {
    flexDirection: "row",
    alignItems: "flex-end",
    minHeight: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 14,
    paddingRight: 4,
  },
  input: { flex: 1, maxHeight: 140, paddingTop: 8, paddingBottom: 8, marginRight: space.xs },
  sendSlot: { marginBottom: 4 },
  send: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.7 },
});
