// The delete's confirm when uncommitted changes would be lost, as the desktop's: a sheet that names each worktree
// holding them, and Delete enabled only once the project's name is typed. Without such changes, the action sheet asks.
import { useState } from "react";
import { Modal, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { space, type, useTheme } from "../../theme";
import { Button } from "../../ui/Button";
import { ListRow, ListSection } from "../../ui/List";
import { deleteConfirmed, type DeleteWords } from "./model";
import { FieldRow, Symbol } from "./parts";

/**
 * `words` null: closed. On iOS `onDelete` runs once the sheet has gone (onDismiss), so the screens it pops never go
 * in the same commit as the sheet.
 */
export function TypedDelete({ words, name, onCancel, onDelete }: { words: DeleteWords | null; name: string; onCancel: () => void; onDelete: () => void }) {
  const t = useTheme();
  const [typed, setTyped] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const ready = deleteConfirmed(typed, name);
  const close = (deleting: boolean) => {
    if (!deleting) {
      setTyped("");
      return onCancel();
    }
    // Android's Modal has no onDismiss, and no native-stack sheet to collide with: delete at once there.
    if (Platform.OS !== "ios") return onDelete();
    setConfirmed(true);
  };
  return (
    <Modal
      visible={words !== null && !confirmed}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={() => close(false)}
      onDismiss={() => {
        if (confirmed) onDelete();
        setConfirmed(false);
        setTyped("");
      }}
    >
      {words === null ? null : (
        <ScrollView style={{ backgroundColor: t.grouped }} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.head}>
            <Symbol ios="exclamationmark.triangle.fill" android="warning" size={40} color={t.danger} />
            <Text style={[type.title3, styles.center, { color: t.label }]}>{words.title}</Text>
            <Text style={[type.subhead, styles.center, { color: t.secondary }]}>{words.message}</Text>
          </View>
          <ListSection header={words.unsaved.length === 1 ? "Uncommitted changes lost in" : "Uncommitted changes lost in these"}>
            {words.unsaved.map((w) => (
              <ListRow key={w} title={w} />
            ))}
          </ListSection>
          <ListSection header={`Type ${name} to confirm`}>
            <FieldRow value={typed} onChangeText={setTyped} placeholder={name} autoCapitalize="none" autoFocus accessibilityLabel={`Type ${name} to confirm`} />
          </ListSection>
          <View style={styles.actions}>
            <Button label={words.button} destructive size="large" disabled={!ready} onPress={() => close(true)} />
            <Button label="Cancel" kind="plain" size="large" onPress={() => close(false)} />
          </View>
        </ScrollView>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  body: { paddingTop: space.xl, paddingBottom: space.xxl },
  head: { alignItems: "center", gap: space.sm, paddingHorizontal: space.xl },
  center: { textAlign: "center" },
  actions: { gap: space.sm, marginHorizontal: space.lg, marginTop: space.xl },
});
