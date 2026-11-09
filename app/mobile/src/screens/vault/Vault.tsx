// The Vault, as iOS's Passwords app lists its own: the person's logins, cards, addresses and variables (with the hub's
// items everyone's work uses) from Settings, or a project's own from its screen. A section per kind, each row its kind's
// tile, its label and one quiet line ("amazon.com", "Visa ••4242"), and where it's used when that isn't only the
// person's own work. The bar's search field narrows the list; its + is a menu of the four kinds and Import from
// 1Password. A row swipes left (or is held) to delete, to the trash for 30 days. The list holds metadata alone: no
// value is read until an item is opened and revealed (VaultItem.tsx), and the list reads again on vault.changed.
import { useLayoutEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useHub } from "../../hubContext";
import { shape, space, type, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { HoldMenu } from "../../ui/HoldMenu";
import { Icon } from "../../ui/Icon";
import { ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { SwipeGroup, SwipeRow, useSwipeGroup } from "../../ui/SwipeRow";
import { confirmDestructive, errorWords, Problem, Symbol, useRead } from "../manage/parts";
import { deleteItem, listItems, vaultErrorWords, vaultHub } from "./api";
import { KIND_WORDS, KINDS, rowLine, scopeTag, sections, titleOf } from "./model";
import { KindTile, useVaultChanged, useVaultNav, useVaultRoute, whoseOf } from "./parts";
import type { VaultItemSummary, VaultKind } from "./types";

export function Vault() {
  const t = useTheme();
  const navigation = useVaultNav();
  const key = useVaultRoute<"Vault">().params?.key;
  const { state, session } = useHub();
  const hub = useMemo(() => vaultHub(session), [session]);
  const { whose, project } = whoseOf(state, key);
  const list = useRead(() => listItems(hub, whose), [hub, key]);
  useVaultChanged(session, list.reload);
  const [query, setQuery] = useState("");
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const swipes = useSwipeGroup();
  const live = state.hub.phase === "live";

  const add = (kind: VaultKind) => navigation.navigate("VaultEdit", { kind, ...(key === undefined ? {} : { key }) });
  const importFrom = () => navigation.navigate("VaultImport", key === undefined ? undefined : { key });

  useLayoutEffect(() => {
    const kinds = KINDS.map((k) => ({ kind: k, label: KIND_WORDS[k].one }));
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
              live
                ? [
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
                  ]
                : [],
          }
        : {
            headerRight: () =>
              live ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add to the Vault"
                  hitSlop={12}
                  onPress={() => {
                    haptics.tap();
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

  const remove = (item: VaultItemSummary) =>
    confirmDestructive({
      title: `Delete ${titleOf(item)}?`,
      message: item.kind === "env" ? "Agents stop getting it from their next start. It stays in the trash for 30 days." : "Agents can't use it any more. It stays in the trash for 30 days.",
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

  const r = list.value;
  const items = r?.ok === true ? r.value.filter((i) => !gone.has(i.itemId)) : [];
  const shown = sections(items, query);
  const projectName = (machineId: string, projectId: string) => (project?.machineId === machineId && project.projectId === projectId ? undefined : state.projects?.[`${machineId}/${projectId}`]?.title);

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
            title={project === undefined ? "Your Vault" : "No Items Yet"}
            body={
              project === undefined
                ? "Logins, cards, addresses and variables. Your agents sign in, pay and fill forms with them without ever seeing them."
                : `Logins, cards, addresses and variables for ${project.title}. Its agents use them without ever seeing them.`
            }
            {...(live ? { action: { label: "Add Login", onPress: () => add("login") } } : {})}
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
                  tag={scopeTag(item, projectName)}
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
            {project === undefined ? "Agents fill these in and get their variables without seeing them. Every use is logged." : `${project.title}'s agents fill these in and get its variables without seeing them. Every use is logged.`}
          </Text>
        ) : null}
      </ScrollView>
    </SwipeGroup>
  );
}

const SYMBOL: Readonly<Record<VaultKind, "key" | "creditcard" | "house" | "terminal">> = { login: "key", card: "creditcard", address: "house", env: "terminal" };

/** `icon` is ListSection's sign to inset the separator past the tile. */
function ItemRow({ item, tag, onPress, onEdit, onDelete }: { item: VaultItemSummary; tag: string | undefined; icon: true; onPress: () => void; onEdit: (() => void) | undefined; onDelete?: () => void }) {
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
      {tag === undefined ? null : (
        <Text style={[type.subhead, styles.tag, { color: t.secondary }]} numberOfLines={1}>
          {tag}
        </Text>
      )}
      <Icon name="chevron" size={14} color={t.tertiary} weight="semibold" />
    </View>
  );
  const menu = [...(onEdit === undefined ? [] : [{ label: "Edit", icon: "edit" as const, onPress: onEdit }]), ...(onDelete === undefined ? [] : [{ label: "Delete", icon: "trash" as const, destructive: true, onPress: onDelete }])];
  const label = [title, line, tag].filter((x) => x !== undefined).join(", ");
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
  tag: { maxWidth: "35%" },
  footer: { marginHorizontal: space.lg * 2, marginTop: space.md },
});
