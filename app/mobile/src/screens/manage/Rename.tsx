// Rename, pushed from a project's or a Navi's screen, as iOS Settings' Name: one field, and a ✓ that saves it
// (navi_rename, or project_settings_set's title). Its folder keeps its name; the hub's project.settings event brings
// the new one to the chats list and the chat.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect, useState } from "react";
import { ScrollView } from "react-native";
import { isNavi, NAME_MAX, nameProblem, type HubError } from "../../desktop";
import { useHub, type RootParams } from "../../hubContext";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListSection } from "../../ui/List";
import { rename } from "./api";
import { PROJECT_NAME_MAX, projectNameProblem } from "./model";
import { errorWords, FieldRow, Problem, sheetOptions } from "./parts";

export function Rename({ navigation, route }: NativeStackScreenProps<RootParams, "Rename">) {
  const t = useTheme();
  const { state, session } = useHub();
  const p = state.projects?.[route.params.key];
  const [name, setName] = useState(p?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const navi = p !== undefined && isNavi(p);
  const problem = navi ? nameProblem(name) : projectNameProblem(name);
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
      <ListSection footer={navi ? "Its chat, memory and folder stay as they are; only what you call it changes." : "How fleetd shows the project. Its folder keeps its own name."}>
        <FieldRow
          value={name}
          onChangeText={setName}
          autoFocus
          selectTextOnFocus
          maxLength={(navi ? NAME_MAX : PROJECT_NAME_MAX) + 1}
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
