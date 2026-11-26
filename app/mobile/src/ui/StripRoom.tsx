// Every screen's content kept out of the iPhone Duo's side strip (../split.ts sideStrip), where iOS puts the status and
// its bars' buttons in a column at the side: each navigator lays its screens out in StripRoom (screenLayout), so a
// screen added later keeps out of it too. The screen's ground still runs under the strip, edge to edge, and its native
// bar spans the window, so iOS moves the bar's Back and buttons into the column over that ground, not over a row. A
// screen that holds a navigator of its own (whose screens keep out themselves), or keeps out of the strip itself (the
// chat, with its buttons there), opts out with ownRoom. A sheet keeps out where it spans the window (sheetRoom). Each of
// these lays its screen out in a Caught too (Caught.tsx), so a screen whose drawing throws says so and the app goes on.
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import type { ReactElement } from "react";
import { StyleSheet, useWindowDimensions, View, type ViewProps } from "react-native";
import { sheetStrip } from "../split";
import { caught, type Leave } from "./Caught";
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
export const useStripBars = (ground: string): NativeStackNavigationOptions =>
  // Both the bar and its large title's, which iOS draws from the scroll edge's look while the title is expanded.
  useStrip() === undefined ? {} : { headerStyle: { backgroundColor: ground }, headerLargeStyle: { backgroundColor: ground } };

/** What a navigator gives a screen's layout: the screen, and its route, which names it. */
type Laid = { readonly children: ReactElement; readonly route: { readonly name: string }; readonly navigation: Leave };

/** A navigator's screenLayout: its screens in StripRoom. */
export const stripRoom = ({ children, route, navigation }: Laid): ReactElement => caught(route.name, <StripRoom>{children}</StripRoom>, navigation);

/** A screen's layout that leaves it as it is: it keeps out of the strip itself, or holds a navigator that does. */
export const ownRoom = ({ children, route, navigation }: Laid): ReactElement => caught(route.name, children, navigation);

/**
 * A sheet's layout: its content kept out of the strip where the sheet spans the window. Folded, a sheet as wide as the
 * screen runs under the strip and keeps out of it; a card centred on a wide window touches neither side and stays
 * centred. On a phone, held upright, there is none.
 */
export const sheetRoom = ({ children, route, navigation }: Laid): ReactElement => caught(route.name, <SheetRoom style={styles.fill}>{children}</SheetRoom>, navigation);

/**
 * A sheet's ground, its content kept out of the window's strip where the window is a phone's width (split.ts sheetStrip):
 * a Modal's sheet starts with it. Not by the sheet's own safe area, whose side insets went stale across a fold and
 * padded the sheet's rows from the side long after the strip had gone.
 */
export function SheetRoom({ children, style, ...props }: ViewProps) {
  const strip = sheetStrip(useStrip(), useWindowDimensions().width);
  return (
    <View style={[style, strip !== undefined && { paddingLeft: strip.left, paddingRight: strip.right }]} {...props}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
