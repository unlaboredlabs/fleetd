// The person's editor for one of a Navi's own skills, a sheet over its view: its whole SKILL.md as plain text, the
// frontmatter too, in a field that fills the sheet and stays above the keyboard, and an optional line on what changed
// that its history keeps. ✓ saves it as a new version (skill_set); ✕ with changes asks before it drops them, and the
// sheet doesn't swipe away while there are any.
import { usePreventRemove } from "@react-navigation/native";
import { useEffect, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HubError } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { mono, shape, space, type, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { confirmDestructive, errorWords, Problem, sheetOptions } from "./parts";
import { readSkill, saveSkill } from "./skillsApi";

export function SkillEdit({ navigation, route }: ChatInfoProps<"SkillEdit">) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { state, session } = useHub();
  const { key, name } = route.params;
  const p = state.projects?.[key];
  const [base, setBase] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const [done, setDone] = useState(false);
  const dirty = base !== null && text !== base;
  const ready = dirty && text.trim() !== "" && !busy;

  useEffect(() => {
    if (p === undefined) return;
    let gone = false;
    void readSkill(session, p, "project", name).then((r) => {
      if (gone) return;
      if (!r.ok) return setError(r.error);
      setBase(r.value.text);
      setText(r.value.text);
    });
    return () => {
      gone = true;
    };
    // Read once: what the person types is theirs until they save or cancel.
  }, [session, name]);

  const save = async () => {
    if (p === undefined || !ready) return;
    setBusy(true);
    setError(null);
    const r = await saveSkill(session, p, name, text, why);
    setBusy(false);
    if (!r.ok) {
      haptics.warning();
      return setError(r.error);
    }
    haptics.success();
    setDone(true);
  };

  // Saved: closes once the render that lets it go has run.
  useEffect(() => {
    if (done) navigation.goBack();
  }, [done, navigation]);

  // ✕, a swipe down or Android's back with changes: ask first.
  usePreventRemove(dirty && !done, ({ data }) =>
    confirmDestructive({ title: "Discard your changes?", message: `${name} stays as it was.`, button: "Discard Changes", onConfirm: () => navigation.dispatch(data.action) }),
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      ...sheetOptions(t, () => navigation.goBack(), { label: "Save", enabled: ready, busy, onPress: () => void save() }, !busy),
      gestureEnabled: !dirty,
    });
    // `save` reads what these are.
  }, [navigation, t, ready, busy, dirty, text, why]);

  if (p === undefined) return null;
  if (base === null) {
    return error === null ? (
      <ActivityIndicator style={styles.loading} color={t.secondary} />
    ) : (
      <View style={{ paddingTop: space.lg }}>
        <Problem text={`Couldn't read it: ${errorWords(error)}`} />
      </View>
    );
  }
  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.fill, { backgroundColor: t.grouped }]} keyboardVerticalOffset={0}>
      <View style={[styles.fill, styles.body, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
        <View style={[styles.group, { backgroundColor: t.cell }]}>
          <TextInput
            value={why}
            onChangeText={setWhy}
            placeholder="What you changed (optional)"
            placeholderTextColor={t.tertiary}
            maxLength={300}
            returnKeyType="next"
            editable={!busy}
            selectionColor={t.accent}
            style={[type.body, styles.why, { color: t.label }]}
            accessibilityLabel="What you changed"
          />
        </View>
        <View style={[styles.group, styles.fill, { backgroundColor: t.cell }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            scrollEnabled
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            smartInsertDelete={false}
            editable={!busy}
            textAlignVertical="top"
            selectionColor={t.accent}
            style={[styles.fill, styles.text, { color: t.label }]}
            accessibilityLabel="SKILL.md"
          />
        </View>
        <Problem text={error === null ? undefined : `Not saved: ${errorWords(error)}`} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  loading: { marginTop: 64 },
  body: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.md },
  group: { borderRadius: shape.group, borderCurve: "continuous", overflow: "hidden" },
  why: { minHeight: shape.row, paddingHorizontal: space.lg, paddingVertical: 11 },
  text: { fontFamily: mono, fontSize: 14, lineHeight: 20, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md },
});
