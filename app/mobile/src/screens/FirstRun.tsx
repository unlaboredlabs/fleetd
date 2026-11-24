// A new fleetd cloud team's first run, in the chats list's place while it has no bots (firstRun.ts): a plan or
// credits, Claude, then a bot, each a row that opens where it's done (Settings › Billing, Providers › Anthropic, +)
// and ticks once the team has it. Read again on coming back to the list and to the app, so a step done in Settings
// or on the web shows ticked.
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, View } from "react-native";
import type { ClaudeAccountsGetOutput } from "../../../desktop/src/shared/contracts";
import { readTeamBilling } from "../billing";
import { firstRunSteps, nextStep, type FirstRunId } from "../firstRun";
import { useHub } from "../hubContext";
import { space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { ListRow, ListSection } from "../ui/List";
import { useRead } from "./manage/parts";

export function FirstRun({ open }: { open: (step: FirstRunId) => void }) {
  const t = useTheme();
  const { session, paired } = useHub();
  const billing = useRead(() => readTeamBilling(paired), [paired]);
  const claude = useRead(() => session.call("claude_accounts_get", {}), [session]);
  const reload = useCallback(() => {
    billing.reload();
    claude.reload();
  }, [billing.reload, claude.reload]);
  // Back from Settings: read again (the first focus is the mount's read).
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) reload();
      shown.current = true;
    }, [reload]),
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") reload();
    });
    return () => sub.remove();
  }, [reload]);

  // Both read before any row shows, so none moves in late. Billing that can't be read is a team with nothing to buy.
  if (billing.value === undefined || claude.value === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  const steps = firstRunSteps(billing.value.ok ? billing.value.value : null, claude.value.ok ? (claude.value.output as ClaudeAccountsGetOutput) : undefined);
  const next = nextStep(steps);

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <View style={[styles.disc, { backgroundColor: t.accentSoft }]}>
          <Icon name="bubble" size={34} color={t.accent} />
        </View>
        <Text style={[type.title3, styles.center, { color: t.label }]}>Get Started</Text>
        <Text style={[type.subhead, styles.center, { color: t.secondary }]}>A few steps before your first bot can answer.</Text>
      </View>
      <ListSection>
        {steps.map((s) => (
          <ListRow
            key={s.id}
            title={s.title}
            detail={s.detail}
            // A plain mark, no tile: a circle to do, the check once done.
            // VoiceOver hears the title, which says whether it's done, not the symbol's own name.
            mark={
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Icon name={s.done ? "check" : "unchecked"} size={24} color={s.done ? t.success : s.id === next ? t.label : t.tertiary} />
              </View>
            }
            tint="transparent"
            {...(s.done && s.id !== "plan"
              ? {}
              : {
                  onPress: () => {
                    haptics.tap();
                    open(s.id);
                  },
                })}
          />
        ))}
      </ListSection>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 96 },
  wrap: { paddingTop: space.xl },
  head: { alignItems: "center", gap: space.sm, paddingHorizontal: space.xxl, paddingBottom: space.lg },
  disc: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
  center: { textAlign: "center" },
});
