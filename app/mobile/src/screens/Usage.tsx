// Settings › Usage, for the workspace's owners and admins: the desktop's Settings › Workspace › Usage, read-only
// (`workspace_usage`, the desktop's words and figures, shared/usage.ts). The period (7, 30 or 90 days); what runs
// now; the workspace's figures against the period before; orders and merges per day; then a row per person and per
// bot, each opening every figure it has (UsageDetail). On fleetd cloud, computer time and spend join them.
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Line, Path, Text as SvgText } from "react-native-svg";
import type { WorkspaceUsageCounts, WorkspaceUsageOutput } from "../../../desktop/src/shared/contracts";
import { against, change, columnsOf, count, hours, idle, money, onCloud, PERIODS, ticks, wait, type Column, type Period } from "../desktop";
import { useHub, type SettingsParams, type SettingsProps } from "../hubContext";
import { deviceZone } from "../zone";
import { shape, space, type, useTheme, type Palette } from "../theme";
import { ListRow, ListSection } from "../ui/List";
import { errorWords, Problem, useRead } from "./manage/parts";

/** The desktop's chart slots (tokens.css --series-1, -3), light and dark. */
const ORDERS = { light: "#2a78d6", dark: "#3987e5" };
const MERGED = { light: "#1baf7a", dark: "#199e70" };

const roleWords: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function Usage() {
  const t = useTheme();
  const { session } = useHub();
  const navigation = useNavigation<NavigationProp<SettingsParams>>();
  const [days, setDays] = useState<Period>(30);
  const tz = deviceZone().tz ?? "UTC";
  const read = useRead(() => session.call("workspace_usage", { days, tz }), [session, days, tz]);
  const out = read.value?.ok === true ? (read.value.output as WorkspaceUsageOutput) : undefined;
  const failed = read.value !== undefined && !read.value.ok ? errorWords(read.value.error) : undefined;
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      <Periods t={t} days={days} onPick={setDays} />
      {failed === undefined ? null : <Problem text={`Couldn't read usage: ${failed}`} />}
      {out === undefined ? null : <Body t={t} usage={out} days={days} open={(p) => navigation.navigate("UsageDetail", p)} />}
    </ScrollView>
  );
}

function Periods({ t, days, onPick }: { t: Palette; days: Period; onPick: (d: Period) => void }) {
  return (
    <View style={[styles.segmented, { backgroundColor: t.fill }]} accessibilityRole="tablist">
      {PERIODS.map((p) => {
        const on = p === days;
        return (
          <Pressable key={p} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onPick(p)} style={[styles.segment, on && { backgroundColor: t.cell }]}>
            <Text style={[type.subhead, { color: t.label, fontWeight: on ? "600" : "400" }]}>{`${p} days`}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

type Detail = SettingsParams["UsageDetail"];

function Body({ t, usage, days, open }: { t: Palette; usage: WorkspaceUsageOutput; days: Period; open: (d: Detail) => void }) {
  const cloud = onCloud(usage);
  const currency = usage.currency ?? "USD";
  const tot = usage.total;
  const was = usage.previous;
  const vs = (now: number | undefined, prev: number | undefined, better: "up" | "down" | "none", as?: "count" | "share" | "wait") => {
    const c = change(now, prev, better, as);
    return c === undefined ? undefined : { detail: against(c, days), color: c.tone === "success" ? t.success : c.tone === "danger" ? t.danger : undefined };
  };
  const row = (title: string, value: string, d: ReturnType<typeof vs>) => (
    <ListRow key={title} title={title} value={value} {...(d === undefined ? {} : { detail: d.detail, ...(d.color === undefined ? {} : { detailColor: d.color }) })} chevron={false} />
  );
  const { running, queued, waiting } = usage.now;
  const people = usage.members;
  const summary = (c: WorkspaceUsageCounts) => `${count(c.orders)} orders · ${count(c.merged)} merged`;
  const time = (c: WorkspaceUsageCounts) => (cloud ? money(c.spendCents ?? 0, currency) : hours(c.agentMs));
  return (
    <>
      <ListSection header="Now">
        <ListRow title="Agents running" value={count(running)} {...(running > 0 ? { valueDot: t.success } : {})} chevron={false} />
        <ListRow title="Waiting for a slot" value={count(queued)} chevron={false} />
        <ListRow title="Approvals waiting" value={count(waiting)} chevron={false} />
      </ListSection>
      <ListSection header={`Last ${days} days`}>
        {row("Orders started", count(tot.orders), vs(tot.orders, was.orders, "up", "count"))}
        {row("PRs merged", count(tot.merged), vs(tot.merged, was.merged, "up", "count"))}
        {row("Ask to merge", tot.askToMergeMs === undefined ? "—" : wait(tot.askToMergeMs), vs(tot.askToMergeMs, was.askToMergeMs, "down", "wait"))}
        {cloud ? row("Spend", money(tot.spendCents ?? 0, currency), vs(tot.spendCents, was.spendCents, "none")) : null}
        {cloud ? row("Computer time", hours(tot.computerMs ?? 0), vs(tot.computerMs, was.computerMs, "none")) : null}
        {row("Agent hours", hours(tot.agentMs), vs(tot.agentMs, was.agentMs, "none"))}
        {row("Agents run", count(tot.agents), vs(tot.agents, was.agents, "none", "count"))}
        {row("Messages to leads", count(tot.messages), vs(tot.messages, was.messages, "none", "count"))}
        {row("Approvals answered", count(tot.approvals), vs(tot.approvals, was.approvals, "none", "count"))}
        {row("Failed or stopped", count(tot.failed), vs(tot.failed, was.failed, "down", "count"))}
      </ListSection>
      <Chart t={t} usage={usage} />
      <ListSection header="People" footer="A person's orders, agents, hours and merges are those of the orders they started.">
        {people.map((m) => (
          <ListRow
            key={m.person.personId}
            title={m.person.name}
            detail={`${m.removed === true ? "Removed" : (roleWords[m.role] ?? m.role)} · ${summary(m.counts)}`}
            value={time(m.counts)}
            onPress={() => open({ title: m.person.name, counts: m.counts, ...(usage.currency === undefined ? {} : { currency: usage.currency }), days, person: true })}
          />
        ))}
        {!idle(usage.unattributed) ? (
          <ListRow
            key="none"
            title="No one"
            detail={`Automations, lead chats · ${summary(usage.unattributed)}`}
            value={time(usage.unattributed)}
            onPress={() => open({ title: "No one", counts: usage.unattributed, ...(usage.currency === undefined ? {} : { currency: usage.currency }), days, person: true })}
          />
        ) : null}
      </ListSection>
      {usage.bots.length === 0 ? null : (
        <ListSection header="Bots">
          {usage.bots.map((b) => (
            <ListRow
              key={b.projectRef === undefined ? "removed" : `${b.projectRef.machineId}/${b.projectRef.projectId}`}
              title={b.name}
              detail={summary(b.counts)}
              value={time(b.counts)}
              onPress={() => open({ title: b.name, counts: b.counts, ...(usage.currency === undefined ? {} : { currency: usage.currency }), days, person: false })}
            />
          ))}
        </ListSection>
      )}
    </>
  );
}

const PLOT_H = 96;
const LEFT = 28;
const BOTTOM = 18;

/**
 * Orders started beside PRs merged, a column a day (a week past a month), as the desktop's first chart. As wide as its
 * card, measured: the window is wider than the card when Settings sits beside the chats list (an open Duo, an iPad).
 */
function Chart({ t, usage }: { t: Palette; usage: WorkspaceUsageOutput }) {
  const [width, setWidth] = useState(0);
  const columns = useMemo(() => columnsOf(usage.days), [usage.days]);
  const weekly = columns.length < usage.days.length;
  const plotW = width - LEFT;
  const slot = columns.length === 0 ? 0 : plotW / columns.length;
  const bar = Math.max(1.5, Math.min(10, (slot - 3) / 2));
  const max = Math.max(0, ...columns.flatMap((c) => [c.orders, c.merged]));
  const axis = ticks(max);
  const top = axis.at(-1) ?? 1;
  const px = (v: number) => (v / top) * PLOT_H;
  const colors: [string, string] = t.dark ? [ORDERS.dark, MERGED.dark] : [ORDERS.light, MERGED.light];
  const label = (c: Column) => c.label.split(" to ")[0] ?? "";
  const shown = [0, Math.floor((columns.length - 1) / 2), columns.length - 1];
  const rounded = (x: number, h: number) => {
    const r = Math.min(2, bar / 2, h);
    const y = 4 + PLOT_H - h;
    return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + bar - r}Q${x + bar} ${y} ${x + bar} ${y + r}V${y + h}Z`;
  };
  return (
    <View style={styles.chartSection}>
      <Text style={[type.footnote, styles.chartHeader, { color: t.secondary }]} accessibilityRole="header">
        {weekly ? "Orders and merges per week" : "Orders and merges per day"}
      </Text>
      <View style={[styles.chartCard, { backgroundColor: t.cell }]}>
        <View style={styles.legend}>
          {["Orders started", "PRs merged"].map((name, i) => (
            <View key={name} style={styles.key}>
              <View style={[styles.swatch, { backgroundColor: i === 0 ? colors[0] : colors[1] }]} />
              <Text style={[type.caption, { color: t.secondary }]}>{name}</Text>
            </View>
          ))}
        </View>
        <View style={{ height: 4 + PLOT_H + BOTTOM }} onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}>
          {width <= 0 ? null : (
            <Svg width={width} height={4 + PLOT_H + BOTTOM} accessibilityLabel={`${weekly ? "Orders and merges per week" : "Orders and merges per day"}`}>
              {axis.map((v) => (
                <Line key={v} x1={LEFT} x2={width} y1={4 + PLOT_H - px(v)} y2={4 + PLOT_H - px(v)} stroke={t.separator} strokeWidth={v === 0 ? 1 : 0.5} />
              ))}
              {[0, axis.at(-1) ?? 0].map((v) => (
                <SvgText key={`t${v}`} x={LEFT - 6} y={4 + PLOT_H - px(v) + 4} fontSize={11} fill={t.secondary} textAnchor="end">
                  {count(v)}
                </SvgText>
              ))}
              {columns.map((c, i) => {
                const x0 = LEFT + i * slot + (slot - (2 * bar + 1.5)) / 2;
                return [c.orders, c.merged].map((v, j) =>
                  v <= 0 ? null : <Path key={`${c.from}${j}`} d={rounded(x0 + j * (bar + 1.5), Math.max(1, px(v)))} fill={j === 0 ? colors[0] : colors[1]} />,
                );
              })}
              {[...new Set(shown)].map((i) => {
                const c = columns[i];
                if (c === undefined) return null;
                const anchor = i === 0 ? "start" : i === columns.length - 1 ? "end" : "middle";
                const x = i === 0 ? LEFT + i * slot : i === columns.length - 1 ? LEFT + (i + 1) * slot : LEFT + i * slot + slot / 2;
                return (
                  <SvgText key={`x${i}`} x={x} y={4 + PLOT_H + 14} fontSize={11} fill={t.secondary} textAnchor={anchor}>
                    {label(c)}
                  </SvgText>
                );
              })}
            </Svg>
          )}
        </View>
      </View>
    </View>
  );
}

/** One person's or bot's every figure over the period. */
export function UsageDetail({ route }: SettingsProps<"UsageDetail">) {
  const t = useTheme();
  const { counts: c, currency, days, person } = route.params;
  const rows: [string, string][] = [
    ...(person ? ([["Messages to leads", count(c.messages)]] as [string, string][]) : []),
    ["Orders started", count(c.orders)],
    ["Agents run", count(c.agents)],
    ["Agent hours", hours(c.agentMs)],
    ...(c.computerMs === undefined ? [] : ([["Computer time", hours(c.computerMs)]] as [string, string][])),
    ...(c.spendCents === undefined || currency === undefined ? [] : ([["Spend", money(c.spendCents, currency)]] as [string, string][])),
    ["PRs merged", count(c.merged)],
    ["Ask to merge", c.askToMergeMs === undefined ? "—" : wait(c.askToMergeMs)],
    ...(person ? ([["Approvals answered", count(c.approvals)]] as [string, string][]) : []),
    ["Failed or stopped", count(c.failed)],
  ];
  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
      <ListSection header={`Last ${days} days`}>
        {rows.map(([title, value]) => (
          <ListRow key={title} title={title} value={value} chevron={false} />
        ))}
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  segmented: { flexDirection: "row", marginHorizontal: space.lg, marginTop: space.sm, padding: 2, borderRadius: 9 },
  segment: { flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 7 },
  chartSection: { marginTop: space.xl, marginHorizontal: space.lg },
  chartHeader: { paddingHorizontal: space.lg, paddingBottom: 7 },
  chartCard: { borderRadius: shape.group, padding: space.lg, gap: space.sm },
  legend: { flexDirection: "row", gap: space.lg },
  key: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 9, height: 9, borderRadius: 2 },
});
