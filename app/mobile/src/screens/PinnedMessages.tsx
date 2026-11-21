// A chat's pinned messages on the phone (messagePins.ts): the small glass capsule under the chat's name with the newest
// pin's first line, as Telegram's pinned bar but floating, and the Pinned sheet that several pins open, newest pinned
// first, each row going to its message; held, a row offers Unpin. Nothing shows with no pins.
import { ActionSheetIOS, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { bubbleTime, listTime } from "../chatView";
import type { ChatMessagePin } from "../desktop";
import { whoOf } from "../chatFind";
import { capsuleLabel, pinLine, pinnedByLine, type PinCapsule } from "../messagePins";
import { shape, space, type, useTheme } from "../theme";
import { Button } from "../ui/Button";
import { Glass } from "../ui/Glass";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { useNow } from "./time";

/** The capsule's height, and the room it takes under the bar with its gap. */
const CAPSULE = 34;
export const PIN_ROOM = CAPSULE + 8;

/** The capsule: the pin glyph, the newest pin's line, and how many there are when more than one. */
export function PinCapsuleView({ capsule, onPress }: { capsule: PinCapsule; onPress: () => void }) {
  const t = useTheme();
  return (
    <Glass interactive appear style={styles.capsuleGlass}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={capsuleLabel(capsule)}
        accessibilityHint={capsule.goesTo === undefined ? "Shows the pinned messages" : "Goes to the message"}
        onPress={() => {
          haptics.tap();
          onPress();
        }}
        style={styles.capsule}
      >
        <Icon name="pinned" size={12} color={t.accent} weight="semibold" />
        <Text style={[type.footnote, styles.line, { color: t.label }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {capsule.line}
        </Text>
        {capsule.count > 1 ? (
          <Text style={[type.footnote, styles.count, { color: t.secondary }]} maxFontSizeMultiplier={1.3}>
            {String(capsule.count)}
          </Text>
        ) : null}
      </Pressable>
    </Glass>
  );
}

/** The Pinned sheet: each pin's line, who pinned it and when; a tap goes to its message, a hold offers Unpin. */
export function PinnedSheet({
  pins,
  open,
  me,
  title,
  canUnpin,
  onClose,
  onGo,
  onUnpin,
}: {
  pins: readonly ChatMessagePin[];
  open: boolean;
  me: string | undefined;
  /** The chat's name: whose a lead's message is. */
  title: string;
  canUnpin: boolean;
  onClose: () => void;
  onGo: (messageId: string) => void;
  onUnpin: (messageId: string) => void;
}) {
  const t = useTheme();
  const now = useNow();
  if (!open) return null;
  const unpin = (pin: ChatMessagePin) => {
    if (!canUnpin) return;
    haptics.tap();
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ message: pinLine(pin), options: ["Unpin", "Cancel"], destructiveButtonIndex: 0, cancelButtonIndex: 1 }, (i) => {
        if (i === 0) onUnpin(pin.messageId);
      });
    } else {
      Alert.alert("Unpin?", pinLine(pin), [
        { text: "Cancel", style: "cancel" },
        { text: "Unpin", style: "destructive", onPress: () => onUnpin(pin.messageId) },
      ]);
    }
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.fill, { backgroundColor: t.grouped }]} onAccessibilityEscape={onClose}>
        <View style={styles.head}>
          <Text style={[type.headline, { color: t.label }]} accessibilityRole="header">
            Pinned
          </Text>
          <Button label="Done" kind="plain" onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          {pins.length === 0 ? (
            <Text style={[type.subhead, styles.none, { color: t.secondary }]}>No Pinned Messages</Text>
          ) : (
            <View style={[styles.group, { backgroundColor: t.cell }]}>
              {pins.map((pin, i) => {
                const who = whoOf(pin, me, title);
                const by = pinnedByLine(pin, me, listTime(pin.pinnedAt, now));
                return (
                  <View key={pin.messageId}>
                    {i === 0 ? null : <View style={[styles.separator, { backgroundColor: t.separator }]} />}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${who}, ${pinLine(pin)}. ${by}`}
                      accessibilityHint="Goes to the message"
                      accessibilityActions={canUnpin ? [{ name: "unpin", label: "Unpin" }] : []}
                      onAccessibilityAction={(e) => {
                        if (e.nativeEvent.actionName === "unpin") onUnpin(pin.messageId);
                      }}
                      onPress={() => {
                        haptics.tap();
                        onGo(pin.messageId);
                      }}
                      onLongPress={() => unpin(pin)}
                      style={({ pressed }) => [styles.row, pressed && { backgroundColor: t.fillQuiet }]}
                    >
                      <View style={styles.rowTop}>
                        <Text style={[type.subhead, styles.who, { color: t.label }]} numberOfLines={1}>
                          {who}
                        </Text>
                        <Text style={[type.footnote, { color: t.secondary }]}>{bubbleTime(pin.createdAt, now)}</Text>
                      </View>
                      <Text style={[type.body, { color: t.label }]} numberOfLines={2}>
                        {pinLine(pin)}
                      </Text>
                      <Text style={[type.footnote, { color: t.secondary }]} numberOfLines={1}>
                        {by}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  capsuleGlass: { borderRadius: CAPSULE / 2, borderCurve: "continuous", maxWidth: "78%" },
  capsule: { flexDirection: "row", alignItems: "center", gap: 6, height: CAPSULE, paddingLeft: 12, paddingRight: 14 },
  line: { flexShrink: 1 },
  count: { fontVariant: ["tabular-nums"], fontWeight: "600" },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm },
  list: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl },
  group: { borderRadius: shape.group, borderCurve: "continuous", overflow: "hidden" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
  row: { gap: 2, paddingHorizontal: space.lg, paddingVertical: 11 },
  rowTop: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  who: { flex: 1, fontWeight: "600" },
  none: { textAlign: "center", marginTop: space.xxl },
});
