// Rename, pushed from a project's screen, as iOS Settings' Name: one field, and a ✓ that saves it
// (project_settings_set's title). Its folder keeps its name; the hub's project.settings event brings
// the new one to the chats list and the chat.
import { useLayoutEffect, useState } from "react";
import { ScrollView } from "react-native";
import { NAME_MAX, nameProblem, type HubError } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListSection } from "../../ui/List";
import { rename } from "./api";
import { errorWords, FieldRow, Problem, sheetOptions } from "./parts";

export function Rename({ navigation, route }: ChatInfoProps<"Rename">) {
  const t = useTheme();
  const { state, session } = useHub();
  const p = state.projects?.[route.params.key];
  const [name, setName] = useState(p?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const problem = nameProblem(name);
  const ready = p !== undefined && problem === undefined && name.trim() !== "" && name.trim() !== p.title;

  const save = async () => {
    if (p === undefined || !ready || busy) return;
    setBusy(true);
    setError(null);
    const r = await rename(session, p, name.trim());
    setBusy(false);
    if (!r.ok) {
      haptics.warning();
      return setError(r.error);
    }
    haptics.success();
    navigation.goBack();
  };

  useLayoutEffect(() => {
    navigation.setOptions(sheetOptions(t, undefined, { label: "Save", enabled: ready, busy, onPress: () => void save() }));
    // `save` reads what these are.
  }, [navigation, t, ready, busy, name]);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.xxl }} style={{ backgroundColor: t.grouped }}>
      <ListSection footer="Its chat, memory and folder stay as they are; only what you call it changes.">
        <FieldRow
          value={name}
          onChangeText={setName}
          autoFocus
          selectTextOnFocus
          maxLength={NAME_MAX + 1}
          autoCapitalize="words"
          returnKeyType="done"
          editable={!busy}
          invalid={problem !== undefined}
          onSubmitEditing={() => void save()}
          accessibilityLabel="Name"
        />
      </ListSection>
      <Problem text={problem ?? (error === null ? undefined : `Not renamed: ${errorWords(error)}`)} />
    </ScrollView>
  );
}
