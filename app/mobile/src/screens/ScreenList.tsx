// A chat's open screens, a sheet from its strip over the composer (ScreenCards.tsx): the ones live now, one asking for
// you first, then those whose task finished and that stay open a while in case it's woken again. A row opens its live
// view (Screen.tsx) once the sheet has gone.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { bubbleTime } from "../chatView";
import { useHub, type RootParams } from "../hubContext";
import { cardTitle, finishedCards, screenCards, type ScreenCard } from "../screen";
import { space, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { SHEET_GONE_MS } from "./manage/arrival";
import { sheetOptions } from "./manage/parts";
import { ICON } from "./ScreenCards";
import { useNow } from "./time";

export function ScreenList({ navigation, route }: NativeStackScreenProps<RootParams, "ScreenList">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const key = route.params.key;
  const who = state.projects?.[key]?.title ?? "Its agent";
  const live = screenCards(state.screens[key]);
  const finished = finishedCards(state.screens[key]);

  useLayoutEffect(() => navigation.setOptions(sheetOptions(t, () => navigation.goBack(), undefined)), [navigation, t]);
  useEffect(() => {
    void session.readScreens(key);
  }, [session, key]);
  // The last one gone (ended, or its task finished with none left live), the list has nothing to say.
  const any = live.length + finished.length > 0;
  useEffect(() => {
    if (!any && state.screens[key] !== undefined) navigation.goBack();
  }, [any, key, navigation, state.screens]);

  // The sheet goes, then the live view comes (dismissing and presenting in one step crashes UIKit).
  const opened = useRef(false);
  const open = (sessionId: string) => {
    if (opened.current) return;
    opened.current = true;
    haptics.tap();
    navigation.goBack();
    setTimeout(() => navigation.navigate("Screen", { key, sessionId }), SHEET_GONE_MS);
  };

  const row = (c: ScreenCard, finishedTask: boolean) => (
    <ListRow
      key={c.id}
      icon={c.reason !== undefined ? "hand" : ICON[c.kind]}
      title={cardTitle(c, who)}
      detail={c.reason ?? c.purpose}
      value={finishedTask ? (c.closesAt === undefined ? "Done" : `Until ${bubbleTime(c.closesAt, now)}`) : c.reason !== undefined ? "Asks you" : c.control === "human" ? "Yours" : "Live"}
      valueDot={finishedTask ? t.tertiary : c.reason !== undefined ? t.warning : c.control === "human" ? t.accent : t.success}
      onPress={() => open(c.id)}
    />
  );

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: t.grouped }} contentContainerStyle={styles.list}>
      {live.length === 0 ? null : <ListSection header="Live now">{live.map((c) => row(c, false))}</ListSection>}
      {finished.length === 0 ? null : (
        <ListSection header="Task finished" footer="Their agents are done. Each stays open until the time it shows, in case its agent is woken again.">
          {finished.map((c) => row(c, true))}
        </ListSection>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: space.xl },
});
