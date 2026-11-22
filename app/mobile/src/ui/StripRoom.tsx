// Every screen's content kept out of the iPhone Duo's side strip (../split.ts sideStrip), where iOS puts the status and
// its bars' buttons in a column at the side: each navigator lays its screens out in StripRoom (screenLayout), so a
// screen added later keeps out of it too. The screen's ground still runs under the strip, edge to edge, and its native
// bar spans the window, so iOS moves the bar's Back and buttons into the column over that ground, not over a row. A
// screen that holds a navigator of its own (whose screens keep out themselves), or keeps out of the strip itself (the
// chat, with its buttons there), opts out with ownRoom. A sheet keeps out by its own safe area instead (sheetRoom).
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import type { ReactElement } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useStrip } from "./pane";

export function StripRoom({ children }: { children: ReactElement }) {
  const strip = useStrip();
  if (strip === undefined) return children;
  return <View style={[styles.fill, { paddingLeft: strip.left, paddingRight: strip.right }]}>{children}</View>;
}

/**
 * A navigator's bars in the Duo's side-strip poses, for a stack of grouped pages: on the page's own ground. With no
 * status across the top, iOS stands the bar lower (its buttons' middle 47 pt down, measured on the real Duo) and its
 * background covers only its own frame, so the page showed above it as a grey band over a white bar (F1153). Elsewhere
 * iOS's own glass, as before.
 */
export const useStripBars = (ground: string): NativeStackNavigationOptions => (useStrip() === undefined ? {} : { headerStyle: { backgroundColor: ground } });

/** A navigator's screenLayout: its screens in StripRoom. */
export const stripRoom = ({ children }: { children: ReactElement }): ReactElement => <StripRoom>{children}</StripRoom>;

/** A screen's layout that leaves it as it is: it keeps out of the strip itself, or holds a navigator that does. */
export const ownRoom = ({ children }: { children: ReactElement }): ReactElement => children;

/**
 * A sheet's layout: its content kept out of the strip by the sheet's own left and right safe area, not the window's.
 * Folded, a sheet as wide as the screen runs under the strip and keeps out of it; a card centred on a wide window
 * touches neither side and stays centred. On a phone, held upright, those are none.
 */
export const sheetRoom = ({ children }: { children: ReactElement }): ReactElement => <SheetRoom style={styles.fill}>{children}</SheetRoom>;

/** A sheet's ground, its content kept out of the strip by the sheet's own safe area: a Modal's sheet starts with it. */
export function SheetRoom(props: ViewProps) {
  return <SafeAreaView edges={SIDES} {...props} />;
}

const SIDES = ["left", "right"] as const;

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
