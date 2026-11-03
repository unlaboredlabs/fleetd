// A published artifact's card in the chat (W367): its format's tile, its title over its format, version and who, and
// the time. Tapping it opens that version over the chat's Info, as a link to it does.
import { Pressable, StyleSheet, Text, View } from "react-native";
import { bubble } from "../../bubble";
import { space, type, useTheme } from "../../theme";
import { PRESSED_OPACITY } from "../../ui/motion";
import { ArtifactTile } from "./Artifacts";
import { cardLine, type ArtifactPublished } from "./model";

export function ArtifactCard({ published, when, onPress }: { published: ArtifactPublished; when: string; onPress: () => void }) {
  const t = useTheme();
  const line = cardLine(published);
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${published.title}, ${line}, ${when}`}
        accessibilityHint="Opens it"
        onPress={onPress}
        style={({ pressed }) => [styles.card, { backgroundColor: t.surface }, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <ArtifactTile format={published.format} size={34} />
        <View style={styles.words}>
          <Text style={[type.body, styles.title, { color: t.label }]} numberOfLines={2}>
            {published.title}
          </Text>
          <Text style={[type.footnote, { color: t.secondary }]} numberOfLines={1}>
            {`${line} · ${when}`}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: bubble.margin, paddingTop: space.sm, alignItems: "flex-start" },
  card: { flexDirection: "row", alignItems: "center", gap: space.md, maxWidth: "82%", minWidth: "60%", borderRadius: 18, borderCurve: "continuous", paddingVertical: 10, paddingLeft: 10, paddingRight: space.lg },
  words: { flexShrink: 1, gap: 1 },
  title: { fontWeight: "600" },
});
