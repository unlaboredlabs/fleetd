// Every screen's content kept out of the iPhone Duo's side strip (../split.ts sideStrip), where iOS puts the status and
// its bars' buttons in a column at the side: each navigator lays its screens out in StripRoom (screenLayout), so a
// screen added later keeps out of it too. The screen's ground still runs under the strip, edge to edge, and its native
// bar spans the window, so iOS moves the bar's Back and buttons into the column over that ground, not over a row. A
// screen that holds a navigator of its own (whose screens keep out themselves), or keeps out of the strip itself (the
// chat, with its buttons there), opts out with ownRoom.
import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { useStrip } from "./pane";

export function StripRoom({ children }: { children: ReactElement }) {
  const strip = useStrip();
  if (strip === undefined) return children;
  return <View style={[styles.fill, { paddingLeft: strip.left, paddingRight: strip.right }]}>{children}</View>;
}

/** A navigator's screenLayout: its screens in StripRoom. */
export const stripRoom = ({ children }: { children: ReactElement }): ReactElement => <StripRoom>{children}</StripRoom>;

/** A screen's layout that leaves it as it is: it keeps out of the strip itself, or holds a navigator that does. */
export const ownRoom = ({ children }: { children: ReactElement }): ReactElement => children;

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
