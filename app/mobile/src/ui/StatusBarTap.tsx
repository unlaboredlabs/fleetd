// iOS's tap on the status bar, heard by a scroll view of its own, a point tall across the top of the screen, under the
// status bar. iOS sends the tap to the one scroll view under where it was tapped that takes it, and scrolls that to its
// top; a chat's thread is upside down, so its top would be the newest end, and the thread says no (scrollsToTop
// false), as does any scroll view inside it. This one scrolls a point to its top, says so, and is put back a point
// down for the next tap. It isn't pointerEvents "none": iOS looks for it by hit-testing.
import { useRef, type ComponentRef } from "react";
import { Platform, ScrollView, StyleSheet } from "react-native";

export function StatusBarTap({ onTap }: { onTap: () => void }) {
  const view = useRef<ComponentRef<typeof ScrollView>>(null);
  if (Platform.OS !== "ios") return null;
  return (
    <ScrollView
      ref={view}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.tap}
      contentContainerStyle={styles.content}
      contentOffset={{ x: 0, y: 1 }}
      showsVerticalScrollIndicator={false}
      scrollsToTop
      onScrollToTop={() => {
        view.current?.scrollTo({ y: 1, animated: false });
        onTap();
      }}
    />
  );
}

const styles = StyleSheet.create({
  tap: { position: "absolute", top: 0, left: 0, right: 0, height: 1 },
  content: { height: 3 },
});
