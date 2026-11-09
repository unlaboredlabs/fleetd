// A project's own screen, opened from its chat's header, as a contact's in a chat app: its avatar and name (tapping the
// avatar, or Edit under it, opens its icon's sheet: its bot, or a photo: IconPicker.tsx), then what
// runs there now (Agents: agents_list, then the DMs its agents sent each other: screens/dms), its open orders (orders_board), its To-do (its checklist) and its recent
// merges with their PRs, read-only; then its name, the profiles its agents may run on and where it lives, and Only
// me. Then the desktop's sections, each pushed: Approvals, Payments, Linked hubs, Skills and the chat's
// Artifacts (screens/artifacts); Forget Sign-ins; New Screen, a screen of your own for it, where the hub opens them;
// Archive. Delete last, red, in a sheet that erases everything fleetd keeps for it, with a tickbox for its folder,
// once its name is typed (TypedDelete). What the person may not do isn't offered.
import { StackActions, useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { listTime } from "../../chatView";
import { isArchived, isOnlyMe, tilde, type ProjectSummary, type TodoItem } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { NEW_SCREEN } from "../../screen";
import { space, type, useTheme, type Palette } from "../../theme";
import { Avatar } from "../../ui/Avatar";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListRow, ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { useNow } from "../time";
import { deleteProject, forgetSignins, readForDelete, readInfo, setArchived, setOnlyMe, withPart, type Info as InfoRead } from "./api";
import { agentLines, checklist, deleteBlocked, deleteWords, machineName, manages, merges, orderLines, profilesValue, subtitle, type DeleteWords, type Tone } from "./model";
import { confirmDestructive, errorWords, Problem } from "./parts";
import { skillsShown } from "./skillsModel";
import { artifactsShown } from "../artifacts/model";
import { countValue, dmsShown } from "../dms/model";
import { TypedDelete } from "./TypedDelete";

/** Each project's screen as last read this launch: it opens on that at once, as chat apps' profiles do, while its reads go again. */
const lastRead = new Map<string, InfoRead>();

/**
 * The screen's reads, each section shown as its own read lands, over what was last read; `reading` until all have.
 * A failure said by the last read goes until one of these fails again.
 */
const useInfo = (key: string, read: (part: (got: InfoRead) => void) => Promise<InfoRead>, deps: readonly unknown[]): { value: InfoRead | undefined; reading: boolean; reload: () => void } => {
  const shown = useRef(lastRead.get(key));
  const [value, setValue] = useState(shown.current);
  const [reading, setReading] = useState(true);
  const gen = useRef(0);
  // `read` is new on each render; what it reads is in `deps`.
  const run = useCallback(read, deps);
  const reload = useCallback(() => {
    const mine = ++gen.current;
    const put = (v: InfoRead) => {
      shown.current = v;
      lastRead.set(key, v);
      setValue(v);
    };
    if (shown.current?.error !== undefined) {
      const { error: _error, ...rest } = shown.current;
      put(rest);
    }
    setReading(true);
    void run((got) => {
      if (mine === gen.current) put(withPart(shown.current ?? {}, got));
    }).then(() => {
      if (mine === gen.current) setReading(false);
    });
  }, [run, key]);
  useEffect(() => {
    reload();
    return () => {
      gen.current++;
    };
  }, [reload]);
  return { value, reading, reload };
};

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
  const machine = machineName(state.machines, p.machineId);
  const can = manages(p, state.me);
  const archived = isArchived(p);
  const skills = skillsShown(state.hub);
  const dms = dmsShown(state.hub);
  const live = state.hub.phase === "live";
  const key = `${p.machineId}/${p.projectId}`;
  // Read again when its machine comes back or goes: what its node holds is as of the read.
  const status = state.machines.find((m) => m.machineId === p.machineId)?.status;
  // Read again once the link is live: one read before it (a launch opening on the cached chats) answers offline.
  const info = useInfo(key, (part) => readInfo(session, p, Date.now(), { skills, dms }, part), [session, key, skills, dms, live, status]);
  // Back from Agent Profiles or Rename: read again (the first focus is the mount's read).
  const { reload } = info;
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) reload();
      shown.current = true;
    }, [reload]),
  );
  const [busy, setBusy] = useState<"delete" | "forget" | "onlyMe" | "archive" | null>(null);
  const [forgot, setForgot] = useState(false);
  const [typing, setTyping] = useState<DeleteWords | null>(null);
  const v = info.value;
  const agents = agentLines(v?.agents ?? []);
  const orders = orderLines(v?.orders ?? []);
  const list = checklist(v?.checklist ?? []);
  const merged = merges(v?.prs ?? []);

  const remove = async () => {
    setBusy("delete");
    const read = await readForDelete(session, p);
    setBusy(null);
    if (!read.ok) return Alert.alert(`Couldn't check ${p.title}`, errorWords(read.error));
    const blocked = deleteBlocked(read.value);
    if (blocked !== undefined) return Alert.alert(`Can't delete ${p.title} now`, blocked);
    // Erased, with the tickbox for its folder: the sheet with its name typed, as on the desktop.
    setTyping(deleteWords(p, read.value, machine));
  };

  // Back to Chats first, then the delete: its row then goes from a list on screen, never in the same commit as these
  // screens (the list's rows slide with a LayoutAnimation, which must not land on a screen's removal).
  const doDelete = (folderToo: boolean) => {
    setTyping(null);
    navigation.getParent()?.dispatch(StackActions.popToTop());
    void deleteProject(session, p, folderToo).then((r) => {
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

  const onlyMe = (on: boolean) => {
    haptics.select();
    setBusy("onlyMe");
    void setOnlyMe(session, p, on).then((r) => {
      setBusy(null);
      if (!r.ok) Alert.alert(on ? "Couldn't make it yours alone" : "Couldn't share it", errorWords(r.error));
    });
  };

  // Archived, it goes from the chats to Archived: back there first, as for a delete. Brought back, it stays here.
  const archive = () => {
    setBusy("archive");
    if (!archived) navigation.getParent()?.dispatch(StackActions.popToTop());
    void setArchived(session, p, !archived).then((r) => {
      setBusy(null);
      if (!r.ok) return Alert.alert(archived ? `Couldn't bring back ${p.title}` : `Couldn't archive ${p.title}`, errorWords(r.error));
      haptics.success();
    });
  };

  const editIcon = () => {
    haptics.tap();
    navigation.navigate("Icon", { key });
  };
  const editable = can && live && busy === null;

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
          <Avatar name={p.title} size={96} picture={p} />
        </Pressable>
        {can ? (
          <Pressable disabled={!editable} onPress={editIcon} hitSlop={8} accessible={false} importantForAccessibility="no" style={({ pressed }) => pressed && styles.pressed}>
            <Text style={[type.subhead, { color: editable ? t.accent : t.tertiary }]}>Edit</Text>
          </Pressable>
        ) : null}
        <Text style={[type.title2, styles.center, { color: t.label }]} selectable>
          {p.title}
        </Text>
        <Text style={[type.subhead, styles.center, { color: t.secondary }]}>{subtitle(p, machine)}</Text>
      </View>

      <ListSection header="Agents">
        {v?.agents === undefined && info.reading ? (
          <ListRow title="Reading…" accessory={spinner} />
        ) : agents.length === 0 ? (
          <ListRow title="Nothing running" valueColor={t.secondary} />
        ) : (
          agents.map((a) => <ListRow key={a.id} title={a.title} detail={a.role === "" ? undefined : a.role} value={a.status} valueColor={toneColor(t, a.tone)} />)
        )}
        {dms ? <ListRow key="dms" title="DMs Between Agents" value={countValue(v?.dms)} onPress={() => navigation.navigate("Dms", { key })} /> : null}
      </ListSection>

      {orders.length === 0 ? null : (
        <ListSection header="Orders">
          {orders.map((o) => (
            <ListRow key={o.id} title={o.title} detail={o.progress === undefined ? o.phase : `${o.phase} · ${o.progress}`} />
          ))}
        </ListSection>
      )}

      {list.items.length === 0 ? null : (
        <ListSection header="To-do" {...(list.summary === undefined ? {} : { footer: list.more > 0 ? `${list.summary} · ${String(list.more)} more in the desktop app` : list.summary })}>
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

      <ListSection footer="Its folder keeps its own name.">
        <ListRow title="Name" value={p.title} {...(can && live ? { onPress: () => navigation.navigate("Rename", { key }) } : {})} />
        {can && profiles !== undefined && profiles.profiles.length > 1 ? (
          <ListRow title="Agent profiles" value={profilesValue(profiles)} {...(live ? { onPress: () => navigation.navigate("Profiles", { key }) } : {})} />
        ) : null}
        <ListRow title="Machine" value={machine} />
        <ListRow title="Folder" value={tilde(p.workspaceRoot)} selectable />
      </ListSection>

      {can ? (
        <ListSection footer={isOnlyMe(p) ? "Only you see it and use it." : "Everyone on this hub sees it and can use it."}>
          <ListRow
            title="Only Me"
            accessory={busy === "onlyMe" ? spinner : <Switch value={isOnlyMe(p)} disabled={!live || busy !== null} onValueChange={onlyMe} accessibilityLabel="Only me" />}
          />
        </ListSection>
      ) : null}

      <ListSection>
        {can ? <ListRow title="Approvals" icon="approvals" tint={t.tints[0]} {...(live ? { onPress: () => navigation.navigate("Approvals", { key }) } : {})} /> : null}
        {can ? <ListRow title="Payments" icon="money" tint={t.tints[3]} {...(live ? { onPress: () => navigation.navigate("Payments", { key }) } : {})} /> : null}
        {can ? <ListRow title="Linked Hubs" icon="link" tint={t.tints[6]} {...(live ? { onPress: () => navigation.navigate("LinkedHubs", { key }) } : {})} /> : null}
        {skills ? <ListRow title="Skills" icon="sparkles" tint={t.tints[1]} {...(v?.skills === undefined ? {} : { value: String(v.skills.length) })} onPress={() => navigation.navigate("Skills", { key })} /> : null}
        {artifactsShown(state.hub) ? <ListRow title="Artifacts" icon="fileDoc" tint={t.tints[2]} onPress={() => navigation.navigate("Artifacts", { key })} /> : null}
      </ListSection>

      {can ? (
        <ListSection
          header="Sign-ins"
          footer={forgot ? "Forgotten. Its next browser session starts signed out of every site." : `Its browser stays signed in to the sites it signed into. Their cookies stay on ${machine}.`}
        >
          <ListRow title="Forget Sign-ins…" destructive chevron={false} {...(busy === null && live ? { onPress: forget } : {})} {...(busy === "forget" ? { accessory: spinner } : {})} />
        </ListSection>
      ) : null}

      {live && state.hub.phase === "live" && state.hub.features?.includes(NEW_SCREEN) === true ? (
        <ListSection footer={`A browser of your own on ${p.title}'s profile, to sign in to a site for it, or another kind of screen.`}>
          <ListRow title="New Screen" icon="browser" onPress={() => navigation.navigate("NewScreen", { key })} />
        </ListSection>
      ) : null}

      {can ? (
        <ListSection footer={archived ? "Archived: its lead doesn't start until you bring it back. Its chat, memory and folder are kept." : "Keeps its chat, memory and folder, and moves it to Archived. Its lead doesn't start until you bring it back."}>
          <ListRow
            title={archived ? "Unarchive Project" : "Archive Project"}
            chevron={false}
            {...(busy === null && live ? { onPress: archive } : {})}
            {...(busy === "archive" ? { accessory: spinner } : {})}
          />
        </ListSection>
      ) : null}

      {can ? (
        <ListSection footer="Erases it and everything fleetd keeps for it. Its folder stays unless you tick it.">
          <ListRow title="Delete Project" destructive chevron={false} {...(busy === null && live ? { onPress: () => void remove() } : {})} {...(busy === "delete" ? { accessory: spinner } : {})} />
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
