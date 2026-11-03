// A bar drawn over a list's edge, with iOS 26's scroll edge effect under it (modules/context-menu's FleetdEdgeEffect):
// the list blurs away beneath the bar as under the system's own bars. Older iOS and Android get `fallback`, the
// painted fade they had before.
import { requireNativeView } from "expo";
import type { ComponentType, ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { liquidGlass } from "./Glass";

interface NativeProps {
  readonly scrollViewTag: number | null;
  readonly edge: "top" | "bottom";
  readonly pointerEvents?: "box-none";
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: ReactNode;
}

const Native: ComponentType<NativeProps> | null = liquidGlass ? requireNativeView<NativeProps>("FleetdEdgeEffect") : null;

/** Whether the system draws the effect, so a screen leaves out its own fades. */
export const edgeEffects = Native !== null;

export function EdgeEffect({
  list,
  edge,
  style,
  fallback,
  children,
}: {
  /** The list's native tag (findNodeHandle), once it is mounted. */
  list: number | null;
  /** The list's edge the bar covers, as the list sees it: an inverted list's top is on screen at the bottom. */
  edge: "top" | "bottom";
  style?: StyleProp<ViewStyle>;
  fallback?: ReactNode;
  children?: ReactNode;
}) {
  if (Native === null) {
    return (
      <View style={style} pointerEvents="box-none">
        {fallback}
        {children}
      </View>
    );
  }
  return (
    <Native scrollViewTag={list} edge={edge} style={style} pointerEvents="box-none">
      {children}
    </Native>
  );
}
