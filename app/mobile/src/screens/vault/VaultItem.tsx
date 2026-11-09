// One vault item, as iOS's Passwords opens one: its tile, label and line on top; then its fields, each hidden until
// the person asks. Tapping a hidden field asks for Face ID (or the passcode), then shows every field of the item for 30
// seconds; tapping a shown one copies it to a clipboard that stays on this phone and empties itself after a minute.
// Leaving the screen, or the app going to the background, hides them at once: a value lives in this screen's state
// only while it's on screen, and is never logged. A plain variable shows as it is, its value in the list's metadata. Then the sites it fills on, where
// it's used, its last 20 uses (vault_get's activity), and Delete.
import { useFocusEffect } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { listTime } from "../../chatView";
import { useHub } from "../../hubContext";
import { mono, space, type, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListRow, ListSection } from "../../ui/List";
import { useNow } from "../time";
import { confirmDestructive, errorWords, Problem, Symbol, useRead } from "../manage/parts";
import { deleteItem, readItem, reveal, vaultErrorWords, vaultHub } from "./api";
import { auditLine, CLIPBOARD_MS, copyText, isSecretEnv, presentFields, REVEAL_MS, rowLine, SCOPE_WORDS, sealedFields, shownFields, sitesMeta, titleOf, type FieldSpec } from "./model";
import { KindTile, useVaultChanged, useVaultNav, useVaultRoute } from "./parts";
import { unlock } from "./unlock";

const DOTS = "••••••••";

export function VaultItem() {
  const t = useTheme();
  const now = useNow();
  const navigation = useVaultNav();
  const { itemId, item: passed, key } = useVaultRoute<"VaultItem">().params;
  const { state, session } = useHub();
  const hub = useMemo(() => vaultHub(session), [session]);
  const read = useRead(() => readItem(hub, itemId), [hub, itemId]);
  useVaultChanged(session, read.reload);
  const got = read.value?.ok === true ? read.value.value : undefined;
  const item = got?.item ?? passed;
  const live = state.hub.phase === "live";

  // The values on screen, and when they go. Nothing else holds them.
  const [shown, setShown] = useState<Record<string, string> | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setShown(null);
  }, []);
  useFocusEffect(useCallback(() => hide, [hide]));
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") hide();
    });
    return () => {
      sub.remove();
      clearTimeout(timer.current);
    };
  }, [hide]);

  const plain = item !== undefined && item.kind === "env" && !isSecretEnv(item);
  const fields = item === undefined ? [] : presentFields(item);

  /** Opens the item's fields, after Face ID. */
  const open = async (why: string): Promise<Record<string, string> | null> => {
    if (item === undefined || busy) return null;
    const ok = await unlock(why);
    if (!ok.ok) {
      if (ok.why !== undefined) setProblem(ok.why);
      return null;
    }
    setBusy(true);
    setProblem(undefined);
    const r = await reveal(hub, item.itemId, sealedFields(item.kind));
    setBusy(false);
    if (!r.ok) {
      setProblem(`Couldn't show it: ${vaultErrorWords(r.error) ?? errorWords(r.error)}`);
      return null;
    }
    const values = shownFields(item.kind, r.value);
    clearTimeout(timer.current);
    setShown(values);
    timer.current = setTimeout(hide, REVEAL_MS);
    return values;
  };

  // A plain variable's value comes with the list: there's nothing to guard.
  const values = plain && item?.value !== undefined ? { value: item.value } : shown;

  const copy = async (f: FieldSpec) => {
    // A shown value was unlocked a moment ago; a hidden one asks first.
    const value = (values ?? (await open(`Copy ${f.label.toLowerCase()}`)))?.[f.key];
    if (value === undefined || value === "") return;
    await Clipboard.setStringAsync(copyText(f.key, value), { ios: { localOnly: true, expiresAt: new Date(Date.now() + CLIPBOARD_MS) }, android: { isSensitive: true } });
    haptics.success();
    setCopied(f.key);
    setTimeout(() => setCopied((c) => (c === f.key ? null : c)), 1500);
  };

  const onField = (f: FieldSpec) => {
    if (item?.canReveal !== true) return;
    haptics.tap();
    if (values === null) void open(`Show ${titleOf(item)}`);
    else void copy(f);
  };

  const remove = () => {
    if (item === undefined) return;
    confirmDestructive({
      title: `Delete ${titleOf(item)}?`,
      message: item.kind === "env" ? "Agents stop getting it from their next start. It stays in the trash for 30 days." : "Agents can't use it any more. It stays in the trash for 30 days.",
      button: "Delete",
      onConfirm: () =>
        void deleteItem(hub, item.itemId).then((r) => {
          if (!r.ok) return setProblem(`Couldn't delete it: ${vaultErrorWords(r.error) ?? errorWords(r.error)}`);
          haptics.success();
          navigation.goBack();
        }),
    });
  };

  const edit = () => {
    if (item === undefined) return;
    hide();
    navigation.navigate("VaultEdit", { kind: item.kind, item, ...(key === undefined ? {} : { key }) });
  };
  const canEdit = item?.canEdit === true && live;
  useLayoutEffect(() => {
    navigation.setOptions({
      title: "",
      ...(Platform.OS === "ios"
        ? { unstable_headerRightItems: () => (canEdit ? [{ type: "button", label: "Edit", onPress: () => setTimeout(edit, 0) }] : []) }
        : {
            headerRight: () =>
              canEdit ? (
                <Pressable accessibilityRole="button" hitSlop={12} onPress={edit}>
                  <Text style={[type.body, { color: t.accent }]}>Edit</Text>
                </Pressable>
              ) : null,
          }),
    });
    // `edit` reads the item.
  }, [navigation, t.accent, canEdit, item]);

  if (item === undefined) {
    return (
      <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic">
        {read.value === undefined ? <ActivityIndicator style={styles.loading} color={t.secondary} /> : <Problem text={read.value.ok ? undefined : errorWords(read.value.error)} />}
      </ScrollView>
    );
  }

  const sites = sitesMeta(item);
  const projectName = (machineId: string, projectId: string) => state.projects?.[`${machineId}/${projectId}`]?.title;
  const usedIn =
    item.scope === "person"
      ? [SCOPE_WORDS.person, ...(item.sharedWith ?? []).map((p) => projectName(p.machineId, p.projectId) ?? "A project")]
      : item.scope === "hub"
        ? [SCOPE_WORDS.hub]
        : [item.machineId === undefined || item.projectId === undefined ? SCOPE_WORDS.project : (projectName(item.machineId, item.projectId) ?? SCOPE_WORDS.project)];
  const footer = !item.canReveal
    ? "Only whoever added it, or an admin, can see its values."
    : plain
      ? "A plain variable: not a secret, so it shows as it is."
      : values === null
        ? "Tap a field to see it, after Face ID. Tap it again to copy it."
        : "Shown for 30 seconds. A copied value stays on this phone and clears after a minute.";

  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
      <View style={styles.head}>
        <KindTile kind={item.kind} size={64} />
        <Text style={[type.title2, styles.center, { color: t.label }]} numberOfLines={2} selectable={item.kind === "env"}>
          {titleOf(item)}
        </Text>
        <Text style={[type.subhead, styles.center, { color: t.secondary }]}>{`${rowLine(item)} · Changed ${listTime(new Date(item.updatedMs).toISOString(), now)}`}</Text>
      </View>

      <ListSection footer={footer}>
        {fields.map((f) => (
          <FieldRow
            key={f.key}
            field={f}
            value={values?.[f.key]}
            shown={values !== null}
            copied={copied === f.key}
            busy={busy}
            {...(item.canReveal && live ? { onPress: () => onField(f) } : {})}
          />
        ))}
      </ListSection>
      <Problem text={problem} />

      {sites.length === 0 ? null : (
        <ListSection header={item.kind === "login" ? "Websites" : "Fills on"} {...(item.kind === "login" ? { footer: "Agents fill it in only on these sites and their subdomains." } : {})}>
          {sites.map((s) => (
            <ListRow key={s} title={s} onPress={() => void Linking.openURL(`https://${s}`)} accessory={<Icon name="external" size={14} color={t.tertiary} />} chevron={false} />
          ))}
        </ListSection>
      )}

      <ListSection header="Used by">
        {usedIn.map((u, i) => (
          <ListRow key={`${String(i)}${u}`} title={u} />
        ))}
      </ListSection>

      {got === undefined ? null : (
        <ListSection header="Activity" {...(got.activity.length === 0 ? {} : { footer: "Every use is logged, never a value." })}>
          {got.activity.length === 0 ? (
            <ListRow title="Not used yet" />
          ) : (
            got.activity.map((e) => {
              const line = auditLine(e, projectName);
              return <ListRow key={String(e.n)} title={line.title} detail={line.detail} value={listTime(new Date(e.atMs).toISOString(), now)} />;
            })
          )}
        </ListSection>
      )}

      {item.canEdit ? (
        <ListSection>
          <ListRow title={item.kind === "env" ? "Delete Variable" : `Delete ${item.kind === "login" ? "Login" : item.kind === "card" ? "Card" : "Address"}`} destructive chevron={false} {...(live ? { onPress: remove } : {})} />
        </ListSection>
      ) : null}
    </ScrollView>
  );
}

/** A field as iOS's Passwords shows one: its name small above, its value (or dots) below, and Copy's mark once shown. */
function FieldRow({ field, value, shown, copied, busy, onPress }: { field: FieldSpec; value: string | undefined; shown: boolean; copied: boolean; busy: boolean; onPress?: () => void }) {
  const t = useTheme();
  const secret = field.masked || field.key === "number";
  const text = copied ? "Copied" : shown ? (value === undefined || value === "" ? "—" : value) : field.masked ? DOTS : "Hidden";
  const quiet = copied || !shown || value === undefined || value === "";
  const face = (pressed: boolean) => (
    <View style={[styles.field, pressed && { backgroundColor: t.fillQuiet }]}>
      <View style={styles.grow}>
        <Text style={[type.footnote, { color: t.secondary }]}>{field.label}</Text>
        <Text
          style={[type.body, shown && secret && !copied ? { fontFamily: mono } : null, { color: copied ? t.success : quiet ? t.tertiary : t.label }]}
          numberOfLines={field.key === "notes" || field.key === "value" ? 6 : 1}
          accessibilityLabel={shown ? undefined : `${field.label}, hidden`}
        >
          {text}
        </Text>
      </View>
      {busy && !shown ? <ActivityIndicator color={t.secondary} /> : shown && value !== undefined && value !== "" ? <Symbol ios="doc.on.doc" android="content_copy" size={17} color={t.tertiary} /> : null}
    </View>
  );
  if (onPress === undefined) return face(false);
  return (
    <Pressable accessibilityRole="button" accessibilityHint={shown ? "Copies it." : "Shows it, after Face ID."} onPress={onPress}>
      {({ pressed }) => face(pressed)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  head: { alignItems: "center", gap: 6, paddingHorizontal: space.xl, paddingTop: space.lg },
  center: { textAlign: "center" },
  field: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 10, minHeight: 60 },
  grow: { flex: 1, gap: 2 },
});
