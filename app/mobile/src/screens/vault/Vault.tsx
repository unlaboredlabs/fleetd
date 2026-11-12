// The Vault, as iOS's Passwords app lists its own: from Settings, the team's logins, cards and addresses, which every
// project's agents fill; from a project's screen, its variables and its orders'. A section per kind, each row its
// kind's tile, its label and one quiet line ("amazon.com", "Visa ••4242"). The bar's search field narrows the list; its
// + is a menu of the three kinds and Import from 1Password (a project's: a new variable). A row swipes left (or is held)
// to delete, to the trash for 30 days, when the person may (its creator or an admin). Under the team's list, only when
// it has items, the person's own items set aside from before the team vault: each moved where it's used, or deleted.
// The list holds metadata alone: no value is read until an item is opened and revealed (VaultItem.tsx), and the list
// reads again on vault.changed.
import { useLayoutEffect, useMemo, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useHub } from "../../hubContext";
import { shape, space, type, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { HoldMenu } from "../../ui/HoldMenu";
import type { MenuItem } from "../../ui/Menu";
import { Icon } from "../../ui/Icon";
import { ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { SwipeGroup, SwipeRow, useSwipeGroup } from "../../ui/SwipeRow";
import { confirmDestructive, errorWords, Problem, Symbol, useRead } from "../manage/parts";
import { deleteItem, listItems, moveItem, vaultErrorWords, vaultHub } from "./api";
import { KIND_WORDS, rowLine, sections, SET_ASIDE_WHY, TEAM_KINDS, teamVault, titleOf } from "./model";
import { KindTile, useVaultChanged, useVaultNav, useVaultRoute, whoseOf } from "./parts";
import type { VaultItemSummary, VaultKind } from "./types";

export function Vault() {
  const t = useTheme();
  const navigation = useVaultNav();
  const key = useVaultRoute<"Vault">().params?.key;
  const { state, session } = useHub();
  const hub = useMemo(() => vaultHub(session), [session]);
  const { whose, project } = whoseOf(state, key);
  const team = teamVault(state.hub);
  const list = useRead(() => listItems(hub, whose, team), [hub, key, team]);
  useVaultChanged(session, list.reload);
  const [query, setQuery] = useState("");
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const swipes = useSwipeGroup();
  const live = state.hub.phase === "live";

  const add = (kind: VaultKind) => navigation.navigate("VaultEdit", { kind, ...(key === undefined ? {} : { key }) });
  const importFrom = () => navigation.navigate("VaultImport");

  useLayoutEffect(() => {
    const kinds = TEAM_KINDS.map((k) => ({ kind: k, label: KIND_WORDS[k].one }));
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: "Search",
        hideWhenScrolling: false,
        onChangeText: (e) => setQuery(e.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
        onFocus: swipes.close,
        tintColor: t.accent,
      },
      ...(Platform.OS === "ios"
        ? {
            unstable_headerRightItems: () =>
              !live
                ? []
                : key !== undefined
                  ? [{ type: "button", label: "Add", icon: { type: "sfSymbol", name: "plus" }, accessibilityLabel: "Add a variable", onPress: () => add("env") }]
                  : [
                    {
                      type: "menu",
                      label: "Add",
                      icon: { type: "sfSymbol", name: "plus" },
                      accessibilityLabel: "Add to the Vault",
                      menu: {
                        items: [
                          ...kinds.map((k) => ({ type: "action" as const, label: k.label, icon: { type: "sfSymbol" as const, name: SYMBOL[k.kind] }, onPress: () => add(k.kind) })),
                          { type: "action" as const, label: "Import from 1Password", icon: { type: "sfSymbol" as const, name: "square.and.arrow.down" as const }, onPress: importFrom },
                        ],
                      },
                    },
                  ],
          }
        : {
            headerRight: () =>
              live ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={key === undefined ? "Add to the Vault" : "Add a variable"}
                  hitSlop={12}
                  onPress={() => {
                    haptics.tap();
                    if (key !== undefined) return add("env");
                    Alert.alert("Add to the Vault", undefined, [...kinds.map((k) => ({ text: k.label, onPress: () => add(k.kind) })), { text: "Import from 1Password", onPress: importFrom }, { text: "Cancel", style: "cancel" as const }]);
                  }}
                >
                  <Symbol ios="plus" android="add" size={24} color={t.accent} />
                </Pressable>
              ) : null,
          }),
    });
    // `add` and `importFrom` read only `key` and `navigation`.
  }, [navigation, t.accent, live, key, swipes.close]);

  const setAsideOf = (item: VaultItemSummary) => list.value?.ok === true && list.value.value.setAside.some((i) => i.itemId === item.itemId);
  const remove = (item: VaultItemSummary) =>
    confirmDestructive({
      title: `Delete ${titleOf(item)}?`,
      message: setAsideOf(item) ? TRASH : item.kind === "env" ? `Agents stop getting it from their next start. ${TRASH}` : `Agents can't use it any more. ${TRASH}`,
      button: "Delete",
      onConfirm: () => {
        setGone((g) => new Set(g).add(item.itemId));
        void deleteItem(hub, item.itemId).then((r) => {
          if (r.ok) return haptics.success();
          setGone((g) => {
            const next = new Set(g);
            next.delete(item.itemId);
            return next;
          });
          setProblem(`Couldn't delete ${titleOf(item)}: ${vaultErrorWords(r.error) ?? errorWords(r.error)}`);
        });
      },
    });

  /** A set-aside item moved where it's used: a login, card or address to the team vault; a variable to a project picked. */
  const move = (item: VaultItemSummary) => {
    if (item.kind === "env") return navigation.navigate("VaultMove", { item });
    setGone((g) => new Set(g).add(item.itemId));
    void moveItem(hub, item.itemId).then((r) => {
      if (r.ok) {
        list.reload();
        return haptics.success();
      }
      setGone((g) => {
        const next = new Set(g);
        next.delete(item.itemId);
        return next;
      });
      setProblem(`Couldn't move ${titleOf(item)}: ${vaultErrorWords(r.error) ?? errorWords(r.error)}`);
    });
  };
  const moveWord = (item: VaultItemSummary) => (item.kind === "env" ? "Add to a Project…" : "Move to Team Vault");
  const setAsideActions = (item: VaultItemSummary) => {
    haptics.tap();
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ title: titleOf(item), options: [moveWord(item), "Delete", "Cancel"], destructiveButtonIndex: 1, cancelButtonIndex: 2 }, (i) => {
        if (i === 0) move(item);
        if (i === 1) remove(item);
      });
      return;
    }
    Alert.alert(titleOf(item), undefined, [{ text: moveWord(item), onPress: () => move(item) }, { text: "Delete", style: "destructive", onPress: () => remove(item) }, { text: "Cancel", style: "cancel" }]);
  };

  const r = list.value;
  const items = r?.ok === true ? r.value.items.filter((i) => !gone.has(i.itemId)) : [];
  const setAside = r?.ok === true ? r.value.setAside.filter((i) => !gone.has(i.itemId) && i.deletedMs === undefined) : [];
  const shown = sections(items, query);

  return (
    <SwipeGroup swipes={swipes}>
      <ScrollView
        style={{ backgroundColor: t.grouped }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: space.xxl }}
        onScrollBeginDrag={swipes.close}
        onTouchStart={swipes.touched}
        refreshControl={<RefreshControl refreshing={false} onRefresh={list.reload} tintColor={t.secondary} />}
      >
        {r === undefined ? (
          <ActivityIndicator style={styles.loading} color={t.secondary} />
        ) : !r.ok ? (
          <Problem text={`Couldn't read the vault: ${vaultErrorWords(r.error) ?? errorWords(r.error)}`} />
        ) : items.length === 0 ? (
          <EmptyState
            icon="lock"
            title={project === undefined ? "Team Vault" : "No Variables Yet"}
            body={project === undefined ? "Logins, cards and addresses every project's agents use without seeing them." : `Variables ${project.title}'s agents get when they start.`}
            {...(live ? { action: project === undefined ? { label: "Add Login", onPress: () => add("login") } : { label: "Add Variable", onPress: () => add("env") } } : {})}
          />
        ) : shown.length === 0 ? (
          <EmptyState icon="search" title="No Results" body={`Nothing in the vault matches “${query.trim()}”.`} />
        ) : (
          shown.map((s) => (
            <ListSection key={s.kind} header={s.header}>
              {s.items.map((item) => (
                <ItemRow
                  key={item.itemId}
                  icon
                  item={item}
                  {...(item.canEdit && live ? { onDelete: () => remove(item) } : {})}
                  onPress={() => {
                    haptics.tap();
                    navigation.navigate("VaultItem", { itemId: item.itemId, item, ...(key === undefined ? {} : { key }) });
                  }}
                  onEdit={item.canEdit && live ? () => navigation.navigate("VaultEdit", { kind: item.kind, item, ...(key === undefined ? {} : { key }) }) : undefined}
                />
              ))}
            </ListSection>
          ))
        )}
        <Problem text={problem} />
        {r?.ok === true && items.length > 0 && query === "" ? (
          <Text style={[type.footnote, styles.footer, { color: t.secondary }]}>
            {project === undefined ? "Every project's agents fill these without seeing them. Every use is logged." : `${project.title}'s agents get these when they start. Every use is logged.`}
          </Text>
        ) : null}
        {setAside.length === 0 ? null : (
          <ListSection header="Set Aside" footer={SET_ASIDE_WHY}>
            {setAside.map((item) => (
              <ItemRow
                key={item.itemId}
                icon
                item={item}
                onPress={() => setAsideActions(item)}
                menu={[
                  { label: moveWord(item), icon: item.kind === "env" ? "folder" : "import", onPress: () => move(item) },
                  { label: "Delete", icon: "trash", destructive: true, onPress: () => remove(item) },
                ]}
                {...(live ? { onDelete: () => remove(item) } : {})}
              />
            ))}
          </ListSection>
        )}
      </ScrollView>
    </SwipeGroup>
  );
}

const TRASH = "It stays in the trash for 30 days.";

const SYMBOL: Readonly<Record<VaultKind, "key" | "creditcard" | "house" | "terminal">> = { login: "key", card: "creditcard", address: "house", env: "terminal" };

/** `icon` is ListSection's sign to inset the separator past the tile. */
function ItemRow({ item, onPress, onEdit, onDelete, menu: given }: { item: VaultItemSummary; icon: true; onPress: () => void; onEdit?: (() => void) | undefined; onDelete?: () => void; menu?: readonly MenuItem[] }) {
  const t = useTheme();
  const title = titleOf(item);
  const line = rowLine(item);
  const face = (
    <View style={styles.row}>
      <KindTile kind={item.kind} />
      <View style={styles.grow}>
        <Text style={[type.body, { color: t.label }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={1}>
          {line}
        </Text>
      </View>
      <Icon name="chevron" size={14} color={t.tertiary} weight="semibold" />
    </View>
  );
  const menu = given ?? [...(onEdit === undefined ? [] : [{ label: "Edit", icon: "edit" as const, onPress: onEdit }]), ...(onDelete === undefined ? [] : [{ label: "Delete", icon: "trash" as const, destructive: true, onPress: onDelete }])];
  const label = `${title}, ${line}`;
  const held = (tap: (run: () => void) => () => void) => (
    <HoldMenu items={menu} radius={shape.group} color={t.cell} onPress={tap(onPress)} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => (pressed ? { backgroundColor: t.fillQuiet } : null)}>
      {face}
    </HoldMenu>
  );
  if (onDelete === undefined) return held((run) => run);
  return (
    <SwipeRow id={item.itemId} leading={[]} trailing={[{ label: "Delete", icon: "trashFill", color: t.danger, onPress: onDelete }]}>
      {(tap) => held(tap)}
    </SwipeRow>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: shape.row, paddingHorizontal: space.lg, paddingVertical: 9 },
  grow: { flex: 1, gap: 1 },
  footer: { marginHorizontal: space.lg * 2, marginTop: space.md },
});
