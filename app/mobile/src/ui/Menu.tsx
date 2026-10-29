// A context menu as iOS 26 and Telegram draw one: what was pressed lifted over a blurred screen, and a glass menu of
// actions beside it (each a word, then its symbol). It fades in as the desktop's menus do (--dur-fast, ease-out) and
// closes at once. Tapping outside closes it; VoiceOver's escape gesture does too.
import { BlurView } from "expo-blur";
import { useEffect, type ReactNode } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { space, type, useTheme } from "../theme";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { dur, ease, useReduceMotion } from "./motion";

export interface MenuItem {
  readonly label: string;
  readonly icon: IconName;
  readonly onPress: () => void;
  readonly destructive?: boolean;
  /** Opens something of iOS's own (a picker, a sheet), which can't come up until the menu's window is gone. */
  readonly presents?: boolean;
}

/** How long the menu's window takes to go, before a picker or sheet can come up. */
const GONE_MS = 450;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const WIDTH = 250;
const ROW = 46;
const GAP = 8;

/** Where the lifted view and the menu go: the view stays where it was when it can, moved up or cut short when the menu wouldn't fit. */
export const placeMenu = (at: Rect, rows: number, screen: { width: number; height: number }, insets: { top: number; bottom: number }, align: "left" | "right") => {
  const menuH = rows * ROW;
  const top = insets.top + GAP;
  const bottom = screen.height - insets.bottom - GAP;
  const height = Math.min(at.height, bottom - top - menuH - GAP);
  const y = Math.max(top, Math.min(at.y, bottom - menuH - GAP - height));
  const left = align === "left" ? Math.max(space.md, at.x) : Math.min(screen.width - space.md - WIDTH, at.x + at.width - WIDTH);
  return { preview: { x: at.x, y, width: at.width, height }, menu: { x: Math.max(space.md, left), y: y + height + GAP } };
};

export function Menu({
  at,
  items,
  onClose,
  preview,
  align = "left",
  above = false,
  title,
}: {
  /** Where the pressed view is on screen; null: closed. */
  at: Rect | null;
  items: readonly MenuItem[];
  onClose: () => void;
  /** The pressed view, drawn again over the blur. */
  preview?: ReactNode;
  align?: "left" | "right";
  /** Over what was pressed rather than under it, as a menu from the composer's button. */
  above?: boolean;
  /** A quiet line over the actions: when a message was sent. */
  title?: string | undefined;
}) {
  const t = useTheme();
  const screen = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  useEffect(() => {
    if (at !== null) haptics.firm();
  }, [at]);
  if (at === null) return null;
  const rows = items.length + (title === undefined ? 0 : 1);
  const place = above ? { preview: at, menu: { x: Math.max(space.md, at.x), y: at.y - rows * ROW - GAP } } : placeMenu(at, rows, screen, insets, align);
  const fade = FadeIn.duration(reduce ? 0 : dur.fast).easing(ease.out);
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View entering={fade} style={StyleSheet.absoluteFill}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close menu">
          {Platform.OS === "ios" ? (
            <BlurView style={StyleSheet.absoluteFill} tint={t.dark ? "systemThinMaterialDark" : "systemThinMaterialLight"} intensity={60} />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.4)" }]} />
          )}
        </Pressable>
        {preview === undefined ? null : (
          <View pointerEvents="none" style={[styles.preview, { left: place.preview.x, top: place.preview.y, width: place.preview.width, height: place.preview.height }]}>
            {preview}
          </View>
        )}
        <Glass style={[styles.menu, { left: place.menu.x, top: place.menu.y }]}>
          <View accessibilityRole="menu" accessibilityViewIsModal>
            {title === undefined ? null : (
              <View style={styles.titleRow}>
                <Text style={[type.footnote, { color: t.secondary }]} numberOfLines={2}>
                  {title}
                </Text>
              </View>
            )}
            {items.map((item, i) => (
              <Pressable
                key={item.label}
                accessibilityRole="menuitem"
                accessibilityLabel={item.label}
                onPress={() => {
                  onClose();
                  if (item.presents === true) setTimeout(item.onPress, GONE_MS);
                  else item.onPress();
                }}
                style={({ pressed }) => [styles.row, (i > 0 || title !== undefined) && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.separator }, pressed && { backgroundColor: t.fill }]}
              >
                <Text style={[type.body, styles.label, { color: item.destructive === true ? t.danger : t.label }]} numberOfLines={1}>
                  {item.label}
                </Text>
                <Icon name={item.icon} size={19} color={item.destructive === true ? t.danger : t.label} />
              </Pressable>
            ))}
          </View>
        </Glass>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  preview: { position: "absolute", overflow: "hidden" },
  menu: { position: "absolute", width: WIDTH, borderRadius: 22, borderCurve: "continuous", overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", height: ROW, paddingHorizontal: space.lg, gap: space.md },
  label: { flex: 1 },
  titleRow: { height: ROW, justifyContent: "center", paddingHorizontal: space.lg },
});
