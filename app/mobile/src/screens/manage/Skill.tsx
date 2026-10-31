// A skill's view, pushed from a Navi's Skills: its name, what it does and where it is from over its SKILL.md, read as
// formatted text; then its History, whether the Navi uses it, and Delete, asking first. Edit in the bar opens the
// editor (SkillEdit.tsx). What the person may do follows what it is (skillsModel offers): a hub-wide or installed
// skill is only turned off here, and one in the Navi's folder is only read.
import { StackActions } from "@react-navigation/native";
import { useEffect, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { isYours } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { shape, space, type, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { Markdown } from "../../ui/Markdown";
import { EmptyState } from "../../ui/States";
import { useNow } from "../time";
import { confirmDestructive, errorWords, Problem, useRead } from "./parts";
import { SkillTile, useSkillsChanged } from "./Skills";
import { deleteSkill, readSkillView, turnSkillOff } from "./skillsApi";
import { isOff, kindOf, offers, rowLine, sourceLine, splitSkill } from "./skillsModel";

export function Skill({ navigation, route }: ChatInfoProps<"Skill">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const { key, origin, name } = route.params;
  const p = state.projects?.[key];
  const read = useRead(() => (p === undefined ? Promise.resolve(undefined) : readSkillView(session, p, origin, name)), [session, p?.machineId, p?.projectId, origin, name]);
  useSkillsChanged(session, p, read.reload);
  const [busy, setBusy] = useState<"off" | "delete" | null>(null);
  // The switch moves at once; the read after the hub's answer settles it.
  const [offNow, setOffNow] = useState<boolean | null>(null);
  const r = read.value;
  // A fresh read says where the switch stands.
  useEffect(() => setOffNow(null), [r]);
  const v = r?.ok === true ? r.value : undefined;
  const can = v === undefined || p === undefined ? undefined : offers(v.skill, isYours(p, state.me));
  const live = state.hub.phase === "live";

  useLayoutEffect(() => {
    const edit = can?.edit === true && live && busy === null;
    const open = () => {
      haptics.tap();
      navigation.navigate("SkillEdit", { key, name });
    };
    navigation.setOptions({
      ...(Platform.OS === "ios"
        ? { unstable_headerRightItems: () => (can?.edit === true ? [{ type: "button", label: "Edit", disabled: !edit, onPress: () => void setTimeout(open, 0) }] : []) }
        : {
            headerRight: () =>
              can?.edit === true ? (
                <Pressable accessibilityRole="button" onPress={open} disabled={!edit} hitSlop={12}>
                  <Text style={[type.body, { color: edit ? t.accent : t.tertiary }]}>Edit</Text>
                </Pressable>
              ) : null,
          }),
    });
  }, [navigation, t, can?.edit, live, busy, key, name]);

  if (p === undefined) return <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />;
  if (r === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  if (!r.ok) {
    if (r.error.code === "not_found") return <EmptyState icon="sparkles" title="Not Here" body={`${p.title} doesn't have this skill any more.`} />;
    return (
      <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic">
        <Problem text={`Couldn't read it: ${errorWords(r.error)}`} />
      </ScrollView>
    );
  }
  const { skill: s, text, versions } = r.value;
  const { body } = splitSkill(text);
  const off = offNow ?? isOff(s);
  const last = rowLine(s, now, state.meName);

  const setOff = (value: boolean) => {
    haptics.tap();
    setOffNow(value);
    setBusy("off");
    void turnSkillOff(session, p, s.name, value).then((res) => {
      setBusy(null);
      if (!res.ok) {
        setOffNow(null);
        return Alert.alert(value ? "Couldn't turn it off" : "Couldn't turn it on", errorWords(res.error));
      }
      read.reload();
    });
  };

  const remove = () =>
    confirmDestructive({
      title: `Delete ${s.name}?`,
      message: `${p.title} stops using it, and its history goes with it. This can't be undone.`,
      button: "Delete Skill",
      onConfirm: () => {
        setBusy("delete");
        void deleteSkill(session, p, s.name).then((res) => {
          setBusy(null);
          if (!res.ok) return Alert.alert(`Couldn't delete ${s.name}`, errorWords(res.error));
          haptics.success();
          navigation.dispatch(StackActions.pop());
        });
      },
    });

  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      <View style={[styles.hero, off && styles.dim]}>
        <SkillTile kind={kindOf(s)} size={56} />
        <Text style={[type.title2, styles.center, { color: t.label }]} selectable>
          {s.name}
        </Text>
        {s.description === "" ? null : <Text style={[type.subhead, styles.center, { color: t.secondary }]}>{s.description}</Text>}
        <Text style={[type.footnote, styles.center, { color: t.tertiary }]}>{sourceLine(s, p.title, versions.length)}</Text>
      </View>

      <View style={[styles.page, { backgroundColor: t.cell }]}>
        {body.trim() === "" ? <Text style={[type.body, { color: t.tertiary }]}>No steps written yet.</Text> : <Markdown text={body} ink={t.label} holdsBlocks={false} />}
      </View>

      {s.shadowedBy === undefined ? null : <Problem text={`${p.title} uses another skill called ${s.name} instead, from its folder.`} />}

      {can?.history === true && versions.length > 0 ? (
        <ListSection>
          <ListRow
            title="History"
            {...(last === undefined ? {} : { detail: last })}
            value={versions.length === 1 ? "1 version" : `${String(versions.length)} versions`}
            onPress={() => navigation.navigate("SkillHistory", { key, origin, name })}
          />
        </ListSection>
      ) : null}

      {can?.turnOff === true ? (
        <ListSection footer={off ? `Off: ${p.title}'s sessions don't get it, from their next start. It stays here with its history.` : `${p.title} uses it when a task calls for it.`}>
          <ListRow
            title="Use This Skill"
            accessory={<Switch value={!off} disabled={!live || busy !== null} onValueChange={(on) => setOff(!on)} accessibilityLabel="Use this skill" />}
          />
        </ListSection>
      ) : null}

      {can?.delete === true ? (
        <ListSection>
          <ListRow title="Delete Skill" destructive chevron={false} {...(busy === null && live ? { onPress: remove } : {})} {...(busy === "delete" ? { accessory: <ActivityIndicator color={t.secondary} /> } : {})} />
        </ListSection>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  hero: { alignItems: "center", gap: 6, paddingTop: space.lg, paddingHorizontal: space.xl },
  center: { textAlign: "center" },
  dim: { opacity: 0.5 },
  page: { marginHorizontal: space.lg, marginTop: space.xl, padding: space.lg, borderRadius: shape.group, borderCurve: "continuous" },
});
