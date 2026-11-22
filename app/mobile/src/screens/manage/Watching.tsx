// Watching, pushed from a bot's screen, as the desktop's Automations tab's Watching group: its watchers, each a look at
// one thing about its software on a schedule that says one line in the chat only when something is off. A row is what
// it watches, how often, its profile and its last day's cost, with its on switch; Add Watcher and a row open Watcher,
// which picks what to watch (a preset the bot can have, or one sentence), how often and the profile, looks now, and
// deletes it.
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, Switch } from "react-native";
import {
  EVERY_OPTIONS,
  isWatcher,
  kindLabel,
  offered,
  SENTENCE_MAX,
  sentenceProblem,
  watcherInput,
  watchLine,
  type HubError,
} from "../../desktop";
import type { Automation, AutomationWatch, KnownWatchEvery, KnownWatchKind } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { CheckRow, confirmDestructive, errorWords, FieldRow, Problem, sheetOptions, useRead } from "./parts";

const ABOUT = "Each looks at your software on a schedule and says one line in the chat only when something is off.";

/** The phone's zone, which a new watcher's daily look keeps to. */
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function Watching({ navigation, route }: ChatInfoProps<"Watching">) {
  const t = useTheme();
  const { state, session } = useHub();
  const key = route.params.key;
  const ref = refOf(key);
  const live = state.hub.phase === "live";
  const read = useRead(() => Promise.all([session.call("automation_list", { projectRef: ref }), session.call("profiles_list", { projectRef: ref })]), [session, key]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  // Read again on each return: a watcher added, changed or deleted on Watcher shows once you are back.
  const first = useRef(true);
  const { reload } = read;
  useFocusEffect(
    useCallback(() => {
      if (first.current) first.current = false;
      else reload();
    }, [reload]),
  );
  const [list, profiles] = read.value ?? [];
  const watchers = list?.ok === true ? list.output.automations.filter(isWatcher) : undefined;
  const defaultProfile = profiles?.ok === true ? profiles.output.profiles.find((p) => p.default)?.name : undefined;
  const kinds = list?.ok === true ? offered(list.output.watchable, watchers ?? []) : [];

  const toggle = async (a: Automation, on: boolean) => {
    if (busy !== null) return;
    haptics.select();
    setBusy(a.automationId);
    setError(null);
    const r = await session.call("automation_pause", { automationId: a.automationId, paused: !on });
    setBusy(null);
    if (!r.ok) setError(r.error);
    read.reload();
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      style={{ backgroundColor: t.grouped }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      <ListSection footer={ABOUT}>
        {watchers === undefined ? (
          <ListRow title={list?.ok === false ? "Couldn't read its watchers" : "Reading…"} />
        ) : (
          [
            ...watchers.map((a) => (
              <ListRow
                key={a.automationId}
                title={a.name}
                detail={watchLine(a, defaultProfile)}
                accessory={
                  <Switch
                    value={!a.paused}
                    disabled={!live || busy !== null}
                    onValueChange={(on) => void toggle(a, on)}
                    accessibilityLabel={`Watch ${a.name}`}
                  />
                }
                {...(live ? { onPress: () => navigation.navigate("Watcher", { key, automationId: a.automationId }) } : {})}
              />
            )),
            ...(kinds.length === 0
              ? []
              : [<ListRow key="add" icon="plus" title="Add Watcher" chevron={false} {...(live ? { onPress: () => navigation.navigate("Watcher", { key }) } : {})} />]),
          ]
        )}
      </ListSection>
      <Problem text={list?.ok === false ? errorWords(list.error) : error === null ? undefined : `Not changed: ${errorWords(error)}`} />
    </ScrollView>
  );
}

/** A new watcher, or one to change: what it watches (new only), how often, the profile; then Look Now and Delete. */
export function Watcher({ navigation, route }: ChatInfoProps<"Watcher">) {
  const t = useTheme();
  const { session } = useHub();
  const key = route.params.key;
  const ref = refOf(key);
  const id = route.params.automationId;
  const read = useRead(() => Promise.all([session.call("automation_list", { projectRef: ref }), session.call("profiles_list", { projectRef: ref })]), [session, key]);
  const [list, profiles] = read.value ?? [];
  const all = list?.ok === true ? list.output.automations.filter(isWatcher) : [];
  const w = id === undefined ? undefined : all.find((a) => a.automationId === id);
  const kinds = id === undefined && list?.ok === true ? offered(list.output.watchable, all) : [];
  const allowed = profiles?.ok === true ? (profiles.output.allowed ?? []) : [];
  const defaultProfile = profiles?.ok === true ? profiles.output.profiles.find((p) => p.default)?.name : undefined;

  const [kindPick, setKind] = useState<KnownWatchKind | undefined>(undefined);
  const [everyPick, setEvery] = useState<KnownWatchEvery | undefined>(undefined);
  const [profilePick, setProfile] = useState<string | null | undefined>(undefined);
  const [sentence, setSentence] = useState("");
  const [busy, setBusy] = useState<"save" | "look" | "delete" | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const [said, setSaid] = useState<string | undefined>(undefined);

  const kind = (w?.watch?.kind as KnownWatchKind | undefined) ?? kindPick ?? kinds[0];
  const every = everyPick ?? (w?.watch?.every as KnownWatchEvery | undefined) ?? (kind === "other" ? "hour" : "15m");
  const profile = profilePick === undefined ? w?.watch?.profile : (profilePick ?? undefined);
  const problem = w === undefined && kind !== undefined ? sentenceProblem(kind, sentence) : undefined;
  const changed = w === undefined || every !== w.watch?.every || profile !== w.watch?.profile;
  const ready = kind !== undefined && problem === undefined && changed;

  const save = async () => {
    if (!ready || busy !== null || kind === undefined) return;
    setBusy("save");
    setError(null);
    const watch: AutomationWatch = { kind, every, ...(profile === undefined ? {} : { profile }) };
    const r =
      w === undefined
        ? await session.call("automation_create", watcherInput(watch, sentence, ref, zone(), `phone-watch-${String(Date.now())}`))
        : await session.call("automation_update", { automationId: w.automationId, watch });
    setBusy(null);
    if (!r.ok) {
      haptics.warning();
      return setError(r.error);
    }
    haptics.success();
    navigation.goBack();
  };

  const look = async () => {
    if (w === undefined || busy !== null) return;
    setBusy("look");
    setError(null);
    const r = await session.call("automation_run", { automationId: w.automationId });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setSaid(r.output.run.state === "running" ? "Looking. It speaks in the chat only if something is off." : `Not now: ${r.output.run.why ?? "skipped"}.`);
  };

  const remove = () => {
    if (w === undefined) return;
    confirmDestructive({
      title: `Stop watching ${w.name}?`,
      message: "It stops looking, and its run history goes. What it said in the chat stays.",
      button: "Delete Watcher",
      onConfirm: () =>
        void (async () => {
          setBusy("delete");
          const r = await session.call("automation_delete", { automationId: w.automationId });
          setBusy(null);
          if (!r.ok) return setError(r.error);
          navigation.goBack();
        })(),
    });
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      title: w?.name ?? "New Watcher",
      ...sheetOptions(t, undefined, { label: w === undefined ? "Watch" : "Save", enabled: ready, busy: busy === "save", onPress: () => void save() }),
    });
    // `save` reads what these are.
  }, [navigation, t, ready, busy, kind, every, profile, sentence, w?.name]);

  if (list === undefined) return <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" />;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.xxl }} style={{ backgroundColor: t.grouped }}>
      {w === undefined ? (
        <ListSection header="Watch">
          {kinds.map((k) => (
            <CheckRow key={k} title={kindLabel(k)} checked={kind === k} disabled={busy !== null} onPress={() => setKind(k)} />
          ))}
        </ListSection>
      ) : null}
      {w === undefined && kind === "other" ? (
        <ListSection footer="One plain sentence. It looks with the bot's connections' read tools and the web.">
          <FieldRow
            value={sentence}
            onChangeText={setSentence}
            placeholder="Watch the checkout errors in Sentry"
            maxLength={SENTENCE_MAX}
            autoFocus
            returnKeyType="done"
            editable={busy === null}
            accessibilityLabel="What to watch"
          />
        </ListSection>
      ) : null}
      <ListSection header="How Often">
        {EVERY_OPTIONS.map((o) => (
          <CheckRow key={o.value} title={o.label} checked={every === o.value} disabled={busy !== null} onPress={() => setEvery(o.value)} />
        ))}
      </ListSection>
      <ListSection header="Profile">
        <CheckRow title={defaultProfile === undefined ? "Default" : `${defaultProfile} (default)`} checked={profile === undefined} disabled={busy !== null} onPress={() => setProfile(null)} />
        {allowed
          .filter((p) => p !== defaultProfile)
          .map((p) => (
            <CheckRow key={p} title={p} checked={profile === p} disabled={busy !== null} onPress={() => setProfile(p)} />
          ))}
      </ListSection>
      {w === undefined ? null : (
        <ListSection {...(said === undefined ? {} : { footer: said })}>
          <ListRow title="Look Now" chevron={false} {...(busy === null ? { onPress: () => void look() } : {})} />
          <ListRow title="Delete Watcher" destructive chevron={false} {...(busy === null ? { onPress: remove } : {})} />
        </ListSection>
      )}
      <Problem text={problem !== undefined && sentence !== "" ? problem : error === null ? undefined : `Not saved: ${errorWords(error)}`} />
    </ScrollView>
  );
}
