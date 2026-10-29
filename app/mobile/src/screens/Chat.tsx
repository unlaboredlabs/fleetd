// One Navi's or project's chat, as iMessage draws one: newest at the bottom, older pages as you scroll up, the
// person's bubbles on the right and the lead's on the left, grouped by burst with time lines between, the lead's text
// as it streams and a typing bubble while it works, blocks and approvals as cards inline, and the composer over the
// keyboard. Messages written offline wait and go when the hub is back.
import { useHeaderHeight } from "@react-navigation/elements";
import type { NativeStackNavigationOptions, NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, FlatList, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { bubbles, sendNote, threadRows, timeLine, type Bubble as BubbleData, type ThreadRow } from "../chatView";
import { chatItems, emptyChat, isNavi, type ChatItem } from "../desktop";
import { useHub, type RootParams } from "../hubContext";
import type { Key } from "../store";
import { space, type, useTheme, type Palette } from "../theme";
import { Avatar } from "../ui/Avatar";
import { Bubble } from "../ui/Bubble";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Composer } from "../ui/Composer";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { Grid, Markdown } from "../ui/Markdown";
import { SkeletonThread } from "../ui/Skeleton";
import { connectionWords } from "../ui/States";
import { ApprovalCard } from "./ApprovalCard";
import { useNow } from "./time";

export const chatOptions = (t: Palette): NativeStackNavigationOptions => ({
  headerBackButtonDisplayMode: "minimal",
  headerTintColor: t.accent,
  headerTitleAlign: "center",
  ...(Platform.OS === "ios" ? { headerTransparent: true, headerBlurEffect: "systemChromeMaterial" } : { headerStyle: { backgroundColor: t.bg } }),
});

/** Whether the keyboard is up: the composer then sits on it, not on the home indicator's inset. */
const useKeyboardUp = (): boolean => {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setUp(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return up;
};

export function Chat({ navigation, route }: NativeStackScreenProps<RootParams, "Chat">) {
  const t = useTheme();
  const { state, session } = useHub();
  const chatKey = route.params.key;
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const keyboardUp = useKeyboardUp();
  const project = state.projects?.[chatKey];
  const chatState = state.chatStates[chatKey];
  const chat = state.chats[chatKey] ?? emptyChat;
  const sends = state.sends[chatKey];
  const items = useMemo(() => chatItems(chat, sends ?? []), [chat, sends]);
  const working = chatState?.leadWorking === true;
  const rows = useMemo(() => threadRows(items, working), [items, working]);
  const newestFirst = useMemo(() => [...rows].reverse(), [rows]);
  // An ask's buttons answer only while nothing of yours came after it.
  const lastHuman = items.findLastIndex((i) => i.author === "human");
  const index = useMemo(() => new Map(items.map((i, n) => [i.id, n])), [items]);

  useEffect(() => {
    session.openChat(chatKey);
    return () => session.openChat(null);
  }, [session, chatKey]);

  const title = project?.title ?? "Chat";
  const link = connectionWords(state.hub);
  const status = link?.text ?? (working ? "Working…" : chatState?.needsYou === true ? "Waiting for you" : undefined);
  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => <ChatTitle title={title} navi={project !== undefined && isNavi(project)} status={status} />,
      title,
    });
  }, [navigation, title, project, status]);

  const send = (body: string) => {
    if (body.trim() === "") return;
    session.send(chatKey, body);
  };

  const loading = !chat.loaded && chat.cached !== true;
  const top = Platform.OS === "ios" ? headerHeight : 0;
  return (
    <KeyboardAvoidingView style={[styles.fill, { backgroundColor: t.bg }]} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <FlatList
        inverted
        data={loading && items.length === 0 ? [] : newestFirst}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustKeyboardInsets={false}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        scrollIndicatorInsets={{ top: 0, bottom: top }}
        onEndReached={() => void session.loadOlder(chatKey)}
        ListHeaderComponent={<View style={styles.bottomGap} />}
        // The list is upside down: its footer is the top, under the translucent header.
        ListFooterComponent={
          <View style={{ paddingTop: top }}>
            {loading && items.length === 0 ? <SkeletonThread /> : chat.loadingOlder ? <ActivityIndicator style={styles.older} color={t.secondary} /> : null}
          </View>
        }
        renderItem={({ item: row }) => <RowView row={row} chatKey={chatKey} canAnswer={row.t === "item" && (index.get(row.id) ?? -1) > lastHuman} onAnswer={send} />}
      />
      {chat.error === undefined ? null : <Text style={[type.footnote, styles.error, { color: t.danger }]}>{chat.error.message}</Text>}
      <Composer onSend={send} bottomInset={keyboardUp ? 0 : insets.bottom} />
    </KeyboardAvoidingView>
  );
}

function ChatTitle({ title, navi, status }: { title: string; navi: boolean; status: string | undefined }) {
  const t = useTheme();
  return (
    <View style={styles.title} accessible accessibilityRole="header" accessibilityLabel={status === undefined ? title : `${title}, ${status}`}>
      <Avatar name={title} navi={navi} size={30} />
      <View style={styles.titleText}>
        <Text style={[type.headline, { color: t.label }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {title}
        </Text>
        {status === undefined ? null : (
          <Text style={[type.caption2, { color: t.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {status}
          </Text>
        )}
      </View>
    </View>
  );
}

function RowView({ row, chatKey, canAnswer, onAnswer }: { row: ThreadRow; chatKey: Key; canAnswer: boolean; onAnswer: (text: string) => void }) {
  const t = useTheme();
  const now = useNow();
  if (row.t === "time") {
    const [day, ...rest] = timeLine(row.at, now).split(" ");
    return (
      <Text style={[type.caption, styles.time, { color: t.secondary }]}>
        <Text style={styles.strong}>{day}</Text> {rest.join(" ")}
      </Text>
    );
  }
  if (row.t === "typing") {
    return (
      <View style={[styles.them, styles.groupGap]}>
        <Bubble side="them" tail>
          <TypingDots />
        </Bubble>
      </View>
    );
  }
  return <ItemView item={row.item} side={row.side} first={row.first} last={row.last} chatKey={chatKey} canAnswer={canAnswer} onAnswer={onAnswer} />;
}

function ItemView({
  item,
  side,
  first,
  last,
  chatKey,
  canAnswer,
  onAnswer,
}: {
  item: ChatItem;
  side: "me" | "them" | "center";
  first: boolean;
  last: boolean;
  chatKey: Key;
  canAnswer: boolean;
  onAnswer: (text: string) => void;
}) {
  const t = useTheme();
  const { state, session } = useHub();
  const gap = first ? styles.groupGap : styles.tightGap;
  const inline = item.message?.item;
  if (inline?.kind === "command_approval") {
    const open = state.requests?.find((r) => r.requestId === inline.requestId);
    if (open !== undefined) {
      const project = state.projects?.[chatKey];
      return (
        <View style={[styles.card, styles.groupGap]}>
          <ApprovalCard
            request={open}
            projectTitle={project?.title}
            navi={project !== undefined && isNavi(project)}
            answering={state.answering[open.requestId] === true}
            error={state.answerErrors[open.requestId]}
            onAnswer={(d) => void session.answer(open.requestId, d)}
          />
        </View>
      );
    }
    return <Event text={`Approval ${inline.state === "open" ? "waiting" : inline.state}`} icon="approvals" />;
  }
  if (inline?.kind === "secret_request") return <Event text="Asks for a secret: enter it in the desktop app." icon="lock" />;
  if (side === "center") return <Event text={item.text} />;

  if (side === "me") {
    const note = sendNote(item);
    const retry = item.state === "failed" || item.state === "unanswered";
    return (
      <Pressable
        disabled={!retry}
        onPress={() => {
          haptics.tap();
          session.resend(chatKey, item.id);
        }}
        accessibilityRole={retry ? "button" : undefined}
        accessibilityHint={retry ? "Sends it again" : undefined}
        style={[styles.me, gap]}
      >
        <View style={styles.mineRow}>
          <View style={[styles.mineBubble, item.state === "pending" && styles.pending]}>
            <Bubble side="me" tail={last}>
              <Markdown text={item.text} ink={t.onAccent} onAccent />
            </Bubble>
          </View>
          {retry ? <Icon name="error" size={22} color={t.danger} /> : null}
        </View>
        {note === undefined ? null : <Text style={[type.caption, styles.note, { color: retry ? t.danger : t.secondary }]}>{note}</Text>}
      </Pressable>
    );
  }

  const parts = bubbles(item);
  const streaming = item.state === "streaming";
  return (
    <View style={[styles.them, gap]}>
      {first && item.author === "agent" ? <Text style={[type.caption, styles.by, { color: t.secondary }]}>{item.message?.by ?? "Agent"}</Text> : null}
      {parts.length === 0 && streaming ? (
        <Bubble side="them" tail={last}>
          <TypingDots />
        </Bubble>
      ) : null}
      {parts.map((b, i) => (
        <BubbleView key={i} bubble={b} tail={last && i === parts.length - 1} canAnswer={canAnswer} onAnswer={onAnswer} />
      ))}
    </View>
  );
}

function BubbleView({ bubble, tail, canAnswer, onAnswer }: { bubble: BubbleData; tail: boolean; canAnswer: boolean; onAnswer: (text: string) => void }) {
  const t = useTheme();
  switch (bubble.kind) {
    case "text":
      return (
        <Bubble side="them" tail={tail}>
          <Markdown text={bubble.text} ink={t.label} />
        </Bubble>
      );
    case "ask":
      return (
        <View style={styles.ask}>
          <Bubble side="them" tail={tail && !canAnswer}>
            <Markdown text={bubble.question} ink={t.label} />
          </Bubble>
          {canAnswer ? (
            <View style={styles.options}>
              {bubble.options.map((o) => (
                <Button
                  key={o}
                  label={o}
                  kind="tinted"
                  size="small"
                  onPress={() => {
                    haptics.tap();
                    onAnswer(o);
                  }}
                />
              ))}
            </View>
          ) : null}
        </View>
      );
    case "pr": {
      const url = `https://github.com/${bubble.repo}/pull/${String(bubble.number)}`;
      return (
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url)} style={styles.blockCard}>
          {({ pressed }) => (
            <Card style={[styles.pr, pressed && styles.pressed]}>
              <View style={[styles.prIcon, { backgroundColor: t.success }]}>
                <Icon name="pr" size={18} color="#FFFFFF" weight="semibold" />
              </View>
              <View style={styles.grow}>
                <Text style={[type.subhead, styles.strong, { color: t.label }]} numberOfLines={2}>
                  {bubble.title ?? `Pull request #${String(bubble.number)}`}
                </Text>
                <Text style={[type.footnote, { color: t.secondary }]} numberOfLines={1}>
                  {bubble.repo} #{bubble.number}
                </Text>
              </View>
              <Icon name="external" size={14} color={t.tertiary} weight="semibold" />
            </Card>
          )}
        </Pressable>
      );
    }
    case "checklist": {
      const done = bubble.items.filter((i) => i.done).length;
      return (
        <Card style={styles.blockCard}>
          <View style={styles.cardHead}>
            <Text style={[type.subhead, styles.strong, styles.grow, { color: t.label }]}>{bubble.title ?? "Checklist"}</Text>
            <Text style={[type.footnote, { color: t.secondary }]}>
              {done}/{bubble.items.length}
            </Text>
          </View>
          <View style={styles.checklist}>
            {bubble.items.map((i, n) => (
              <View key={n} style={styles.check} accessible accessibilityLabel={`${i.done ? "Done" : "To do"}: ${i.text}`}>
                <Icon name={i.done ? "check" : "unchecked"} size={20} color={i.done ? t.success : t.tertiary} />
                <Text style={[type.subhead, styles.grow, { color: i.done ? t.secondary : t.label }]}>{i.text}</Text>
              </View>
            ))}
          </View>
        </Card>
      );
    }
    case "table":
      return (
        <Card style={styles.blockCard}>
          {bubble.title === undefined ? null : <Text style={[type.subhead, styles.strong, { color: t.label }]}>{bubble.title}</Text>}
          <Grid header={bubble.columns} rows={bubble.rows} ink={t.label} rule={t.separator} />
        </Card>
      );
    case "block":
      return (
        <Card style={[styles.blockCard, styles.pr]}>
          <Icon name="block" size={18} color={t.secondary} />
          <Text style={[type.subhead, styles.grow, { color: t.secondary }]}>{bubble.text}</Text>
        </Card>
      );
  }
}

function Event({ text, icon }: { text: string; icon?: "approvals" | "lock" }) {
  const t = useTheme();
  return (
    <View style={styles.event}>
      {icon === undefined ? null : <Icon name={icon} size={13} color={t.secondary} />}
      <Text style={[type.footnote, styles.eventText, { color: t.secondary }]}>{text}</Text>
    </View>
  );
}

/** Three dots that rise in turn, as iMessage's typing bubble. */
function TypingDots() {
  const t = useTheme();
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.35))).current;
  useEffect(() => {
    const native = Platform.OS !== "web";
    const loop = Animated.loop(
      Animated.stagger(
        160,
        dots.map((d) => Animated.sequence([Animated.timing(d, { toValue: 1, duration: 300, useNativeDriver: native }), Animated.timing(d, { toValue: 0.35, duration: 300, useNativeDriver: native })])),
      ),
    );
    loop.start();
    return () => loop.stop();
  }, [dots]);
  return (
    <View style={styles.dots} accessibilityLabel="Writing">
      {dots.map((d, i) => (
        <Animated.View key={i} style={[styles.dot, { backgroundColor: t.secondary, opacity: d }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { paddingHorizontal: space.md + 2 },
  bottomGap: { height: space.sm },
  older: { paddingVertical: space.md },
  error: { paddingHorizontal: space.lg, paddingVertical: space.xs, textAlign: "center" },
  title: { flexDirection: "row", alignItems: "center", gap: space.sm, maxWidth: 260 },
  titleText: { flexShrink: 1 },
  time: { textAlign: "center", marginTop: space.lg, marginBottom: space.xs },
  strong: { fontWeight: "600" },
  groupGap: { marginTop: 10 },
  tightGap: { marginTop: 2 },
  me: { alignItems: "flex-end", paddingLeft: 56 },
  mineRow: { flexDirection: "row", alignItems: "center", gap: space.sm, maxWidth: "100%" },
  mineBubble: { flexShrink: 1 },
  pending: { opacity: 0.7 },
  note: { marginTop: 3, marginRight: 4, textAlign: "right" },
  them: { alignItems: "flex-start", paddingRight: 56, gap: 2 },
  by: { marginLeft: space.md, marginBottom: 1 },
  ask: { gap: space.sm, alignItems: "flex-start" },
  options: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  card: { marginHorizontal: -2 },
  blockCard: { alignSelf: "stretch", marginVertical: 2 },
  pr: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md },
  prIcon: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1 },
  pressed: { opacity: 0.7 },
  cardHead: { flexDirection: "row", alignItems: "baseline" },
  checklist: { gap: space.sm },
  check: { flexDirection: "row", alignItems: "center", gap: space.sm },
  event: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, marginVertical: space.sm, paddingHorizontal: space.xl },
  eventText: { textAlign: "center" },
  dots: { flexDirection: "row", gap: 4, paddingVertical: 7, paddingHorizontal: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
