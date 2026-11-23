// Settings › Billing on a fleetd cloud team, for its owners and admins (billing.ts), as the desktop's Hub › Billing
// has it: one line at the top when something needs the team (a declined card, no credits, the cap reached) with the
// one row that fixes it; the plan and when it renews or ends, Choose a Plan or Change Plan; the credits left and the
// soonest that lapse within 30 days, Add Credits; Manage Payment; the computer time used this period by size; and the
// monthly spend cap, set in a prompt. Stripe's checkout and portal open in the browser sheet, and the screen reads
// again when it closes. Before fleetd's computers are on for the team there is no Billing (Settings lists no row), and
// a screen opened just as they went off goes back.
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, AppState, Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  billingOn,
  billingPage,
  buys,
  capFromInput,
  capLine,
  capToInput,
  dayWord,
  expiringSoon,
  failureWords,
  FIX_TITLE,
  hours,
  money,
  noBuyWhy,
  planChoice,
  readTeamBilling,
  setTeamCap,
  sizeWord,
  topLine,
  usageRows,
  periodWord,
  type BillingBuy,
  type BillingState,
  type Got,
} from "../billing";
import { useHub } from "../hubContext";
import { space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { pick } from "./Machines";
import { Problem } from "./manage/parts";

export function Billing() {
  const t = useTheme();
  const { paired } = useHub();
  const navigation = useNavigation();
  const [read, setRead] = useState<Got<BillingState> | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const load = useCallback(async () => {
    setRead(await readTeamBilling(paired));
  }, [paired]);
  // Read on each visit: a checkout finished in the browser shows when the person comes back.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const refresh = () => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  };

  // Stripe's page is away from the app: iOS's browser sheet returns once it closes, Android's Custom Tab as it opens
  // ("opened"), so there the app coming back to the front is the return, and the screen reads again then (as
  // manage/Named.tsx does for a sign-in page).
  const away = useRef(false);
  const back = useCallback(async () => {
    away.current = false;
    await load();
  }, [load]);
  const returned = useEffectEvent(() => {
    if (away.current) void back();
  });
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") returned();
    });
    return () => sub.remove();
  }, []);

  /** Stripe's page for `what` in the browser; the screen reads again once the person is back from it. */
  const open = (what: "portal" | BillingBuy, label: string) => {
    setBusy(label);
    setProblem(undefined);
    void billingPage(paired, what)
      .then(async (page) => {
        if (!page.ok) return setProblem(failureWords(page.failure));
        haptics.select();
        away.current = true;
        const shown = await WebBrowser.openBrowserAsync(page.value);
        if (shown.type !== "opened") await back();
      })
      .finally(() => setBusy(null));
  };

  // Nothing to show until fleetd's computers are on for the team: back to Settings, never a screen that only says so.
  const off = read?.ok === true && !billingOn(read.value);
  useEffect(() => {
    if (off && navigation.canGoBack()) navigation.goBack();
  }, [off, navigation]);

  if (read === undefined || off) return <ActivityIndicator style={styles.loading} />;
  const scroll = (children: ReactNode) => (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      {children}
    </ScrollView>
  );
  if (!read.ok) {
    return scroll(
      <>
        <ListSection>
          <ListRow title="Try Again" onPress={refresh} chevron={false} />
        </ListSection>
        <Problem text={`Couldn't read billing: ${failureWords(read.failure)}`} />
      </>,
    );
  }
  const state = read.value;
  const nowMs = Date.now();
  const top = topLine(state);
  const can = buys(state);
  const why = noBuyWhy(state);
  const label = (l: string) => (busy === l ? "Opening…" : l);
  const tap = (go: () => void) => (busy === null ? { onPress: go } : {});
  const choosePlan = () =>
    pick(
      "Choose a Plan",
      state.plans.map((p) => `${p.name} · ${planChoice(p, state.currency)}`),
      (i) => {
        const p = state.plans[i];
        if (p !== undefined) open({ plan: p.key }, "Choose a Plan");
      },
    );
  const addCredits = () =>
    pick(
      "Add Credits",
      state.topUps.map((u) => money(u.creditsCents, state.currency)),
      (i) => {
        const u = state.topUps[i];
        if (u !== undefined) open({ topUp: u.key }, "Add Credits");
      },
    );
  const capPrompt = () => {
    const save = (typed: string | undefined) => {
      const cents = capFromInput(typed ?? "");
      if (cents === undefined) return setProblem("The cap is a dollar amount, like 50 or 12.50.");
      setBusy("cap");
      setProblem(undefined);
      void setTeamCap(paired, cents)
        .then(async (out) => {
          if (!out.ok) return setProblem(failureWords(out.failure));
          haptics.success();
          await load();
        })
        .finally(() => setBusy(null));
    };
    if (Platform.OS === "ios") {
      Alert.prompt(
        "Monthly Cap",
        "Bots on fleetd's computers stop when this month's spend reaches it.",
        [
          { text: "Cancel", style: "cancel" },
          ...(state.credits.capCents === null ? [] : [{ text: "No Cap", style: "destructive" as const, onPress: () => save("") }]),
          { text: "Save", onPress: save },
        ],
        "plain-text",
        capToInput(state.credits.capCents),
        "decimal-pad",
      );
    } else {
      Alert.alert("Monthly Cap", "Set the cap on the desktop app or the web app.");
    }
  };
  const fixRow =
    top === null || top.fix === null || !can ? null : (
      <ListRow
        title={label(FIX_TITLE[top.fix])}
        {...tap(top.fix === "portal" ? () => open("portal", FIX_TITLE.portal) : top.fix === "buy" ? addCredits : capPrompt)}
        chevron={false}
      />
    );
  const soon = expiringSoon(state, nowMs);
  const rows = usageRows(state);
  const paidBefore = state.plan !== null || state.credits.leftCents !== 0 || state.credits.expiring !== null || state.held === "empty";
  const plan = state.plan;
  const ends = plan === null ? null : (plan.periodEnd ?? plan.paidThrough);
  return scroll(
    <>
      {top === null ? null : (
        <ListSection>
          <Line text={top.message} color={top.tone === "danger" ? t.danger : t.secondary} />
          {fixRow}
        </ListSection>
      )}
      <ListSection header="Plan" {...(why === null ? {} : { footer: why })}>
        <ListRow title={state.plan?.name ?? "No Plan"} value={state.plan === null ? undefined : `${money(state.plan.priceCents, state.currency)} a month`} />
        {plan === null || ends === null ? null : <ListRow title={plan.renews ? "Renews" : "Ends"} value={dayWord(ends, nowMs)} />}
        {!can ? null : state.plan === null ? (
          <ListRow title={label("Choose a Plan")} {...tap(choosePlan)} chevron={false} />
        ) : (
          <ListRow title={label("Change Plan")} {...tap(() => open("portal", "Change Plan"))} chevron={false} />
        )}
      </ListSection>
      <ListSection header="Credits">
        <ListRow title="Left" value={money(state.credits.leftCents, state.currency)} {...(state.credits.leftCents <= 0 ? { valueColor: t.danger } : {})} />
        {soon === null ? null : <ListRow title={`Expire ${dayWord(soon.at, nowMs)}`} value={money(soon.cents, state.currency)} />}
        {!can ? null : <ListRow title={label("Add Credits")} {...tap(addCredits)} chevron={false} />}
        {!can || !paidBefore ? null : <ListRow title={label("Manage Payment")} {...tap(() => open("portal", "Manage Payment"))} chevron={false} />}
      </ListSection>
      <ListSection header={`Computer Time · ${periodWord(state, nowMs)}`}>
        {rows.length === 0 ? <ListRow title="None used yet" /> : null}
        {rows.map((r) => (
          <ListRow key={`${String(r.cpu)}/${String(r.memGb)}`} title={sizeWord(r)} value={`${hours(r.seconds)} · ${money(r.cents, state.currency)}`} />
        ))}
        {rows.length > 1 ? <ListRow title="All" value={`${hours(state.usage.seconds)} · ${money(state.usage.cents, state.currency)}`} /> : null}
      </ListSection>
      <ListSection header="Spend Cap">
        <ListRow
          title={busy === "cap" ? "Saving…" : "Monthly Cap"}
          {...(capLine(state) === null ? {} : { detail: capLine(state) ?? undefined })}
          value={state.credits.capCents === null ? "None" : money(state.credits.capCents, state.currency)}
          {...(state.canBuy && busy === null ? { onPress: capPrompt } : {})}
        />
      </ListSection>
      <Problem text={problem} />
    </>,
  );
}

/** The top line: the words alone, in a row of their own. */
function Line({ text, color }: { text: string; color: string }) {
  return (
    <View style={styles.line} accessibilityRole="text">
      <Text style={[type.body, { color }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  line: { paddingHorizontal: space.lg, paddingVertical: 12 },
});
