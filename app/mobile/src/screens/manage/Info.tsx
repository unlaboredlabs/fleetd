// A project's or a Navi's own screen, opened from its chat's header, as a contact's in Telegram: its avatar and name
// (tapping the avatar, or Edit under it, opens its icon's sheet: a built-in face and color, or a photo: IconPicker.tsx),
// then what runs there now (agents_list), its open orders (orders_board), its checklist and its recent merges with
// their PRs, read-only; then its name, the profiles its agents may run on and where it lives, and for a Navi Forget
// Sign-ins. Delete last, red, asking first: in an action sheet, or, when uncommitted changes would be lost, in a sheet
// that names them and wants its name typed (TypedDelete). What the person's role doesn't allow isn't offered.
import { StackActions, useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { listTime } from "../../chatView";
import { isNavi, tilde, type ProjectSummary, type TodoItem } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { space, type, useTheme, type Palette } from "../../theme";
import { Avatar } from "../../ui/Avatar";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListRow, ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { useNow } from "../time";
import { deleteProject, forgetSignins, readForDelete, readInfo } from "./api";
import { agentLines, allowed, checklist, deleteBlocked, deleteWords, machineName, merges, orderLines, profilesValue, subtitle, type DeleteWords, type Tone } from "./model";
import { confirmDestructive, errorWords, Problem, useRead } from "./parts";
import { TypedDelete } from "./TypedDelete";

const toneColor = (t: Palette, tone: Tone): string => (tone === "accent" ? t.accent : tone === "warning" ? t.warning : tone === "danger" ? t.danger : t.secondary);

export function Info({ navigation, route }: ChatInfoProps<"Info">) {
  const t = useTheme();
  const { state } = useHub();
  const key = route.params.key;
  const project = state.projects?.[key];
  if (project === undefined) {
    return (
      <View style={[styles.fill, { backgroundColor: t.grouped }]}>
        {state.projects === undefined ? <ActivityIndicator style={styles.loading} color={t.secondary} /> : <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />}
      </View>
    );
  }
  return <Page project={project} navigation={navigation} />;
}

function Page({ project: p, navigation }: { project: ProjectSummary; navigation: ChatInfoProps<"Info">["navigation"] }) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const navi = isNavi(p);
  const machine = machineName(state.machines, p.machineId);
  const can = allowed(p, state.me);
  const info = useRead(() => readInfo(session, p, Date.now()), [session, p.machineId, p.projectId]);
  // Back from Agent Profiles or Rename: read again (the first focus is the mount's read).
  const { reload } = info;
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) reload();
      shown.current = true;
    }, [reload]),
  );
  const [busy, setBusy] = useState<"delete" | "forget" | null>(null);
  const [forgot, setForgot] = useState(false);
  const [typing, setTyping] = useState<DeleteWords | null>(null);
  const key = `${p.machineId}/${p.projectId}`;
  const v = info.value;
  const agents = agentLines(v?.agents ?? []);
  const orders = orderLines(v?.orders ?? []);
  const list = checklist(v?.checklist ?? []);
  const merged = merges(v?.prs ?? []);
  const live = state.hub.phase === "live";

  const remove = async () => {
    setBusy("delete");
    const read = await readForDelete(session, p);
    setBusy(null);
    if (!read.ok) return Alert.alert(`Couldn't check ${p.title}`, errorWords(read.error));
    const blocked = deleteBlocked(read.value);
    if (blocked !== undefined) return Alert.alert(`Can't delete ${p.title} now`, blocked);
    const words = deleteWords(p, read.value, machine);
    // Uncommitted changes would be lost: their names and the project's typed, as on the desktop. Else the action sheet.
    if (words.unsaved.length > 0) return setTyping(words);
    confirmDestructive({ ...words, onConfirm: doDelete });
  };

  // Back to Chats first, then the delete: its row then goes from a list on screen, never in the same commit as these
  // screens (the list's rows slide with a LayoutAnimation, which must not land on a screen's removal).
  const doDelete = () => {
    setTyping(null);
    navigation.getParent()?.dispatch(StackActions.popToTop());
    void deleteProject(session, p).then((r) => {
      if (!r.ok) return Alert.alert(`Couldn't delete ${p.title}`, errorWords(r.error));
      haptics.success();
    });
  };

  const forget = () =>
    confirmDestructive({
      title: "Forget sign-ins?",
      message: `${p.title} is signed out of every site, and its browser profile is deleted from ${machine}. A browser session it has open now ends. Its chat, memory, folder and allowed sites stay.`,
      button: "Forget Sign-ins",
      onConfirm: () => {
        setBusy("forget");
        void forgetSignins(session, p).then((r) => {
          setBusy(null);
          if (!r.ok) return Alert.alert("Couldn't forget its sign-ins", errorWords(r.error));
          haptics.success();
          setForgot(true);
        });
      },
    });

  const editIcon = () => {
    haptics.tap();
    navigation.navigate("Icon", { key });
  };
  const editable = can.rename && live && busy === null;

  const spinner = <ActivityIndicator color={t.secondary} />;
  const profiles = v?.profiles;
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={t.secondary} />}
    >
      <View style={styles.hero}>
        <Pressable
          disabled={!editable}
          onPress={editIcon}
          accessibilityRole={editable ? "button" : "image"}
          accessibilityLabel={editable ? "Edit icon" : p.title}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Avatar name={p.title} navi={navi} size={96} picture={p} />
        </Pressable>
        {can.rename ? (
          <Pressable disabled={!editable} onPress={editIcon} hitSlop={8} accessible={false} importantForAccessibility="no" style={({ pressed }) => pressed && styles.pressed}>
            <Text style={[type.subhead, { color: editable ? t.accent : t.tertiary }]}>Edit</Text>
          </Pressable>
        ) : null}
        <Text style={[type.title2, styles.center, { color: t.label }]} selectable>
          {p.title}
        </Text>
        <Text style={[type.subhead, styles.center, { color: t.secondary }]}>{subtitle(p, machine)}</Text>
      </View>

      <ListSection header="Running">
        {v === undefined ? (
          <ListRow title="Reading…" accessory={spinner} />
        ) : agents.length === 0 ? (
          <ListRow title="Nothing running" valueColor={t.secondary} />
        ) : (
          agents.map((a) => <ListRow key={a.id} title={a.title} detail={a.role === "" ? undefined : a.role} value={a.status} valueColor={toneColor(t, a.tone)} />)
        )}
      </ListSection>

      {orders.length === 0 ? null : (
        <ListSection header="Orders">
          {orders.map((o) => (
            <ListRow key={o.id} title={o.title} detail={o.progress === undefined ? o.phase : `${o.phase} · ${o.progress}`} />
          ))}
        </ListSection>
      )}

      {list.items.length === 0 ? null : (
        <ListSection header="Checklist" {...(list.summary === undefined ? {} : { footer: list.more > 0 ? `${list.summary} · ${String(list.more)} more in the desktop app` : list.summary })}>
          {list.items.map((item) => (
            <ChecklistRow key={item.id} item={item} />
          ))}
        </ListSection>
      )}

      {merged.length === 0 ? null : (
        <ListSection header="Recent merges">
          {merged.map((pr) => (
            <ListRow
              key={pr.url}
              icon="pr"
              tint={t.tints[3]}
              title={pr.title}
              detail={`#${String(pr.number)} · ${pr.repo}${pr.mergedAt === undefined ? "" : ` · ${listTime(pr.mergedAt, now)}`}`}
              onPress={() => void Linking.openURL(pr.url)}
            />
          ))}
        </ListSection>
      )}

      <Problem text={v?.error === undefined ? undefined : `Not everything was read: ${errorWords(v.error)}`} />

      <ListSection footer={navi ? "Its folder keeps the name it was made with." : "Its folder keeps its own name."}>
        <ListRow title="Name" value={p.title} {...(can.rename && live ? { onPress: () => navigation.navigate("Rename", { key }) } : {})} />
        {can.profiles && profiles !== undefined && profiles.profiles.length > 1 ? (
          <ListRow title="Agent profiles" value={profilesValue(profiles)} {...(live ? { onPress: () => navigation.navigate("Profiles", { key }) } : {})} />
        ) : null}
        <ListRow title={navi ? "Lives on" : "Machine"} value={machine} />
        <ListRow title="Folder" value={tilde(p.workspaceRoot)} selectable />
      </ListSection>

      {navi && can.forgetSignins ? (
        <ListSection
          header="Sign-ins"
          footer={forgot ? "Forgotten. Its next browser session starts signed out of every site." : `Its browser stays signed in to the sites it signed into. Their cookies stay on ${machine}, where ${p.title} itself can't read them.`}
        >
          <ListRow title="Forget Sign-ins…" destructive chevron={false} {...(busy === null && live ? { onPress: forget } : {})} {...(busy === "forget" ? { accessory: spinner } : {})} />
        </ListSection>
      ) : null}

      {can.delete ? (
        <ListSection footer={navi ? "Its folder stays on its machine." : "Its files, branches and pull requests stay."}>
          <ListRow title={navi ? "Delete Navi" : "Delete Project"} destructive chevron={false} {...(busy === null && live ? { onPress: () => void remove() } : {})} {...(busy === "delete" ? { accessory: spinner } : {})} />
        </ListSection>
      ) : null}
      <TypedDelete words={typing} name={p.title} onCancel={() => setTyping(null)} onDelete={doDelete} />
    </ScrollView>
  );
}

function ChecklistRow({ item }: { item: TodoItem }) {
  const t = useTheme();
  const done = item.state === "done";
  return (
    <View style={styles.item}>
      <Icon name={done ? "check" : "unchecked"} size={20} color={done ? t.success : item.state === "doing" ? t.accent : t.tertiary} />
      <Text style={[type.body, styles.fill, { color: done ? t.secondary : t.label }]}>{item.text}</Text>
      {item.state === "doing" ? <Text style={[type.footnote, { color: t.accent }]}>Doing</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  loading: { marginTop: 64 },
  hero: { alignItems: "center", gap: 6, paddingTop: space.lg, paddingHorizontal: space.xl },
  center: { textAlign: "center" },
  pressed: { opacity: 0.6 },
  item: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 11, minHeight: 44 },
});
