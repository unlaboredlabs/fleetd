// Who merges, pushed from a bot's screen, as the desktop's Settings › Bot › Who merges: You (people merge its PRs on
// GitHub, a new bot's default) or fleetd's merge train, one checked; while You, its risk rules below, one a line, with
// Save in the bar once they changed. Then How it merges, as the desktop's: Test, then merge or Merge, then verify, and
// while it merges, then verifies, a line when its main requires branches up to date, with Turn off for an admin where
// fleetd may; while other bots share its repo, their one mode and a line saying so. Reads the bot's summary (`merges`,
// `mergeMode`) and project_settings_get (`mergeRules`, `upToDate`, `mergeShared`); writes project_settings_set.
import { useLayoutEffect, useState } from "react";
import { RefreshControl, ScrollView } from "react-native";
import {
  linesOf,
  MERGE_MODE_WORDS,
  MERGE_MODES,
  mergeModeOf,
  mergesOf,
  RULES_WORDS,
  rulesText,
  sharedText,
  upToDateText,
  WHO_MERGES,
  WHO_MERGES_WORDS,
  type HubError,
  type MergeMode,
  type Merger,
} from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { readMergeFacts, readRules, setMergeMode, setRules, setWhoMerges, turnOffUpToDate } from "./api";
import { CheckRow, errorWords, FieldRow, Problem, sheetOptions, useRead } from "./parts";

export function WhoMerges({ navigation, route }: ChatInfoProps<"WhoMerges">) {
  const t = useTheme();
  const { state, session } = useHub();
  const key = route.params.key;
  const ref = refOf(key);
  const saved = mergesOf(state.projects?.[key]);
  const summaryMode = mergeModeOf(state.projects?.[key]);
  const read = useRead(() => readRules(session, ref), [session, key]);
  const facts = useRead(() => readMergeFacts(session, ref), [session, key, summaryMode]);
  const shared = facts.value?.ok === true ? facts.value.value.shared : undefined;
  // Shared: the repo's train's mode, the one its PRs go by.
  const savedMode = shared?.mode ?? summaryMode;
  const rules = read.value?.ok === true ? read.value.value : undefined;
  // A pick shows at once, until the hub's own word on it comes back (as the desktop's).
  const [picked, setPicked] = useState<{ to: Merger; over: Merger } | null>(null);
  const [pickedMode, setPickedMode] = useState<{ to: MergeMode; over: MergeMode } | null>(null);
  const [itself, setItself] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const live = state.hub.phase === "live";
  const shown = picked !== null && picked.over === saved ? picked.to : saved;
  const mode = pickedMode !== null && pickedMode.over === savedMode ? pickedMode.to : savedMode;
  const rule = mode === "verify_after" && facts.value?.ok === true ? facts.value.value.upToDate[0] : undefined;
  const admin = state.admin === true;
  const itselfText = itself ?? (rules === undefined ? "" : rulesText(rules.itself));
  const personText = person ?? (rules === undefined ? "" : rulesText(rules.person));
  const dirty = rules !== undefined && (itselfText !== rulesText(rules.itself) || personText !== rulesText(rules.person));

  const pick = async (to: Merger) => {
    if (busy || to === shown) return;
    haptics.select();
    const mine = { to, over: saved };
    setPicked(mine);
    setError(null);
    const r = await setWhoMerges(session, ref, to);
    if (!r.ok) {
      setPicked((p) => (p === mine ? null : p));
      haptics.warning();
      setError(r.error);
    }
  };

  const pickMode = async (to: MergeMode) => {
    if (busy || to === mode) return;
    haptics.select();
    const mine = { to, over: savedMode };
    setPickedMode(mine);
    setError(null);
    const r = await setMergeMode(session, ref, to);
    if (!r.ok) {
      setPickedMode((p) => (p === mine ? null : p));
      haptics.warning();
      setError(r.error);
    }
  };

  const turnOff = async (repo: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await turnOffUpToDate(session, ref, repo);
    setBusy(false);
    if (!r.ok) {
      haptics.warning();
      return setError(r.error);
    }
    haptics.success();
    facts.reload();
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
      <ListSection
        header="How it merges"
        footer={[shared === undefined ? undefined : sharedText(shared), rule === undefined ? MERGE_MODE_WORDS[mode] : upToDateText(rule, admin)].filter(Boolean).join(" ")}
      >
        {MERGE_MODES.map((m) => (
          <CheckRow key={m.value} title={m.label} checked={mode === m.value} disabled={!live || busy} onPress={() => void pickMode(m.value)} />
        ))}
        {rule !== undefined && rule.canTurnOff && admin ? <ListRow title="Turn off up-to-date branches" chevron={false} {...(live && !busy ? { onPress: () => void turnOff(rule.repo) } : {})} /> : null}
      </ListSection>
      <Problem text={read.value?.ok === false ? errorWords(read.value.error) : error === null ? undefined : `Not changed: ${errorWords(error)}`} />
    </ScrollView>
  );
}
