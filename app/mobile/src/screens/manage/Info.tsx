// A project's own screen, opened from its chat's header, as a contact's in a chat app. Its search bar searches the whole
// chat on the hub (ChatFind.tsx), with filters in the bar's menu; while it's in use the page gives way to the hits.
// Then its avatar and name (tapping the
// avatar, or Edit under it, opens its icon's sheet: its bot, or a photo: IconPicker.tsx), then what
// runs there now (Agents: agents_list, then the DMs its agents sent each other: screens/dms), its open orders (orders_board), its To-do (its checklist) and its recent
// merges with their PRs, read-only; then its name, the profiles its agents may run on, where it lives and its Computer
// (Computer.tsx: its setup and the image its agents start from). Then the
// desktop's sections, each pushed: Approvals, Payments, its Vault, Skills and the chat's Artifacts
// (screens/artifacts); its named MCP servers (Paper: Named.tsx), connected with one tap; Forget Sign-ins; New Screen, a screen of your own for it, where the hub opens them; Archive.
// Delete last, red, in a sheet that erases everything fleetd keeps for it, with a tickbox for its folder, once its
// name is typed (TypedDelete).
import { StackActions, useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { asks, HAS_ORDER, HAS_WORDS, NO_QUERY, othersOf, toggleHas, WHEN_WORDS, type FindFrom, type FindQuery, type FindWhen } from "../../chatFind";
import { findPinsShown } from "../../messagePins";
import { DaySheet, FindView, useChatFind } from "./ChatFind";
import { listTime } from "../../chatView";
import { isArchived, tilde, type ProjectSummary, type TodoItem } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { NEW_SCREEN } from "../../screen";
import { space, type, useTheme, type Palette } from "../../theme";
import { Avatar } from "../../ui/Avatar";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListRow, ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { useNow } from "../time";
import { deleteProject, forgetSignins, readForDelete, readInfo, setArchived, withPart, type Info as InfoRead } from "./api";
import { agentLines, checklist, deleteBlocked, deleteWords, leadValue, machineName, merges, orderLines, profilesValue, subtitle, type DeleteWords, type Tone } from "./model";
import { confirmDestructive, errorWords, Problem } from "./parts";
import { skillsShown } from "./skillsModel";
import { artifactsShown } from "../artifacts/model";
import { vaultShown } from "../vault/model";
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
  const { state, session, paired } = useHub();
  const machine = machineName(state.machines, p.machineId, paired.cloud === true);
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
  const [busy, setBusy] = useState<"delete" | "forget" | "archive" | null>(null);
  const [forgot, setForgot] = useState(false);
  const [typing, setTyping] = useState<DeleteWords | null>(null);
  const v = info.value;

  // The chat's search: the bar's words and the filters, the hits for them, and the day sheet.
  const searchable = findPinsShown(state.hub);
  const [query, setQuery] = useState<FindQuery>(NO_QUERY);
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState(false);
  const found = useChatFind(session, key, query, state.me);
  const others = useMemo(() => othersOf(state.chats[key]?.messages ?? [], state.me), [state.chats, key, state.me]);
  // Only on a hub that searches chats for people: an older one's bar would only fail.
  useLayoutEffect(() => {
    if (!searchable) return;
    navigation.setOptions({
      headerSearchBarOptions: {
            placeholder: "Search",
            hideWhenScrolling: false,
            autoCapitalize: "none",
            tintColor: t.accent,
            onFocus: () => setSearching(true),
            onChangeText: (e) => {
              const words = e.nativeEvent.text;
              setQuery((q) => ({ ...q, words }));
            },
            // Cancel ends the search, its filters too, and the page comes back.
            onCancelButtonPress: () => {
              setQuery(NO_QUERY);
              setSearching(false);
            },
          },
    });
  }, [navigation, searchable, t.accent]);
  // The filters, in the bar's own menu while searching, each ticked while it's on (iOS 26).
  const filtered = query.from !== undefined || query.when !== undefined || query.has.length > 0;
  useLayoutEffect(() => {
    if (Platform.OS !== "ios") return;
    navigation.setOptions({ unstable_headerRightItems: () => (searchable && (searching || asks(query)) ? [filterMenu(query, setQuery, p.title, others, () => setPicking(true), filtered)] : []) });
  }, [navigation, searchable, searching, query, p.title, others, filtered]);
  const openHit = (messageId: string) => {
    haptics.tap();
    navigation.navigate("Chat", { key, messageId, tap: Date.now() });
  };
  const daySheet = (
    <DaySheet
      open={picking}
      onClose={() => setPicking(false)}
      onPick={(day) => {
        setPicking(false);
        setSearching(true);
        setQuery((q) => ({ ...q, when: { t: "day", day } }));
      }}
    />
  );
  if (searchable && (searching || asks(query))) {
    return (
      <>
        <FindView query={query} setQuery={setQuery} find={found.find} more={found.more} again={found.again} bot={p.title} me={state.me} onOpen={(hit) => openHit(hit.messageId)} onPickDay={() => setPicking(true)} />
        {daySheet}
      </>
    );
  }
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
  const editable = live && busy === null;

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
        <Pressable disabled={!editable} onPress={editIcon} hitSlop={8} accessible={false} importantForAccessibility="no" style={({ pressed }) => pressed && styles.pressed}>
          <Text style={[type.subhead, { color: editable ? t.accent : t.tertiary }]}>Edit</Text>
        </Pressable>
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
              title={pr.title}
              detail={`#${String(pr.number)} · ${pr.repo}${pr.mergedAt === undefined ? "" : ` · ${listTime(pr.mergedAt, now)}`}`}
              onPress={() => void Linking.openURL(pr.url)}
            />
          ))}
        </ListSection>
      )}

      <Problem text={v?.error === undefined ? undefined : `Not everything was read: ${errorWords(v.error)}`} />

      <ListSection footer="Its folder keeps its own name.">
        <ListRow title="Name" value={p.title} {...(live ? { onPress: () => navigation.navigate("Rename", { key }) } : {})} />
        {profiles !== undefined && profiles.profiles.length > 1 ? (
          <ListRow title="Agent profiles" value={profilesValue(profiles)} {...(live ? { onPress: () => navigation.navigate("Profiles", { key }) } : {})} />
        ) : null}
        {profiles !== undefined && profiles.profiles.length > 1 ? (
          <ListRow title="Lead model" value={leadValue(profiles)} {...(live ? { onPress: () => navigation.navigate("LeadModel", { key }) } : {})} />
        ) : null}
        <ListRow title="Machine" value={machine} />
        <ListRow title="Folder" value={tilde(p.workspaceRoot)} selectable />
        <ListRow title="Computer" onPress={() => navigation.navigate("Computer", { key })} />
      </ListSection>

      <ListSection>
        <ListRow title="Watching" icon="eye" {...(live ? { onPress: () => navigation.navigate("Watching", { key }) } : {})} />
        <ListRow title="Approvals" icon="approvals" {...(live ? { onPress: () => navigation.navigate("Approvals", { key }) } : {})} />
        <ListRow title="Payments" icon="money" {...(live ? { onPress: () => navigation.navigate("Payments", { key }) } : {})} />
        {vaultShown(state.hub) ? <ListRow title="Vault" icon="lock" onPress={() => navigation.navigate("Vault", { key })} /> : null}
        {skills ? <ListRow title="Skills" icon="sparkles" {...(v?.skills === undefined ? {} : { value: String(v.skills.length) })} onPress={() => navigation.navigate("Skills", { key })} /> : null}
        {artifactsShown(state.hub) ? <ListRow title="Artifacts" icon="fileDoc" onPress={() => navigation.navigate("Artifacts", { key })} /> : null}
      </ListSection>


      <ListSection
        header="Sign-ins"
        footer={forgot ? "Forgotten. Its next browser session starts signed out of every site." : `Its browser stays signed in to the sites it signed into. Their cookies stay on ${machine}.`}
      >
        <ListRow title="Forget Sign-ins…" destructive chevron={false} {...(busy === null && live ? { onPress: forget } : {})} {...(busy === "forget" ? { accessory: spinner } : {})} />
      </ListSection>

      {live && state.hub.phase === "live" && state.hub.features?.includes(NEW_SCREEN) === true ? (
        <ListSection footer={`A browser of your own on ${p.title}'s profile, to sign in to a site for it, or another kind of screen.`}>
          <ListRow title="New Screen" icon="browser" onPress={() => navigation.navigate("NewScreen", { key })} />
        </ListSection>
      ) : null}

      <ListSection footer={archived ? "Archived: its lead doesn't start until you bring it back. Its chat, memory and folder are kept." : "Keeps its chat, memory and folder, and moves it to Archived. Its lead doesn't start until you bring it back."}>
        <ListRow
          title={archived ? "Unarchive Bot" : "Archive Bot"}
          chevron={false}
          {...(busy === null && live ? { onPress: archive } : {})}
          {...(busy === "archive" ? { accessory: spinner } : {})}
        />
      </ListSection>

      <ListSection footer="Erases it and everything fleetd keeps for it. Its folder stays unless you tick it.">
        <ListRow title="Delete Bot" destructive chevron={false} {...(busy === null && live ? { onPress: () => void remove() } : {})} {...(busy === "delete" ? { accessory: spinner } : {})} />
      </ListSection>
      <TypedDelete words={typing} name={p.title} onCancel={() => setTyping(null)} onDelete={doDelete} />
      {daySheet}
    </ScrollView>
  );
}

/** The bar's filter menu: From, Date and what it holds, each ticked while on; picked again, it goes off. */
const filterMenu = (q: FindQuery, set: (q: FindQuery) => void, bot: string, others: readonly { personId: string; name: string }[], pickDay: () => void, on: boolean): NativeStackHeaderItem => {
  const sameFrom = (a: FindFrom | undefined, b: FindFrom): boolean => a?.t === b.t && (a.t !== "person" || (b.t === "person" && a.person.personId === b.person.personId));
  const from = (label: string, f: FindFrom) => ({ type: "action" as const, label, state: sameFrom(q.from, f) ? ("on" as const) : ("off" as const), onPress: () => set({ ...q, from: sameFrom(q.from, f) ? undefined : f }) });
  const when = (w: Exclude<FindWhen["t"], "day">) => ({ type: "action" as const, label: WHEN_WORDS[w], state: q.when?.t === w ? ("on" as const) : ("off" as const), onPress: () => set({ ...q, when: q.when?.t === w ? undefined : { t: w } }) });
  return {
    type: "menu",
    label: "Filters",
    icon: { type: "sfSymbol", name: on ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle" },
    accessibilityLabel: on ? "Filters, on" : "Filters",
    menu: {
      items: [
        {
          type: "submenu",
          label: "From",
          icon: { type: "sfSymbol", name: "person" },
          items: [from("You", { t: "me" }), ...others.map((person) => from(person.name, { t: "person", person })), from(bot, { t: "lead" }), from("Agents", { t: "agents" })],
        },
        {
          type: "submenu",
          label: "Date",
          icon: { type: "sfSymbol", name: "calendar" },
          items: [
            when("today"),
            when("yesterday"),
            when("week"),
            when("month"),
            when("year"),
            { type: "action", label: "Pick a Day…", state: q.when?.t === "day" ? "on" : "off", onPress: pickDay },
          ],
        },
        {
          type: "submenu",
          label: "Contains",
          inline: true,
          items: HAS_ORDER.map((h) => ({ type: "action" as const, label: HAS_WORDS[h] ?? h, state: q.has.includes(h) ? ("on" as const) : ("off" as const), onPress: () => set(toggleHas(q, h)) })),
        },
        ...(on ? [{ type: "action" as const, label: "Clear Filters", destructive: true, onPress: () => set({ ...NO_QUERY, words: q.words }) }] : []),
      ],
    },
  };
};

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
