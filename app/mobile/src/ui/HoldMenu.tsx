// What a bubble or a chat row does when pressed and held: on iOS, iOS's own context menu (modules/context-menu), which
// lifts the view in its shape over a blurred screen as Messages does, on the main thread with nothing for JavaScript to
// do until an action is picked; elsewhere, Menu's drawn one, the view drawn again over a blur. VoiceOver gets the same
// actions as the view's own.
import { requireNativeView } from "expo";
import { useRef, useState, type ComponentRef, type ComponentType, type ReactNode } from "react";
import { Platform, Pressable, View, type NativeSyntheticEvent, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { sfSymbol } from "./Icon";
import { Menu, type MenuItem, type Rect } from "./Menu";

interface NativeProps {
  readonly actions: ReadonlyArray<{ id: string; title: string; systemImage: string; destructive: boolean }>;
  readonly menuTitle?: string | undefined;
  readonly previewRadius: number;
  readonly previewColor?: string | undefined;
  readonly onAction: (e: NativeSyntheticEvent<{ id: string }>) => void;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}

const NativeMenu: ComponentType<NativeProps> | null = Platform.OS === "ios" ? requireNativeView<NativeProps>("FleetdContextMenu") : null;

export function HoldMenu({
  items,
  title,
  radius,
  color,
  align = "left",
  onPress,
  accessibilityRole,
  accessibilityLabel,
  accessibilityHint,
  style,
  preview,
  children,
}: {
  items: readonly MenuItem[];
  /** A quiet line over the actions: when a message was sent. */
  title?: string | undefined;
  /** The lifted view's corner radius. */
  radius: number;
  /** What the lifted view stands on, for a view with no ground of its own (a chat row). */
  color?: string | undefined;
  align?: "left" | "right";
  onPress?: (() => void) | undefined;
  accessibilityRole?: "button" | undefined;
  accessibilityLabel?: string | undefined;
  accessibilityHint?: string | undefined;
  style?: PressableProps["style"];
  /** What the drawn menu lifts, when not the view as it is (a bubble without its tail). */
  preview?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  const [at, setAt] = useState<Rect | null>(null);
  const run = (label: string) => items.find((m) => m.label === label)?.onPress();
  const face = (
    <Pressable
      ref={ref}
      collapsable={false}
      onPress={onPress}
      {...(NativeMenu === null ? { onLongPress: () => ref.current?.measureInWindow((x: number, y: number, width: number, height: number) => setAt({ x, y, width, height })), delayLongPress: 300 } : {})}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityActions={items.map((m) => ({ name: m.label, label: m.label }))}
      onAccessibilityAction={(e) => run(e.nativeEvent.actionName)}
      style={style}
    >
      {children}
    </Pressable>
  );
  if (NativeMenu !== null) {
    const menu = (
      <NativeMenu
        actions={items.map((m) => ({ id: m.label, title: m.label, systemImage: sfSymbol(m.icon), destructive: m.destructive === true }))}
        menuTitle={title}
        previewRadius={radius}
        previewColor={color}
        onAction={(e) => run(e.nativeEvent.id)}
      >
        {face}
      </NativeMenu>
    );
    // iOS hides the view while it's lifted: its ground stays, so what lies under it (a row's swipe actions) doesn't show.
    return color === undefined ? menu : <View style={{ backgroundColor: color }}>{menu}</View>;
  }
  return (
    <>
      {face}
      <Menu at={at} preview={<View style={color === undefined ? null : { backgroundColor: color }}>{preview ?? children}</View>} items={items} title={title} align={align} onClose={() => setAt(null)} />
    </>
  );
}
