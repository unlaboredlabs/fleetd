// iMessage's composer: a pill to write in and a round send button inside it, on a translucent bar over the thread,
// above the keyboard and clear of the home indicator. Return makes a new line; the button sends.
import { BlurView } from "expo-blur";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { space, type, useTheme } from "../theme";
import { Icon } from "./Icon";

export function Composer({ onSend, bottomInset, placeholder = "Message" }: { onSend: (text: string) => void; bottomInset: number; placeholder?: string }) {
  const t = useTheme();
  const [text, setText] = useState("");
  const ready = text.trim() !== "";
  const send = () => {
    if (!ready) return;
    onSend(text);
    setText("");
  };
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(bottomInset, space.sm) }]}>
      {Platform.OS === "ios" ? (
        <BlurView tint="systemChromeMaterial" intensity={100} style={StyleSheet.absoluteFill} />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg }]} />
      )}
      <View style={[styles.pill, { borderColor: t.separator, backgroundColor: t.dark ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.7)" }]}>
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={send}
          hitSlop={8}
          style={({ pressed }) => [styles.send, { backgroundColor: ready ? t.accent : t.fill }, pressed && styles.pressed]}
        >
          <Icon name="send" size={16} color="#FFFFFF" weight="bold" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space.md, paddingTop: 7, overflow: "hidden" },
  pill: {
    flexDirection: "row",
    alignItems: "flex-end",
    minHeight: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 14,
    paddingRight: 3,
  },
  input: { flex: 1, maxHeight: 132, paddingTop: 7, paddingBottom: 7, marginRight: space.xs },
  send: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", marginBottom: 2 },
  pressed: { opacity: 0.7 },
});
