// Chrome that floats over content (the composer, the scroll-to-bottom button, menus, banners): iOS 26's Liquid
// Glass, a material blur on older iOS, and a translucent fill on Android. With Reduce Transparency iOS draws the glass
// frosted by itself.
import { BlurView } from "expo-blur";
import { GlassContainer, GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme";

/** Whether this phone draws Liquid Glass. */
export const liquidGlass = Platform.OS === "ios" && isLiquidGlassAvailable();

export function Glass({
  children,
  style,
  interactive = false,
  tint,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Reacts to touch as iOS's glass buttons do. */
  interactive?: boolean;
  /** Tinted glass, as a primary glass button. */
  tint?: string;
}) {
  const t = useTheme();
  if (liquidGlass) {
    return (
      <GlassView style={style} glassEffectStyle="regular" isInteractive={interactive} {...(tint === undefined ? {} : { tintColor: tint })}>
        {children}
      </GlassView>
    );
  }
  if (Platform.OS === "ios") {
    return (
      <BlurView style={[style, styles.clip, tint === undefined ? null : { backgroundColor: tint }]} tint={t.dark ? "systemChromeMaterialDark" : "systemChromeMaterialLight"} intensity={100}>
        {children}
      </BlurView>
    );
  }
  return <View style={[style, styles.clip, { backgroundColor: tint ?? t.chrome }]}>{children}</View>;
}

/** Glass shapes near each other that merge as they meet, as iOS 26's grouped buttons. */
export function GlassGroup({ children, style, spacing = 8 }: { children: ReactNode; style?: StyleProp<ViewStyle>; spacing?: number }) {
  return liquidGlass ? (
    <GlassContainer style={style} spacing={spacing}>
      {children}
    </GlassContainer>
  ) : (
    <View style={style}>{children}</View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
});
