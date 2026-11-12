// What the Vault's screens share: each kind's tile (a key, a card, a house, a terminal, as iOS's Passwords draws its
// groups), the reads again on a vault event and on coming back to a screen, and which list a screen shows.
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { SFSymbol, AndroidSymbol } from "expo-symbols";
import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import type { ProjectRef } from "../../desktop";
import type { VaultParams } from "../../hubContext";
import type { Session } from "../../session";
import type { State } from "../../store";
import { refOf } from "../../store";
import { useTheme, type Palette } from "../../theme";
import { Symbol } from "../manage/parts";
import { touchesVault, type Whose } from "./api";
import type { VaultKind } from "./types";

const GLYPH: Readonly<Record<VaultKind, readonly [SFSymbol, AndroidSymbol]>> = {
  login: ["key.fill", "key"],
  card: ["creditcard.fill", "credit_card"],
  address: ["house.fill", "home"],
  env: ["terminal.fill", "terminal"],
};

const tileColor = (t: Palette, kind: VaultKind): string =>
  ({ login: t.tints[0], card: t.tints[1], address: t.tints[2], env: t.tints[6] })[kind] ?? t.accentDeep;

export function KindTile({ kind, size = 29 }: { kind: VaultKind; size?: number }) {
  const t = useTheme();
  const [ios, android] = GLYPH[kind];
  return (
    <View style={[styles.tile, { width: size, height: size, borderRadius: size * 0.24, backgroundColor: tileColor(t, kind) }]}>
      <Symbol ios={ios} android={android} size={size * 0.55} color="#FFFFFF" weight="medium" />
    </View>
  );
}

/** Reads again on a vault event (an item changed, or used), and on coming back to the screen after the first time. */
export const useVaultChanged = (session: Session, reload: () => void): void => {
  useEffect(() => session.onEvent((event) => (touchesVault(event) ? reload() : undefined)), [session, reload]);
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) reload();
      shown.current = true;
    }, [reload]),
  );
};

/** The Vault's screens' navigation, in either stack they sit in (Settings', a project's). */
export const useVaultNav = () => useNavigation<NativeStackNavigationProp<VaultParams>>();
export const useVaultRoute = <K extends keyof VaultParams>() => useRoute<RouteProp<VaultParams, K>>();

/** Which list a screen shows: a project's variables when it was opened from one, else the team vault. */
export const whoseOf = (state: State, key: string | undefined): { whose: Whose; project?: ProjectRef & { title: string } } => {
  if (key === undefined) return { whose: { kind: "team" } };
  const p = state.projects?.[key];
  const ref = refOf(key);
  return { whose: { kind: "project", project: ref }, project: { ...ref, title: p?.title ?? "This project" } };
};

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center" },
});
