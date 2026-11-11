// A project's chat line when its lead changes the project's setup (repo_add, repo_remove, project_setup, W614): one
// quiet line with Open, to the project's Info, and Undo, which puts back what was there before. Nothing to approve.
// The hub re-sends the line marked undone, which replaces Undo with a word; only a failed Undo is kept here.
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSession } from "../hubContext";
import { refOf, type Key } from "../store";
import { space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { PRESSED_OPACITY } from "../ui/motion";
import { errorWords } from "./manage/parts";
import type { SetupLine } from "./setupChanged";

export function SetupChangedLine({ chatKey, messageId, line, onOpen }: { chatKey: Key; messageId: string; line: SetupLine; onOpen: () => void }) {
  const t = useTheme();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const undo = () => {
    haptics.tap();
    setBusy(true);
    setProblem(undefined);
    void session.call("project_setup_undo", { projectRef: refOf(chatKey), messageId }).then((r) => {
      setBusy(false);
      if (r.ok) return haptics.success();
      haptics.warning();
      setProblem(errorWords(r.error));
    });
  };
  return (
    <View style={styles.line}>
      <View style={styles.row}>
        <Text style={[type.footnote, styles.text, { color: t.secondary }]} accessibilityLabel={line.label}>
          {line.text}
        </Text>
        <Pressable accessibilityRole="link" accessibilityLabel="Open" accessibilityHint="Opens the project's settings" onPress={onOpen} hitSlop={8} style={({ pressed }) => pressed && { opacity: PRESSED_OPACITY }}>
          <Text style={[type.footnote, { color: t.link }]}>Open</Text>
        </Pressable>
        {line.undone ? (
          <Text style={[type.footnote, { color: t.secondary }]}>Undone</Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Undo"
            accessibilityHint="Puts back what was there before"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={undo}
            hitSlop={8}
            style={({ pressed }) => (pressed || busy) && { opacity: PRESSED_OPACITY }}
          >
            <Text style={[type.footnote, { color: t.link }]}>Undo</Text>
          </Pressable>
        )}
      </View>
      {problem === undefined ? null : (
        <Text style={[type.footnote, styles.problem, { color: t.danger }]} accessibilityRole="alert">
          {problem}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { marginVertical: space.sm, paddingHorizontal: space.xl, gap: 2 },
  row: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", flexWrap: "wrap", columnGap: space.sm, rowGap: 2 },
  text: { flexShrink: 1, textAlign: "center" },
  problem: { textAlign: "center" },
});
