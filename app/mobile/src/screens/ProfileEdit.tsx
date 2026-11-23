// Settings › Providers › a profile, in a sheet with ✕ and ✓, as the desktop's editor under each provider: its name, the
// line the lead picks it by, its model (its provider's alone), reasoning and fast mode (profile_create, profile_update),
// and Delete Profile but on the default, which Every Bot's Default profile replaces on the desktop.
import { useLayoutEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Switch } from "react-native";
import {
  AGENT_PROVIDERS,
  createInput,
  profileDeleteWords,
  draftOf,
  EFFORT_WORD,
  hasFast,
  modelShort,
  newDraft,
  NOTE_MAX,
  profileProblem,
  providerModels,
  updateInput,
  type ProfileDraft,
  type ProfilesListOutput,
} from "../desktop";
import { useHub, type SettingsProps } from "../hubContext";
import { space, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { CheckRow, confirmDestructive, errorWords, FieldRow, Problem, sheetOptions, useRead } from "./manage/parts";

export function ProfileEdit({ navigation, route }: SettingsProps<"ProfileEdit">) {
  const t = useTheme();
  const { session } = useHub();
  const { provider: providerId, id } = route.params;
  const provider = AGENT_PROVIDERS.find((p) => p.id === providerId) ?? AGENT_PROVIDERS[0];
  const read = useRead(() => session.call("profiles_list", {}), [session]);
  const view: ProfilesListOutput | undefined = read.value?.ok === true ? read.value.output : undefined;
  const saved = view?.profiles.find((p) => p.id === id);
  const models = view === undefined ? [] : providerModels(view.models, providerId, saved?.model);
  // The draft starts once the list is read: the profile as saved, or a new one on the provider's first model.
  const [changed, setDraft] = useState<ProfileDraft | undefined>(undefined);
  const draft = changed ?? (saved !== undefined ? draftOf(saved) : view !== undefined && id === undefined ? newDraft(models) : undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const set = (change: Partial<ProfileDraft>) => {
    if (draft !== undefined) setDraft({ ...draft, ...change });
  };
  const taken = view?.profiles.filter((p) => p.id !== id).map((p) => p.name) ?? [];
  const wrong = draft === undefined ? undefined : profileProblem(draft, taken);
  const update = saved !== undefined && draft !== undefined && view !== undefined ? updateInput(view.models, saved, draft) : undefined;
  const ready = draft !== undefined && wrong === undefined && (id === undefined || update !== undefined);

  const run = async (go: () => Promise<{ ok: true } | { ok: false; error: { message: string; fix?: string | undefined } }>, failed: string) => {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    const r = await go();
    setBusy(false);
    if (!r.ok) {
      haptics.warning();
      return setProblem(`${failed}: ${errorWords(r.error)}`);
    }
    haptics.success();
    navigation.goBack();
  };
  const save = () => {
    if (view === undefined || draft === undefined || !ready) return;
    void run(() => (update === undefined ? session.call("profile_create", createInput(view.models, draft)) : session.call("profile_update", update)), "Not saved");
  };
  const remove = () => {
    if (saved === undefined) return;
    confirmDestructive({
      title: `Delete ${saved.name}?`,
      message: profileDeleteWords(saved, view?.profiles.find((p) => p.default)?.name).replace(/^Delete [^?]+\? /u, ""),
      button: "Delete",
      onConfirm: () => void run(() => session.call("profile_delete", { id: saved.id }), "Not deleted"),
    });
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      title: saved !== undefined ? `Edit ${saved.name}` : `New ${provider?.name ?? ""} Profile`,
      ...sheetOptions(t, () => navigation.goBack(), { label: id === undefined ? "Create" : "Save", enabled: ready, busy, onPress: save }, !busy),
    });
    // `save` reads the draft.
  }, [navigation, t, busy, draft, saved, ready]);

  if (view === undefined || draft === undefined) {
    return read.value?.ok === false || (view !== undefined && saved === undefined) ? (
      <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic">
        <Problem text={read.value?.ok === false ? errorWords(read.value.error) : "This profile is gone."} />
      </ScrollView>
    ) : (
      <ActivityIndicator style={styles.loading} color={t.secondary} />
    );
  }
  const fast = hasFast(view.models, draft.model);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      style={{ backgroundColor: t.grouped }}
    >
      <ListSection footer={draft.name !== "" && wrong?.field === "name" ? wrong.text : "The word the lead names it by: lowercase, no spaces."}>
        <FieldRow
          value={draft.name}
          onChangeText={(name) => set({ name })}
          placeholder="Name"
          accessibilityLabel="Name"
          autoCapitalize="none"
          editable={!busy}
          invalid={draft.name !== "" && wrong?.field === "name"}
          autoFocus={id === undefined}
        />
      </ListSection>
      <ListSection footer={wrong?.field === "note" ? wrong.text : "One line: the work the lead should run on it."}>
        <FieldRow value={draft.note} onChangeText={(note) => set({ note })} placeholder="Use For" accessibilityLabel="Use for" maxLength={NOTE_MAX} editable={!busy} invalid={wrong?.field === "note"} />
      </ListSection>
      <ListSection header="Model">
        {models.map((m) => (
          <CheckRow key={m.id} title={modelShort(m)} checked={draft.model === m.id} disabled={busy} onPress={() => (haptics.select(), set({ model: m.id }))} />
        ))}
      </ListSection>
      <ListSection header="Reasoning">
        {view.efforts.map((e) => (
          <CheckRow key={e} title={EFFORT_WORD[e]} checked={draft.effort === e} disabled={busy} onPress={() => (haptics.select(), set({ effort: e }))} />
        ))}
      </ListSection>
      <ListSection footer={fast ? "Faster answers at a higher price per token." : "This model has no fast mode."}>
        <ListRow
          title="Fast Mode"
          accessory={<Switch value={draft.fast && fast} disabled={!fast || busy} onValueChange={(on) => set({ fast: on })} accessibilityLabel="Fast mode" />}
        />
      </ListSection>
      {saved === undefined || saved.default ? null : (
        <ListSection>
          <ListRow title="Delete Profile" destructive chevron={false} {...(busy ? {} : { onPress: remove })} />
        </ListSection>
      )}
      <Problem text={problem} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
});
