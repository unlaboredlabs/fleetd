// A round button whose tap opens a menu, as the composer's +: on iOS 26, UIKit's own glass button and menu
// (modules/context-menu's FleetdMenuButton), which grows out of the button with nothing blurred behind it and gives
// iOS's own feedback; elsewhere, a glass circle and Menu's drawn one above it. VoiceOver gets the menu's actions on the
// button either way.
import { requireNativeView } from "expo";
import { useRef, useState, type ComponentRef, type ComponentType } from "react";
import { Pressable, StyleSheet, View, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme";
import { Glass, liquidGlass } from "./Glass";
import { Icon, sfSymbol, type IconName } from "./Icon";
import { Menu, type MenuItem, type Rect } from "./Menu";

interface NativeProps {
  readonly actions: ReadonlyArray<{ id: string; title: string; systemImage: string; destructive: boolean }>;
  readonly systemImage: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly onAction: (e: NativeSyntheticEvent<{ id: string }>) => void;
  readonly style?: StyleProp<ViewStyle>;
}

const NativeButton: ComponentType<NativeProps> | null = liquidGlass ? requireNativeView<NativeProps>("FleetdMenuButton") : null;

export function MenuButton({
  icon,
  label,
  hint,
  items,
  size,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  items: readonly MenuItem[];
  /** The circle's side. */
  size: number;
}) {
  const t = useTheme();
  const ref = useRef<ComponentRef<typeof View>>(null);
  const [at, setAt] = useState<Rect | null>(null);
  const circle = { width: size, height: size, borderRadius: size / 2 };
  if (NativeButton !== null) {
    return (
      <NativeButton
        actions={items.map((m) => ({ id: m.label, title: m.label, systemImage: sfSymbol(m.icon), destructive: m.destructive === true }))}
        systemImage={sfSymbol(icon)}
        label={label}
        hint={hint}
        // The menu has gone by now, so what an action presents comes straight up.
        onAction={(e) => items.find((m) => m.label === e.nativeEvent.id)?.onPress()}
        style={circle}
      />
    );
  }
  return (
    <View ref={ref} collapsable={false}>
      <Glass interactive style={circle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={hint}
          accessibilityActions={items.map((m) => ({ name: m.label, label: m.label }))}
          onAccessibilityAction={(e) => items.find((m) => m.label === e.nativeEvent.actionName)?.onPress()}
          style={styles.hit}
          // Menu buzzes as it opens: one haptic for one press.
          onPress={() => ref.current?.measureInWindow((x: number, y: number, width: number, height: number) => setAt({ x, y, width, height }))}
        >
          <Icon name={icon} size={20} color={t.label} weight="medium" />
        </Pressable>
      </Glass>
      <Menu above at={at} onClose={() => setAt(null)} items={items} />
    </View>
  );
}

const styles = StyleSheet.create({
  hit: { flex: 1, alignItems: "center", justifyContent: "center" },
});
