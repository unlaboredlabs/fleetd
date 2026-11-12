// Import from 1Password, a sheet from the Vault's +: the person's 1Password items (read on a machine holding their
// token: titles, kinds and sites, never values), searched, ticked, and brought in with Import, the sheet's ✓. The
// machine reads the ticked ones and seals them to the hub, so no value passes through the phone. They go to the team
// vault, from Settings or a project's Payments alike. After that 1Password is never asked again for them.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useHub } from "../../hubContext";
import { shape, space, type, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { CheckRow, errorWords, Problem, sheetOptions } from "../manage/parts";
import { importItems, searchOnePassword, vaultErrorWords, vaultHub } from "./api";
import { KIND_WORDS, TEAM_KINDS } from "./model";
import { useVaultNav } from "./parts";
import type { VaultImportCandidate } from "./types";

/** How long typing rests before the search goes. */
const TYPED_MS = 400;

export function VaultImport() {
  const t = useTheme();
  const navigation = useVaultNav();
  const { session } = useHub();
  const hub = useMemo(() => vaultHub(session), [session]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly VaultImportCandidate[] | null>(null);
  const [searching, setSearching] = useState(true);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    setSearching(true);
    const timer = setTimeout(
      () =>
        void searchOnePassword(hub, query.trim()).then((r) => {
          if (mine !== gen.current) return;
          setSearching(false);
          if (!r.ok) return setProblem(vaultErrorWords(r.error) ?? errorWords(r.error));
          setProblem(undefined);
          setHits(r.value);
        }),
      hits === null ? 0 : TYPED_MS,
    );
    return () => clearTimeout(timer);
    // `hits` only says whether this is the first search.
  }, [hub, query]);

  const run = async () => {
    if (busy || ticked.size === 0) return;
    setBusy(true);
    setProblem(undefined);
    const r = await importItems(hub, { refs: [...ticked] });
    setBusy(false);
    if (!r.ok) {
      haptics.warning();
      return setProblem(`Not imported: ${vaultErrorWords(r.error) ?? errorWords(r.error)}`);
    }
    if (r.value.errors.length > 0) {
      haptics.warning();
      const title = (ref: string) => hits?.find((h) => h.ref === ref)?.title ?? ref;
      setTicked(new Set(r.value.errors.map((e) => e.ref)));
      return setProblem(r.value.errors.map((e) => `${title(e.ref)}: ${e.message}`).join("\n"));
    }
    haptics.success();
    navigation.goBack();
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      title: "Import from 1Password",
      ...sheetOptions(t, () => navigation.goBack(), { label: ticked.size === 0 ? "Import" : `Import ${String(ticked.size)}`, enabled: ticked.size > 0, busy, onPress: () => void run() }, !busy),
    });
    // `run` reads `ticked`.
  }, [navigation, t, ticked, busy]);

  const toggle = (ref: string) => {
    haptics.select();
    setTicked((s) => {
      const next = new Set(s);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  };

  const groups = TEAM_KINDS.map((kind) => ({ kind, hits: (hits ?? []).filter((h) => h.kind === kind) })).filter((g) => g.hits.length > 0);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: space.xxl }} style={{ backgroundColor: t.grouped }}>
      <View style={[styles.search, { backgroundColor: t.fill }]}>
        <Icon name="search" size={17} color={t.secondary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search 1Password"
          placeholderTextColor={t.secondary}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          returnKeyType="search"
          selectionColor={t.accent}
          style={[type.body, styles.input, { color: t.label }]}
          accessibilityLabel="Search 1Password"
        />
        {searching ? <ActivityIndicator color={t.secondary} /> : null}
      </View>
      {hits === null && searching ? (
        <Text style={[type.footnote, styles.note, { color: t.secondary }]}>Reading your 1Password. The first time on a machine, this can take a few minutes.</Text>
      ) : null}
      <Problem text={problem} />
      {hits !== null && hits.length === 0 && !searching ? (
        <EmptyState icon="search" title="Nothing Found" body={query.trim() === "" ? "Your 1Password has no logins, cards or addresses fleetd can import." : `Nothing in your 1Password matches “${query.trim()}”.`} />
      ) : (
        groups.map((g) => (
          <ListSection key={g.kind} header={KIND_WORDS[g.kind].plural}>
            {g.hits.map((h) => (
              <CheckRow
                key={h.ref}
                title={h.title}
                detail={h.imported !== undefined ? "Already in the vault" : [h.sites?.[0], h.vault].filter((x) => x !== undefined && x !== "").join(" · ")}
                checked={ticked.has(h.ref)}
                disabled={busy || h.imported !== undefined}
                onPress={() => toggle(h.ref)}
              />
            ))}
          </ListSection>
        ))
      )}
      {groups.length === 0 ? null : (
        <Text style={[type.footnote, styles.note, { color: t.secondary }]}>
          They go to the team vault. Your machine reads them and seals them for the hub: no value passes through this phone.
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg, marginTop: space.md, paddingHorizontal: 10, minHeight: 40, borderRadius: shape.capsule ? 20 : 10, borderCurve: "continuous" },
  input: { flex: 1, paddingVertical: 8 },
  note: { marginHorizontal: space.lg * 2, marginTop: space.md },
});
