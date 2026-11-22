// New Screen, a sheet from a project's Info: a screen of the person's own, as the desktop's picker opens one
// (screen_open). A browser unless they pick another kind; a kind no machine can host says why in its row, and picked,
// says why in full with its fix: a member's who to ask, an admin's where on the desktop (Settings › Hub › Machines, or
// Updates for an update). There is no switch per kind to turn on (D574). The machine, when
// more than one can (its browser is only its own machine's, on the profile that keeps its sign-ins), each with its
// slots in words. Open puts them in its live view, in control, with End Screen; a full machine offers Wait for a Slot,
// which this sheet follows until the screen opens (or Cancel gives it up). A PR's build is the desktop's.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, ScrollView, StyleSheet, Text, View } from "react-native";
import { adminNames, askLine, hostsFor, kindLine, openWord, pickHost, profileBusy, SCREEN_KINDS, slotLine, whyOff, type HubError, type OffReason, type ScreenKind } from "../../desktop";
import { useHub, type RootParams } from "../../hubContext";
import { waitLine, waitOutcome, type Wait } from "../../screen";
import { refOf } from "../../store";
import { space, type, useTheme } from "../../theme";
import { useAnnounce } from "../../ui/announce";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { SHEET_GONE_MS } from "./arrival";
import { CheckRow, errorWords, Problem, sheetOptions, useRead } from "./parts";

export function NewScreen({ navigation, route }: NativeStackScreenProps<RootParams, "NewScreen">) {
  const t = useTheme();
  const { session, state } = useHub();
  const key = route.params.key;
  const roles = useRead(() => session.call("machine_roles", {}), [session]);
  const machines = roles.value?.ok === true ? roles.value.output.machines : [];
  // Its own browser opens on its machine, on the profile that keeps its sign-ins.
  const home = refOf(key).machineId;
  // The browser's row says which profile it opens on: the bot's, signed in, or a fresh one while that one is in use.
  const busyProfile = profileBusy(state.screens[key] ?? [], home);
  const [kind, setKind] = useState<ScreenKind>("browser");
  const shownKind = kind;
  const off = whyOff(machines, shownKind, home);
  const people = useRead(() => session.call("people_list", {}), [session]);
  const admins = people.value?.ok === true ? adminNames(people.value.output.people) : [];
  const [picked, setPicked] = useState<string | null>(null);
  const hosts = hostsFor(machines, shownKind, home);
  const host = pickHost(hosts, picked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const [wait, setWait] = useState<{ readonly wait: Wait; readonly since: string; readonly machine: string } | null>(null);
  useAnnounce(wait === null ? undefined : waitLine(wait.wait, wait.machine));

  // Opened: the sheet goes, then the live view comes (dismissing and presenting in one step crashes UIKit).
  const opened = useRef(false);
  const open = (sessionId: string) => {
    if (opened.current) return;
    opened.current = true;
    haptics.success();
    void session.readScreens(key);
    Keyboard.dismiss();
    navigation.goBack();
    setTimeout(() => navigation.navigate("Screen", { key, sessionId }), SHEET_GONE_MS);
  };

  const start = async () => {
    if (busy || host === undefined) return;
    setBusy(true);
    setError(null);
    const since = new Date().toISOString();
    const r = await session.call("screen_open", { projectRef: refOf(key), kind: shownKind, machineId: host.machineId, ...(host.full ? { wait: true } : {}) }, 120_000);
    setBusy(false);
    if (!r.ok) {
      haptics.warning();
      return setError(r.error);
    }
    if (r.output.session !== undefined) return open(r.output.session.sessionId);
    const w = r.output.waiting;
    if (w !== undefined) setWait({ wait: { waitId: w.waitId, stage: w.stage, ahead: w.ahead, ...(w.threadId === undefined ? {} : { threadId: w.threadId }) }, since, machine: host.name });
  };

  // A wait, followed: each move of a wait or a screen reads the project's screens again.
  useEffect(() => {
    if (wait === null) return;
    const check = async () => {
      const r = await session.call("browser_sessions", { projectRef: refOf(key), limit: 20 });
      if (!r.ok) return;
      const out = waitOutcome(r.output, wait.wait, wait.since);
      if (out.t === "opened") open(out.sessionId);
      else if (out.t === "failed") {
        setWait(null);
        setError({ code: "failed", message: out.error });
      } else if (out.t === "waiting" && (out.wait.ahead !== wait.wait.ahead || out.wait.stage !== wait.wait.stage || out.wait.threadId !== wait.wait.threadId)) {
        setWait({ ...wait, wait: { ...wait.wait, ...out.wait } });
      }
    };
    return session.onEvent((e) => {
      if (e.type === "screen.wait" || e.type === "browser.session") void check();
    });
  });

  // Cancel gives a wait up on the hub; else it just closes.
  const cancel = () => {
    if (wait !== null) void session.call("screen_end", { waitId: wait.wait.waitId });
    navigation.goBack();
  };
  const label = wait !== null ? "Waiting" : openWord(host) === "Wait for a slot" ? "Wait" : "Open";
  useLayoutEffect(() => {
    navigation.setOptions(sheetOptions(t, cancel, { label, enabled: host !== undefined && host.online && wait === null, busy: busy || wait !== null, onPress: () => void start() }, true));
    // `start` and `cancel` read what these are.
  }, [navigation, t, busy, host?.machineId, host?.full, host?.online, shownKind, wait, label]);

  const reading = roles.value === undefined;
  const failed = roles.value?.ok === false ? roles.value.error : undefined;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }} style={{ backgroundColor: t.grouped }}>
      {reading ? (
        <ActivityIndicator style={styles.loading} color={t.secondary} />
      ) : failed !== undefined ? (
        <Text style={[type.footnote, styles.none, { color: t.secondary }]}>{errorWords(failed)}</Text>
      ) : (
        <>
          <ListSection header="Kind">
            {SCREEN_KINDS.map((k) => {
              const kindOff = whyOff(machines, k.kind, home);
              return (
                <CheckRow
                  key={k.kind}
                  title={k.label}
                  detail={kindOff === null ? kindLine(k, busyProfile) : kindOff.short}
                  checked={k.kind === shownKind}
                  disabled={busy || wait !== null}
                  onPress={() => {
                    haptics.select();
                    setKind(k.kind);
                  }}
                />
              );
            })}
          </ListSection>
          {off !== null ? (
            <ListSection header="Can't open" {...offFooter(off, state.admin === true, askLine(off, shownKind, admins))}>
              <ListRow title={off.short} detail={off.why} />
            </ListSection>
          ) : (
            <ListSection header="Machine">
              {hosts.map((h) => (
                <CheckRow
                  key={h.machineId}
                  title={h.name}
                  detail={slotLine(h)}
                  checked={h.machineId === host?.machineId}
                  disabled={busy || wait !== null || !h.online}
                  onPress={() => {
                    haptics.select();
                    setPicked(h.machineId);
                  }}
                />
              ))}
            </ListSection>
          )}
        </>
      )}
      {wait === null ? null : (
        <View style={styles.waiting} accessibilityLiveRegion="polite">
          <ActivityIndicator color={t.secondary} />
          <Text style={[type.footnote, styles.waitText, { color: t.secondary }]}>{`${waitLine(wait.wait, wait.machine)} It opens here as soon as it can; Cancel gives up your place.`}</Text>
        </View>
      )}
      <Problem text={error === null ? undefined : errorWords(error)} />
    </ScrollView>
  );
}

/** Under why a kind can't open: a member's who to ask, or where an admin fixes it. */
const offFooter = (off: OffReason, admin: boolean, ask: string | null): { footer?: string } => {
  if (!admin) return ask === null ? {} : { footer: ask };
  if (off.fix === "none") return {};
  return { footer: `Fix it in the desktop app, under Settings › Hub › ${off.fix === "update" ? "Updates" : "Machines"}.` };
};

const styles = StyleSheet.create({
  loading: { marginTop: 48 },
  none: { marginHorizontal: space.xl, marginTop: space.xl, textAlign: "center" },
  waiting: { flexDirection: "row", alignItems: "center", gap: space.md, marginHorizontal: space.xl, marginTop: space.md },
  waitText: { flex: 1 },
});
