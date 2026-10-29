// Approvals: every open one, oldest first (the one a tapped notification named on top), each a card to answer. An
// answered card fades where it stood and the rest close up; a new one rises in (ui/motion.ts). Pulling down reads
// them again.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMemo, useRef } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { isNavi } from "../desktop";
import { useHub, type ApprovalsParams } from "../hubContext";
import { approvals } from "../lists";
import { keyOf } from "../store";
import { space, useTheme } from "../theme";
import { Card } from "../ui/Card";
import { SkeletonBlock } from "../ui/Skeleton";
import { haptics } from "../ui/haptics";
import { rowIn, rowMove, rowOut, useReduceMotion } from "../ui/motion";
import { ConnectionBanner, EmptyState } from "../ui/States";
import { ApprovalCard } from "./ApprovalCard";
import { useRefreshing } from "./refresh";

export function Approvals({ route }: NativeStackScreenProps<ApprovalsParams, "Approvals">) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const { state, session, pairAgain } = useHub();
  const refreshing = useRefreshing(state.requests, state.hub.phase);
  const focus = route.params?.focus;
  const listed = approvals(state.requests);
  const open = [...listed.filter((r) => r.requestId === focus), ...listed.filter((r) => r.requestId !== focus)];
  // Asked while the list was on screen: rises in. What it opened with shows still.
  const known = useRef<ReadonlySet<string> | null>(null);
  const ids = open.map((r) => r.requestId).join("\n");
  const fresh = useMemo(() => {
    const now = new Set(ids === "" ? [] : ids.split("\n"));
    const out = known.current === null ? new Set<string>() : new Set([...now].filter((id) => !known.current?.has(id)));
    if (state.requests !== undefined) known.current = now;
    return out;
  }, [ids, state.requests]);
  const empty =
    state.requests === undefined && state.hub.phase === "live" ? (
      <View style={styles.cards}>
        {[0, 1].map((i) => (
          <Card key={i} on="grouped">
            <View style={styles.skeletonHead}>
              <SkeletonBlock width={40} height={40} radius={20} />
              <View style={styles.skeletonLines}>
                <SkeletonBlock width="40%" height={14} />
                <SkeletonBlock width="70%" height={12} />
              </View>
            </View>
            <SkeletonBlock width="90%" height={12} />
            <SkeletonBlock width="60%" height={12} />
            <View style={styles.skeletonHead}>
              <SkeletonBlock width="48%" height={50} radius={14} />
              <SkeletonBlock width="48%" height={50} radius={14} />
            </View>
          </Card>
        ))}
      </View>
    ) : state.requests === undefined ? (
      <EmptyState icon="offline" title="Not Connected" body="The approvals show once the hub is back." />
    ) : (
      <EmptyState icon="doneAll" title="All Caught Up" body="When a Navi or a lead asks before it acts, it shows up here." />
    );
  return (
    <Animated.FlatList
      data={open}
      {...(reduce ? {} : { itemLayoutAnimation: rowMove })}
      keyExtractor={(r) => r.requestId}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.cards, { paddingBottom: space.lg, flexGrow: 1 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing.on}
          onRefresh={() => {
            haptics.tap();
            refreshing.start(() => session.refresh());
          }}
          tintColor={t.secondary}
        />
      }
      ListHeaderComponent={<ConnectionBanner state={state.hub} onPairAgain={pairAgain} />}
      ListEmptyComponent={empty}
      renderItem={({ item }) => {
        const project = state.projects?.[keyOf(item.projectRef)];
        return (
          <Animated.View {...(fresh.has(item.requestId) ? { entering: rowIn(reduce) } : {})} exiting={rowOut}>
          <ApprovalCard
            request={item}
            projectTitle={project?.title}
            navi={project !== undefined && isNavi(project)}
            answering={state.answering[item.requestId] === true}
            error={state.answerErrors[item.requestId]}
            onAnswer={(d) => void session.answer(item.requestId, d)}
            on="grouped"
          />
          </Animated.View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  cards: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.lg },
  skeletonHead: { flexDirection: "row", alignItems: "center", gap: space.md, justifyContent: "space-between" },
  skeletonLines: { flex: 1, gap: space.sm },
});
