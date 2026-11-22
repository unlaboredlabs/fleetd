// Who merges, pushed from a bot's screen, as the desktop's Settings › Bot › Who merges: You (people merge its PRs on
// GitHub, a new bot's default) or fleetd's merge train, one checked; while You, its risk rules below, one a line, with
// Save in the bar once they changed. Reads the bot's summary (`merges`) and project_settings_get (`mergeRules`);
// writes project_settings_set.
import { useLayoutEffect, useState } from "react";
import { RefreshControl, ScrollView } from "react-native";
import { linesOf, mergesOf, RULES_WORDS, rulesText, WHO_MERGES, WHO_MERGES_WORDS, type HubError, type Merger } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListSection } from "../../ui/List";
import { readRules, setRules, setWhoMerges } from "./api";
import { CheckRow, errorWords, FieldRow, Problem, sheetOptions, useRead } from "./parts";

export function WhoMerges({ navigation, route }: ChatInfoProps<"WhoMerges">) {
  const t = useTheme();
  const { state, session } = useHub();
  const key = route.params.key;
  const ref = refOf(key);
  const saved = mergesOf(state.projects?.[key]);
  const read = useRead(() => readRules(session, ref), [session, key]);
  const rules = read.value?.ok === true ? read.value.value : undefined;
  const [picked, setPicked] = useState<Merger | null>(null);
  const [itself, setItself] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const live = state.hub.phase === "live";
  const shown = picked ?? saved;
  const itselfText = itself ?? (rules === undefined ? "" : rulesText(rules.itself));
  const personText = person ?? (rules === undefined ? "" : rulesText(rules.person));
  const dirty = rules !== undefined && (itselfText !== rulesText(rules.itself) || personText !== rulesText(rules.person));

  const pick = async (to: Merger) => {
    if (busy || to === shown) return;
    haptics.select();
    setPicked(to);
    setError(null);
    const r = await setWhoMerges(session, ref, to);
    setPicked(null);
    if (!r.ok) {
      haptics.warning();
      setError(r.error);
    }
  };

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    const r = await setRules(session, ref, { itself: linesOf(itselfText), person: linesOf(personText) });
    setBusy(false);
    if (!r.ok) {
      haptics.warning();
      return setError(r.error);
    }
    haptics.success();
    setItself(null);
    setPerson(null);
    read.reload();
  };

  useLayoutEffect(() => {
    navigation.setOptions(sheetOptions(t, undefined, shown === "people" && dirty ? { label: "Save", enabled: live, busy, onPress: () => void save() } : undefined));
    // `save` reads what these are.
  }, [navigation, t, shown, dirty, live, busy, itselfText, personText]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      style={{ backgroundColor: t.grouped }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      <ListSection footer={WHO_MERGES_WORDS[shown]}>
        {WHO_MERGES.map((m) => (
          <CheckRow key={m.value} title={m.label} checked={shown === m.value} disabled={!live || busy} onPress={() => void pick(m.value)} />
        ))}
      </ListSection>
      {shown === "people" && rules !== undefined ? (
        <>
          <ListSection header="Merges itself when every file matches">
            <FieldRow value={itselfText} onChangeText={setItself} multiline autoCapitalize="none" clearButtonMode="never" editable={live && !busy} accessibilityLabel="Merges itself" />
          </ListSection>
          <ListSection header="Always a person when any file matches" footer={RULES_WORDS}>
            <FieldRow value={personText} onChangeText={setPerson} multiline autoCapitalize="none" clearButtonMode="never" editable={live && !busy} accessibilityLabel="Always a person" />
          </ListSection>
        </>
      ) : null}
      <Problem text={read.value?.ok === false ? errorWords(read.value.error) : error === null ? undefined : `Not changed: ${errorWords(error)}`} />
    </ScrollView>
  );
}
