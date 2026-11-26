// A new fleetd cloud team's first run, in the chats list's place while it has no bots (firstRun.ts): where agents
// run, Claude, then a bot, each a row that ticks once the team has it. Where agents run is open right under its row
// while it isn't done: the team's own computer, free (the join line to run there, Copy and Share, ticking live when it
// connects), fleetd's computers (Billing), and Tailscale's Connect for a machine or services on a tailnet. Claude and
// a bot open where they're done (Providers › Anthropic, +). Read again on coming back to the list and to the app, so a
// step done in Settings or on the web shows ticked.
import { useFocusEffect } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, Share, StyleSheet, Text, View } from "react-native";
import type { ClaudeAccountsGetOutput, MachineJoinOutput, TailnetState } from "../../../desktop/src/shared/contracts";
import { readTeamBilling, sells } from "../billing";
import { tailnetWaits } from "../desktop";
import { computersChoice, firstRunSteps, nextStep, type ComputersChoice, type FirstRunId } from "../firstRun";
import { useHub } from "../hubContext";
import { mono, space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { ListRow, ListSection } from "../ui/List";
import { TailscaleRow } from "./Connections";
import { errorWords, useRead } from "./manage/parts";

/** `open`: Billing for fleetd's computers, Claude's settings, a new bot. */
export function FirstRun({ open }: { open: (step: FirstRunId) => void }) {
  const t = useTheme();
  const { session, paired, state } = useHub();
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
  const team = billing.value.ok ? billing.value.value : null;
  const steps = firstRunSteps(team, claude.value.ok ? (claude.value.output as ClaudeAccountsGetOutput) : undefined, sells(Platform.OS), state.machines);
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
            // Where agents run opens right under the steps; done, nothing is left to do there.
            {...(s.done || s.id === "where"
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
      {next === "where" ? <Where computers={computersChoice(team, sells(Platform.OS))} onBilling={() => open("where")} /> : null}
    </View>
  );
}

/**
 * Where agents run, while nothing does: the team's own computer by the line to run on it (renewed before its code runs
 * out), fleetd's computers once they're on for the team, and Tailscale. The step above ticks once the computer joins.
 */
function Where({ computers, onBilling }: { computers: ComputersChoice | null; onBilling: () => void }) {
  const t = useTheme();
  const { session, state } = useHub();
  const [join, setJoin] = useState<{ readonly line: string | null; readonly error?: string }>({ line: null });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const make = () =>
      void session.call("machine_join", {}).then((out) => {
        if (stopped) return;
        if (!out.ok) return setJoin({ line: null, error: errorWords(out.error) });
        const minted = out.output as MachineJoinOutput;
        setJoin({ line: minted.line });
        // The next line a few seconds before this one's code runs out, so the one on show always works.
        timer = setTimeout(make, Math.max(5_000, Date.parse(minted.expiresAt) - Date.now() - 5_000));
      });
    make();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [session]);
  const tailnet = useRead(() => session.call("tailnet_get", {}), [session]);
  const ts = tailnet.value?.ok === true ? (tailnet.value.output as TailnetState) : undefined;
  // The person signs in on Tailscale's page: its state is read again until it isn't waiting on them.
  const waitingOn = tailnetWaits(ts);
  const reread = tailnet.reload;
  useEffect(() => {
    if (!waitingOn) return;
    const timer = setInterval(reread, 2_000);
    return () => clearInterval(timer);
  }, [waitingOn, reread]);
  const { line } = join;
  return (
    <>
      <ListSection header="Your Own Machine · Free" footer="Run it in a terminal on a Mac or Linux computer of yours. It installs fleetd and joins this workspace.">
        {line === null ? (
          <ListRow title={join.error === undefined ? "Making a line…" : "No line yet"} {...(join.error === undefined ? {} : { detail: join.error, detailColor: t.danger })} chevron={false} />
        ) : (
          <View style={styles.line}>
            <Text style={[styles.code, { color: t.label }]} selectable>
              {line}
            </Text>
          </View>
        )}
        {line === null ? null : (
          <ListRow
            title="Copy"
            icon="copy"
            onPress={() => {
              haptics.success();
              void Clipboard.setStringAsync(line);
            }}
            chevron={false}
          />
        )}
        {line === null ? null : <ListRow title="Share…" icon="share" onPress={() => void Share.share({ message: line })} chevron={false} />}
        {line === null ? null : (
          <View style={styles.waiting}>
            <ActivityIndicator size="small" color={t.secondary} />
            <Text style={[type.subhead, { color: t.secondary }]}>Waiting for it to connect</Text>
          </View>
        )}
      </ListSection>
      {computers === null ? null : (
        <ListSection header="fleetd's Computers">
          <ListRow title={computers.title} detail={computers.message ?? "fleetd starts a computer for each bot while its agents work."} {...(computers.message === undefined ? {} : { detailColor: t.warning })} onPress={onBilling} />
        </ListSection>
      )}
      {ts === undefined || (ts.status === "off" && ts.problem !== undefined) ? null : (
        <ListSection footer="Machine or services on a tailnet? Connect Tailscale, before or while the computer joins.">
          <TailscaleRow state={ts} admin={state.admin === true} reload={tailnet.reload} />
        </ListSection>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 96 },
  wrap: { paddingTop: space.xl },
  head: { alignItems: "center", gap: space.sm, paddingHorizontal: space.xxl, paddingBottom: space.lg },
  disc: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
  center: { textAlign: "center" },
  line: { paddingHorizontal: space.lg, paddingVertical: space.md },
  code: { fontFamily: mono, fontSize: 13, lineHeight: 19 },
  waiting: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
});
