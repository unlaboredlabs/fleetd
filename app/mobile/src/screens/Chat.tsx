// One Navi's or project's chat, as iOS 26's Messages and Telegram draw one: the thread runs under a glass title and a
// floating glass composer, with soft edges where it meets them. Newest at the bottom, older pages as you scroll up;
// the person's bubbles on the right and the lead's on the left, grouped by burst with time chips between; pictures
// and files inline; the lead's text as it streams and the desktop's turn line while it works; blocks and approvals as
// cards.
//
// Opening it lands on the first message you haven't read, under an "Unread Messages" bar; reading to the bottom marks
// it read. Scrolled up, a glass button takes you back down and counts what came meanwhile. Pressing and holding a
// bubble lifts it with iOS's own menu (ui/HoldMenu.tsx): Reply (quoted above your words), Copy, and Select Text.
// Bubbles that arrive while you look rise in with the desktop's motion (ui/motion.ts). Messages written offline wait
// and go when the hub is back.
//
// Smooth while a reply streams: each row draws again only when its own message changed (chatView.ts sameRow), so a
// streamed word redraws one bubble; the keyboard, the composer on it and the thread above it move together on the UI
// thread (react-native-keyboard-controller), following a finger that drags the keyboard down.
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import { useHeaderHeight } from "@react-navigation/elements";
import type { NativeStackNavigationOptions, NativeStackScreenProps } from "@react-navigation/native-stack";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Linking, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { KeyboardChatScrollView, KeyboardStickyView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { arrivalsOf, ENTER_MS, rowKeyOf, type Arrivals } from "../arrivals";
import { attachmentBubbles, bubbleTime, bubbles, dayLine, fullTime, landingOf, quoteOf, replyOf, replyText, sameRow, sendNote, threadRows, type Bubble as BubbleData, type ThreadRow } from "../chatView";
import { chatItems, emptyChat, isNavi, type AttachmentGetOutput, type AttachmentRef, type ChatItem } from "../desktop";
import { useHub, useSession, type RootParams } from "../hubContext";
import { linkStatus } from "../link";
import { dispatchPrefs, usePrefs } from "../prefsStore";
import type { Key } from "../store";
import { space, type, useTheme, type Palette } from "../theme";
import { upload } from "../upload";
import { Avatar, type Pictured } from "../ui/Avatar";
import { Bubble } from "../ui/Bubble";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Composer, type Reply } from "../ui/Composer";
import { Glass } from "../ui/Glass";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { HoldMenu } from "../ui/HoldMenu";
import { Grid, Markdown } from "../ui/Markdown";
import { FileBubble, ImageBubble, ImageViewer, shareFile } from "../ui/Media";
import type { MenuItem } from "../ui/Menu";
import { bubbleIn, dur, ease, useReduceMotion } from "../ui/motion";
import { SkeletonThread } from "../ui/Skeleton";
import { ApprovalCard } from "./ApprovalCard";
import { TurnLine } from "./TurnLine";
import { useNow } from "./time";

export const chatOptions = (t: Palette): NativeStackNavigationOptions => ({
  headerBackButtonDisplayMode: "minimal",
  headerTintColor: t.label,
  headerTitleAlign: "center",
  // The thread runs under a clear bar, its glass title and back button floating over it, and fades out under them
  // (Chat draws the fade). The list is upside down, so iOS 26's own edge effects would land on the wrong ends: off.
  ...(Platform.OS === "ios" ? { headerTransparent: true, headerShadowVisible: false, scrollEdgeEffects: { top: "hidden", bottom: "hidden" } } : { headerStyle: { backgroundColor: t.bg } }),
});

/** Scrolled up further than this from the newest, the button down shows. */
const AWAY = 280;

/**
 * What a chat's thread does that its rows need: replies, the image viewer, jumping to a message, who wrote one. The
 * same object for as long as the chat is open, so rows that didn't change don't draw again.
 */
interface ThreadActions {
  readonly reply: (target: { readonly id: string; readonly part: number; readonly who: string; readonly quote: string }) => void;
  readonly selectText: (text: string) => void;
  readonly openImage: (image: AttachmentGetOutput) => void;
  readonly jumpTo: (messageId: string) => void;
  /** Whose the message is, as a reply's quote names them: "You", or the chat's lead. */
  readonly whoWrote: (messageId: string) => string;
  readonly answer: (text: string) => void;
}

export function Chat({ navigation, route }: NativeStackScreenProps<RootParams, "Chat">) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const { state, session } = useHub();
  const prefs = usePrefs();
  const chatKey = route.params.key;
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const project = state.projects?.[chatKey];
  const chatState = state.chatStates[chatKey];
  const chat = state.chats[chatKey] ?? emptyChat;
  const sends = state.sends[chatKey];
  const items = useMemo(() => chatItems(chat, sends ?? []), [chat, sends]);
  const working = chatState?.leadWorking === true;
  const live = state.hub.phase === "live";
  // What was read when the chat opened: the unread bar stays there while it's open, as Telegram's does.
  // What was unread is what had come by then: a reply that comes while you look isn't.
  const [readAtOpen] = useState(() => prefs.read[chatKey]);
  const lastAtOpen = useRef<number | undefined>(undefined);
  if (lastAtOpen.current === undefined && chatState !== undefined) lastAtOpen.current = chatState.lastSeq;
  const unreadFrom = readAtOpen !== undefined && (lastAtOpen.current ?? 0) > readAtOpen ? readAtOpen : undefined;
  const rows = useMemo(() => threadRows(items, working, unreadFrom), [items, working, unreadFrom]);
  const newestFirst = useMemo(() => [...rows].reverse(), [rows]);
  // An ask's buttons answer only while nothing of yours came after it.
  const lastHuman = items.findLastIndex((i) => i.author === "human");
  const index = useMemo(() => new Map(items.map((i, n) => [i.id, n])), [items]);
  const navi = project !== undefined && isNavi(project);
  const title = project?.title ?? "Chat";

  // Which bubbles enter with motion: what arrives while the chat is open and live (arrivals.ts).
  const arrivals = useRef<Arrivals | undefined>(undefined);
  const entering = useMemo(() => {
    // Not until its first page is in: what the chat opens with shows still.
    if (!chat.loaded) return new Map<string, { at: number; step: number }>();
    arrivals.current = arrivalsOf(arrivals.current, items, live, Date.now());
    return arrivals.current.entering;
  }, [items, live, chat.loaded]);

  useEffect(() => {
    session.openChat(chatKey);
    return () => session.openChat(null);
  }, [session, chatKey]);

  // Removed elsewhere (the desktop app, another phone) while open: back to the list, as nothing is left to show. A tick
  // later, never in the commit that removed it.
  const gone = state.projects !== undefined && project === undefined;
  useEffect(() => {
    if (!gone) return;
    const timer = setTimeout(() => {
      if (navigation.canGoBack()) navigation.goBack();
    }, 0);
    return () => clearTimeout(timer);
  }, [gone, navigation]);

  const link = linkStatus(state.hub);
  // Always a line under the name, as Telegram's "online": the title never jumps when the lead starts or stops.
  const quiet = project === undefined ? undefined : navi ? "Navi" : `on ${project.machineId}`;
  const status = link?.busy === true ? "Connecting…" : link !== undefined ? "Offline" : working ? "Working…" : chatState?.needsYou === true ? "Waiting for you" : quiet;
  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => <ChatTitle picture={project} title={title} navi={navi} status={status} busy={working && link === undefined} />,
      title,
    });
    // A picture set or removed (here or on another device) draws the header again: its id is all that changes.
  }, [navigation, title, navi, status, working, link, project?.avatar]);

  const list = useRef<FlatList<ThreadRow>>(null);
  const [composerHeight, setComposerHeight] = useState(60);
  const [reply, setReply] = useState<(Reply & { id: string; part: number }) | undefined>(undefined);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [image, setImage] = useState<AttachmentGetOutput | null>(null);
  const [lit, setLit] = useState<string | null>(null);

  // The keyboard covers the home indicator's inset, which the composer keeps clear when it's down: up, the composer
  // sits a step above it, and the thread's newest end is that much less than the keyboard above where it was.
  const lift = Math.max(insets.bottom - space.sm, 0);
  const keyboard = useReanimatedKeyboardAnimation();
  // The list is upside down, its newest end at 0, or under the keyboard's padding (before 0) while it's up.
  const newestEnd = () => -Math.max(0, -keyboard.height.value - lift);
  const toNewest = () => list.current?.scrollToOffset({ offset: newestEnd(), animated: !reduce });

  // Scrolled away from the newest: the seq it was at, so the button down counts what came since.
  const [awayFrom, setAwayFrom] = useState<number | null>(null);
  const newestSeq = items.reduce((n, i) => Math.max(n, i.message?.seq ?? 0), 0);
  const cameSince = awayFrom === null ? 0 : items.filter((i) => i.author !== "human" && i.kind === "message" && (i.message?.seq ?? 0) > awayFrom).length;
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // How far from the newest end, wherever the keyboard puts it.
    const y = e.nativeEvent.contentOffset.y - newestEnd();
    if (y > AWAY && awayFrom === null) setAwayFrom(newestSeq);
    else if (y < AWAY / 3 && awayFrom !== null) setAwayFrom(null);
  };
  // At the newest with the chat open: read.
  const lastSeq = chatState?.lastSeq;
  useEffect(() => {
    if (awayFrom === null && lastSeq !== undefined && chat.loaded) dispatchPrefs({ t: "read", key: chatKey, seq: lastSeq });
  }, [awayFrom, lastSeq, chat.loaded, chatKey]);

  const scrollToRow = (find: (r: ThreadRow) => boolean, viewPosition: number) => {
    const at = newestFirst.findIndex(find);
    if (at < 0) return false;
    list.current?.scrollToIndex({ index: at, animated: !reduce, viewPosition, viewOffset: viewPosition > 0.5 ? headerHeight : composerHeight });
    return true;
  };

  // Opened with unread messages: land on the first of them, under its bar, rather than at the very bottom. Opened at a
  // message (a search hit) or an approval (its notification tapped, again too, while the chat is open): land on it,
  // lit, reading older pages first while the approval's card is further back than them.
  const { messageId, requestId, tap } = route.params;
  const landed = useRef<string | null>(null);
  useEffect(() => {
    const wanted = `${messageId ?? ""} ${requestId ?? ""} ${String(tap ?? 0)}`;
    if (landed.current === wanted || !chat.loaded || newestFirst.length === 0) return;
    const found = landingOf(items, { messageId, requestId }, { hasOlder: chat.hasOlder, failed: chat.error !== undefined });
    if (found === "older") {
      if (!chat.loadingOlder) void session.loadOlder(chatKey);
      return;
    }
    landed.current = wanted;
    const target = found;
    const at = target !== undefined ? newestFirst.findIndex((r) => r.t === "item" && r.item.message?.messageId === target) : newestFirst.findIndex((r) => r.t === "unread");
    // Near the bottom already: nothing to jump to.
    if (at < 6) {
      if (target !== undefined && at >= 0) setLit(target);
      return;
    }
    setTimeout(() => {
      scrollToRow((r) => (target !== undefined ? r.t === "item" && r.item.message?.messageId === target : r.t === "unread"), target !== undefined ? 0.5 : 1);
      if (target !== undefined) setLit(target);
      else if (unreadFrom !== undefined) setAwayFrom(unreadFrom);
    }, 50);
  });
  useEffect(() => {
    if (lit === null) return;
    const timer = setTimeout(() => setLit(null), 1600);
    return () => clearTimeout(timer);
  }, [lit]);


  // What you send shows at once, as in Messages, wherever the thread was scrolled to.
  const send = (body: string, files: readonly AttachmentRef[] = []) => {
    if (body.trim() === "" && files.length === 0) return;
    const text = reply === undefined ? body : replyText(reply.quote, body);
    session.send(chatKey, text, { attachments: files, replyTo: reply === undefined ? undefined : { messageId: reply.id, part: reply.part } });
    setReply(undefined);
    setAwayFrom(null);
    toNewest();
  };

  // What the actions read, as of the last draw.
  const now = useRef({ items, title, send, scrollToRow });
  now.current = { items, title, send, scrollToRow };
  const actions = useMemo(
    (): ThreadActions => ({
      reply: (r) => {
        haptics.tap();
        setReply({ id: r.id, part: r.part, who: r.who, quote: r.quote });
      },
      selectText: setSelecting,
      openImage: setImage,
      jumpTo: (messageId) => {
        if (now.current.scrollToRow((r) => r.t === "item" && r.item.message?.messageId === messageId, 0.5)) setLit(messageId);
      },
      whoWrote: (messageId) => (now.current.items.find((i) => i.id === messageId)?.author === "human" ? "You" : now.current.title),
      answer: (text) => now.current.send(text),
    }),
    [],
  );
  const renderRow = useCallback(
    ({ item: row }: { item: ThreadRow }) => (
      <RowView
        row={row}
        chatKey={chatKey}
        title={title}
        canAnswer={row.t === "item" && (index.get(row.item.id) ?? -1) > lastHuman}
        actions={actions}
        lit={row.t === "item" && row.item.message?.messageId !== undefined && row.item.message.messageId === lit}
        enter={row.t === "item" ? entering.get(rowKeyOf(row.item)) : undefined}
        reduce={reduce}
        still={row.t === "turn" && awayFrom !== null}
      />
    ),
    [chatKey, title, index, lastHuman, actions, lit, entering, reduce, awayFrom],
  );

  const loading = !chat.loaded && chat.cached !== true;
  const top = Platform.OS === "ios" ? headerHeight : 0;
  return (
    <View style={[styles.fill, { backgroundColor: t.thread }]}>
      <View style={styles.fill}>
        <FlatList
          ref={list}
          inverted
          renderScrollComponent={(props) => <KeyboardChatScrollView {...props} inverted offset={lift} />}
          data={loading && items.length === 0 ? [] : newestFirst}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.list}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustKeyboardInsets={false}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          scrollIndicatorInsets={{ top: composerHeight, bottom: top }}
          onScroll={onScroll}
          scrollEventThrottle={64}
          onScrollToIndexFailed={(info) => {
            list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            setTimeout(() => list.current?.scrollToIndex({ index: info.index, animated: false, viewPosition: 0.5 }), 80);
          }}
          onEndReached={() => void session.loadOlder(chatKey)}
          ListHeaderComponent={<View style={{ height: composerHeight + space.xs }} />}
          {...(loading ? {} : { ListEmptyComponent: <EmptyThread picture={project} title={title} navi={navi} onPick={(s) => send(s)} /> })}
          // The list is upside down: its footer is the top, under the clear header.
          ListFooterComponent={
            <View style={{ paddingTop: top + space.sm }}>
              {loading && items.length === 0 ? <SkeletonThread /> : chat.loadingOlder ? <ActivityIndicator style={styles.older} color={t.secondary} /> : null}
            </View>
          }
          renderItem={renderRow}
        />
        {Platform.OS === "ios" ? <LinearGradient pointerEvents="none" colors={[t.thread, withOpacity(t.thread, 0.85), withOpacity(t.thread, 0)]} locations={[0, 0.55, 1]} style={[styles.topFade, { height: top + space.lg }]} /> : null}
        {/* The composer and what sits on it ride on the keyboard. */}
        <KeyboardStickyView offset={{ closed: 0, opened: lift }} style={styles.dock} pointerEvents="box-none">
          {Platform.OS === "ios" ? <LinearGradient pointerEvents="none" colors={[withOpacity(t.thread, 0), withOpacity(t.thread, 0.9)]} style={[styles.bottomFade, { height: composerHeight + space.lg }]} /> : null}
          {chat.error === undefined ? null : <Text style={[type.footnote, styles.error, { color: t.danger, bottom: composerHeight + space.xs }]}>{chat.error.message}</Text>}
          {awayFrom === null ? null : (
            <Animated.View
              entering={FadeIn.duration(reduce ? 0 : dur.quick).easing(ease.snap)}
              exiting={FadeOut.duration(reduce ? 0 : dur.quick).easing(ease.snap)}
              style={[styles.down, { bottom: composerHeight + space.md }]}
            >
              <Glass interactive style={styles.downButton}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={cameSince > 0 ? `Scroll to the newest, ${String(cameSince)} new` : "Scroll to the newest"}
                  style={styles.downHit}
                  onPress={() => {
                    haptics.tap();
                    toNewest();
                  }}
                >
                  <Icon name="down" size={18} color={t.label} weight="semibold" />
                </Pressable>
              </Glass>
              {cameSince > 0 ? (
                <View style={[styles.downCount, { backgroundColor: t.accentFill }]}>
                  <Text style={[type.caption, styles.downCountText]} maxFontSizeMultiplier={1.3}>
                    {cameSince > 99 ? "99+" : String(cameSince)}
                  </Text>
                </View>
              ) : null}
            </Animated.View>
          )}
          <Composer
            onSend={send}
            upload={(bytes, name, mime, progress) => upload((tool, input, timeoutMs) => session.call(tool, input, timeoutMs), bytes, name, mime, progress)}
            bottomInset={insets.bottom}
            reply={reply}
            onCancelReply={() => setReply(undefined)}
            onHeight={setComposerHeight}
          />
        </KeyboardStickyView>
      </View>
      <SelectText text={selecting} onClose={() => setSelecting(null)} />
      <ImageViewer image={image} onClose={() => setImage(null)} />
    </View>
  );
}

const withOpacity = (hex: string, alpha: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String((n >> 16) & 255)},${String((n >> 8) & 255)},${String(n & 255)},${String(alpha)})`;
};

/** A chat with nothing in it yet: who it is, and a few things to say to start. Turned upright: the list is upside down. */
function EmptyThread({ picture, title, navi, onPick }: { picture: Pictured | undefined; title: string; navi: boolean; onPick: (text: string) => void }) {
  const t = useTheme();
  const starters = navi ? ["What's on my calendar today?", "Summarize my unread email", "Remind me what I asked you last"] : ["What are you working on?", "Show me the open pull requests", "What failed in CI?"];
  return (
    <View style={styles.emptyThread}>
      <Avatar name={title} navi={navi} size={88} picture={picture} />
      <Text style={[type.title2, { color: t.label }]}>{title}</Text>
      <Text style={[type.subhead, styles.center, { color: t.secondary }]}>{navi ? "Your Navi. Ask it anything, or start with one of these." : "Tell the lead what to work on, or start with one of these."}</Text>
      <View style={styles.starters}>
        {starters.map((s) => (
          <Pressable
            key={s}
            accessibilityRole="button"
            onPress={() => {
              haptics.tap();
              onPick(s);
            }}
            style={({ pressed }) => [styles.starter, { backgroundColor: t.fillQuiet }, pressed && styles.pressed]}
          >
            <Text style={[type.subhead, { color: t.label }]}>{s}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** The chat's name and how it is, in a glass capsule over the thread, as iOS 26's Telegram. */
function ChatTitle({ picture, title, navi, status, busy }: { picture: Pictured | undefined; title: string; navi: boolean; status: string | undefined; busy: boolean }) {
  const t = useTheme();
  return (
    <Glass style={styles.titleGlass}>
      <View style={styles.title} accessible accessibilityRole="header" accessibilityLabel={status === undefined ? title : `${title}, ${status}`}>
        <Avatar name={title} navi={navi} size={30} picture={picture} />
        <View style={styles.titleText}>
          <Text style={[type.headline, { color: t.label }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {title}
          </Text>
          {status === undefined ? null : (
            <Text style={[type.caption2, { color: busy ? t.accent : t.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
              {status}
            </Text>
          )}
        </View>
      </View>
    </Glass>
  );
}

interface RowProps {
  readonly row: ThreadRow;
  readonly chatKey: Key;
  readonly title: string;
  readonly canAnswer: boolean;
  readonly actions: ThreadActions;
  readonly lit: boolean;
  readonly enter: { at: number; step: number } | undefined;
  readonly reduce: boolean;
  /** The turn line, scrolled away from: it holds still. */
  readonly still: boolean;
}

/** Draws again only when its own row changed: the thread's rows are made anew with each streamed word. */
const sameProps = (a: RowProps, b: RowProps): boolean =>
  a.chatKey === b.chatKey && a.title === b.title && a.canAnswer === b.canAnswer && a.actions === b.actions && a.lit === b.lit && a.enter === b.enter && a.reduce === b.reduce && a.still === b.still && sameRow(a.row, b.row);

const RowView = memo(function RowView({ row, chatKey, title, canAnswer, actions, lit, enter, reduce, still }: RowProps) {
  const t = useTheme();
  const now = useNow();
  // Entering only as it mounts soon after it came: a row scrolled back to later shows still.
  const [motion] = useState(() => (enter !== undefined && Date.now() - enter.at < ENTER_MS ? enter : undefined));
  if (row.t === "day") {
    return (
      <View style={styles.timeRow} accessibilityRole="header">
        <Glass style={styles.timeChip}>
          <Text style={[type.caption, styles.strong, { color: t.secondary }]}>{dayLine(row.at, now)}</Text>
        </Glass>
      </View>
    );
  }
  if (row.t === "unread") {
    return (
      <View style={[styles.unreadBar, { backgroundColor: t.fillQuiet }]} accessibilityRole="header">
        <Text style={[type.footnote, styles.strong, { color: t.secondary }]}>Unread Messages</Text>
      </View>
    );
  }
  if (row.t === "turn") {
    return (
      <Animated.View entering={bubbleIn(false, 0, reduce)}>
        <TurnLine chatKey={chatKey} still={still} />
      </Animated.View>
    );
  }
  const body = <ItemView item={row.item} side={row.side} first={row.first} last={row.last} chatKey={chatKey} title={title} canAnswer={canAnswer} actions={actions} />;
  return (
    <Animated.View
      {...(motion === undefined ? {} : { entering: bubbleIn(row.side === "me", motion.step, reduce) })}
      style={[lit && { backgroundColor: t.accentSoft }, styles.litRow]}
    >
      {body}
    </Animated.View>
  );
}, sameProps);

/** An approval asked in the chat: its card while it's open, then a line saying how it went. */
function InlineApproval({ chatKey, requestId, state: asked }: { chatKey: Key; requestId: string; state: string }) {
  // The hub's state, which a row reads only here: the rest of the thread doesn't draw again with it.
  const { state, session } = useHub();
  const open = state.requests?.find((r) => r.requestId === requestId);
  if (open === undefined) return <Event text={`Approval ${asked === "open" ? "waiting" : asked}`} icon="approvals" />;
  const project = state.projects?.[chatKey];
  return (
    <View style={[styles.card, styles.groupGap]}>
      <ApprovalCard
        request={open}
        projectTitle={project?.title}
        navi={project !== undefined && isNavi(project)}
        picture={project}
        answering={state.answering[open.requestId] === true}
        error={state.answerErrors[open.requestId]}
        onAnswer={(d) => void session.answer(open.requestId, d)}
      />
    </View>
  );
}

function ItemView({
  item,
  side,
  first,
  last,
  chatKey,
  title,
  canAnswer,
  actions,
}: {
  item: ChatItem;
  side: "me" | "them" | "center";
  first: boolean;
  last: boolean;
  chatKey: Key;
  title: string;
  canAnswer: boolean;
  actions: ThreadActions;
}) {
  const t = useTheme();
  const now = useNow();
  const session = useSession();
  const gap = first ? styles.groupGap : styles.tightGap;
  const time = bubbleTime(item.at, now);
  const when = fullTime(item.at, now);
  const inline = item.message?.item;
  if (inline?.kind === "command_approval") return <InlineApproval chatKey={chatKey} requestId={inline.requestId} state={inline.state} />;
  if (inline?.kind === "secret_request") return <Event text="Asks for a secret: enter it in the desktop app." icon="lock" />;
  if (side === "center") return <Event text={item.text} />;

  const messageId = item.message?.messageId;
  const who = item.author === "human" ? "You" : item.author === "agent" ? (item.message?.by ?? "Agent") : title;
  const files = attachmentBubbles(item);

  if (side === "me") {
    const note = sendNote(item);
    const retry = item.state === "failed" || item.state === "unanswered";
    const replied = replyOf(item.text);
    const words = replied?.body ?? item.text;
    const quotedId = item.message?.replyTo?.messageId;
    const quotedWho = quotedId === undefined ? title : actions.whoWrote(quotedId);
    return (
      <View style={[styles.me, gap]}>
        {words.trim() === "" ? null : (
          <View style={styles.mineRow}>
            <View style={[styles.mineBubble, item.state === "pending" && styles.pending]}>
              <HeldBubble
                actions={actions}
                mine
                when={when}
                text={words}
                target={messageId === undefined ? undefined : { id: messageId, part: 0, who }}
                onPress={
                  retry
                    ? () => {
                        haptics.tap();
                        session.resend(chatKey, item.id);
                      }
                    : undefined
                }
                bubble={(tail) => (
                  <Bubble side="me" tail={tail && last && files.length === 0} time={time}>
                    {replied === undefined ? null : <Quote who={quotedWho} quote={replied.quote} onAccent onPress={quotedId === undefined ? undefined : () => actions.jumpTo(quotedId)} />}
                    <Markdown text={words} ink={t.onAccent} onAccent room={time} />
                  </Bubble>
                )}
              />
            </View>
            {retry ? <Icon name="error" size={22} color={t.danger} /> : null}
          </View>
        )}
        {files.map((b, i) => (
          <MediaView key={i} bubble={b} chatKey={chatKey} mine actions={actions} time={time} when={when} target={messageId === undefined ? undefined : { id: messageId, part: 0, who }} />
        ))}
        {note === undefined ? null : <Text style={[type.caption, styles.note, { color: retry ? t.danger : t.secondary }]}>{note}</Text>}
      </View>
    );
  }

  const parts = bubbles(item);
  const streaming = item.state === "streaming";
  // Nothing written yet: the turn line under it says what the lead does.
  if (parts.length === 0 && files.length === 0 && streaming) return null;
  // The time goes on the message's last bubble of words.
  const timed = parts.findLastIndex((b) => b.kind === "text");
  return (
    <View style={[styles.them, gap]}>
      {first && item.author === "agent" ? <Text style={[type.caption, styles.by, { color: t.secondary }]}>{item.message?.by ?? "Agent"}</Text> : null}
      {parts.map((b, i) => (
        <BubbleView
          key={i}
          bubble={b}
          tail={last && files.length === 0 && i === parts.length - 1}
          canAnswer={canAnswer}
          chatKey={chatKey}
          actions={actions}
          target={messageId === undefined || streaming ? undefined : { id: messageId, part: i, who }}
          time={i === timed && files.length === 0 && !streaming ? time : undefined}
          when={when}
        />
      ))}
      {files.map((b, i) => (
        <MediaView key={`f${String(i)}`} bubble={b} chatKey={chatKey} mine={false} actions={actions} time={time} when={when} target={messageId === undefined ? undefined : { id: messageId, part: 0, who }} />
      ))}
    </View>
  );
}

/** What a reply quotes, inside its bubble: whose and their first line, as Telegram's; tapping goes to it. */
function Quote({ who, quote, onAccent, onPress }: { who: string; quote: string; onAccent: boolean; onPress: (() => void) | undefined }) {
  const t = useTheme();
  const ink = onAccent ? t.onAccent : t.accent;
  return (
    <Pressable disabled={onPress === undefined} onPress={onPress} accessibilityRole="button" accessibilityLabel={`Reply to ${who}: ${quote}`} style={[styles.quote, { backgroundColor: onAccent ? "rgba(255,255,255,0.18)" : t.accentSoft }]}>
      <View style={[styles.quoteRule, { backgroundColor: ink }]} />
      <View style={styles.quoteText}>
        <Text style={[type.footnote, styles.strong, { color: ink }]} numberOfLines={1}>
          {who}
        </Text>
        <Text style={[type.footnote, { color: onAccent ? t.onAccent : t.label }]} numberOfLines={1}>
          {quote}
        </Text>
      </View>
    </Pressable>
  );
}

/** A text bubble that lifts with its menu when held: Reply, Copy, Select Text. Lifted, it has no tail: its mask is the thread's ground. */
function HeldBubble({
  bubble,
  text,
  mine,
  when,
  target,
  actions,
  onPress,
}: {
  bubble: (tail: boolean) => ReactNode;
  text: string;
  mine: boolean;
  /** When it was sent, in full: the menu's title. */
  when: string;
  /** The hub's message and bubble a reply names; none for a send it doesn't have yet. */
  target: { id: string; part: number; who: string } | undefined;
  actions: ThreadActions;
  onPress?: (() => void) | undefined;
}) {
  const menu: MenuItem[] = [
    ...(target === undefined ? [] : [{ label: "Reply", icon: "reply" as const, onPress: () => actions.reply({ ...target, quote: quoteOf(text) }) }]),
    {
      label: "Copy",
      icon: "copy",
      onPress: () => {
        void Clipboard.setStringAsync(text);
        haptics.success();
      },
    },
    { label: "Select Text", icon: "select", presents: true, onPress: () => actions.selectText(text) },
  ];
  return (
    <HoldMenu
      items={menu}
      title={when}
      radius={BUBBLE_RADIUS}
      align={mine ? "right" : "left"}
      preview={bubble(false)}
      onPress={onPress}
      accessibilityRole={onPress === undefined ? undefined : "button"}
      accessibilityHint={onPress === undefined ? undefined : "Sends it again"}
    >
      {bubble(true)}
    </HoldMenu>
  );
}

/** A bubble's corners (ui/Bubble.tsx), and a picture's or a file's (ui/Media.tsx): the shape it lifts in. */
const BUBBLE_RADIUS = 18;

/** A picture or a file in the thread, with its time; held, it lifts with Reply and Share. */
function MediaView({
  bubble,
  chatKey,
  mine,
  actions,
  time,
  when,
  target,
}: {
  bubble: BubbleData;
  chatKey: Key;
  mine: boolean;
  actions: ThreadActions;
  time?: string | undefined;
  when: string;
  target?: { id: string; part: number; who: string } | undefined;
}) {
  const session = useSession();
  if (bubble.kind !== "image" && bubble.kind !== "file") return null;
  const menu: MenuItem[] = [
    ...(target === undefined ? [] : [{ label: "Reply", icon: "reply" as const, onPress: () => actions.reply({ ...target, quote: bubble.kind === "image" ? `Photo: ${bubble.name}` : bubble.name }) }]),
    {
      label: "Share",
      icon: "share",
      presents: true,
      onPress: () =>
        void session.attachment(chatKey, bubble.attachmentId).then((a) => {
          if (a !== null) void shareFile(a).catch(() => undefined);
        }),
    },
  ];
  const view = (held: boolean) =>
    bubble.kind === "image" ? (
      <ImageBubble chatKey={chatKey} attachmentId={bubble.attachmentId} name={bubble.name} time={time} onOpen={held ? () => undefined : actions.openImage} />
    ) : (
      <FileBubble chatKey={chatKey} attachmentId={bubble.attachmentId} name={bubble.name} mime={bubble.mime} bytes={bubble.bytes} mine={mine} time={time} />
    );
  return (
    <HoldMenu items={menu} title={when} radius={BUBBLE_RADIUS} align={mine ? "right" : "left"} preview={view(true)}>
      {view(false)}
    </HoldMenu>
  );
}

function BubbleView({
  bubble,
  tail,
  canAnswer,
  chatKey,
  actions,
  target,
  time,
  when,
}: {
  bubble: BubbleData;
  tail: boolean;
  canAnswer: boolean;
  chatKey: Key;
  actions: ThreadActions;
  target: { id: string; part: number; who: string } | undefined;
  time: string | undefined;
  when: string;
}) {
  const t = useTheme();
  switch (bubble.kind) {
    case "text":
      return (
        <HeldBubble
          actions={actions}
          mine={false}
          when={when}
          text={bubble.text}
          target={target}
          bubble={(withTail) => (
            <Bubble side="them" tail={withTail && tail} time={time}>
              <Markdown text={bubble.text} ink={t.label} room={time} />
            </Bubble>
          )}
        />
      );
    case "image":
    case "file":
      return <MediaView bubble={bubble} chatKey={chatKey} mine={false} actions={actions} time={time} when={when} target={target} />;
    case "ask":
      return (
        <View style={styles.ask}>
          <Bubble side="them" tail={tail}>
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
                    actions.answer(o);
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
          <View style={[styles.progressTrack, { backgroundColor: t.fillQuiet }]}>
            <View style={[styles.progressFill, { backgroundColor: t.success, width: `${String(bubble.items.length === 0 ? 0 : Math.round((done / bubble.items.length) * 100))}%` }]} />
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

/** A bubble's words to select a part of, in a sheet, as Telegram's Select Text. */
function SelectText({ text, onClose }: { text: string | null; onClose: () => void }) {
  const t = useTheme();
  if (text === null) return null;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.fill, { backgroundColor: t.bg }]}>
        <View style={styles.sheetHead}>
          <Text style={[type.headline, { color: t.label }]}>Select Text</Text>
          <Button label="Done" kind="plain" onPress={onClose} />
        </View>
        <TextInput
          value={text}
          editable={false}
          multiline
          scrollEnabled
          contextMenuHidden={false}
          style={[type.body, styles.selectable, { color: t.label }]}
          accessibilityLabel="Message text"
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { paddingHorizontal: space.md, flexGrow: 1 },
  emptyThread: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.xl, transform: [{ scaleY: -1 }] },
  center: { textAlign: "center" },
  starters: { alignSelf: "stretch", gap: space.sm, marginTop: space.lg },
  starter: { borderRadius: 18, borderCurve: "continuous", paddingHorizontal: space.lg, paddingVertical: 12 },
  older: { paddingVertical: space.md },
  error: { position: "absolute", left: 0, right: 0, paddingHorizontal: space.lg, paddingVertical: space.xs, textAlign: "center" },
  titleGlass: { borderRadius: 22, borderCurve: "continuous" },
  title: { flexDirection: "row", alignItems: "center", gap: space.sm, maxWidth: 240, paddingLeft: 6, paddingRight: space.lg, paddingVertical: 5 },
  titleText: { flexShrink: 1 },
  timeRow: { alignItems: "center", marginTop: space.lg, marginBottom: space.xs },
  timeChip: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  unreadBar: { alignItems: "center", paddingVertical: 5, marginTop: space.md, marginHorizontal: -space.md },
  strong: { fontWeight: "600" },
  groupGap: { marginTop: 10 },
  tightGap: { marginTop: 2 },
  litRow: { borderRadius: 20 },
  me: { alignItems: "flex-end", paddingLeft: 56, gap: 2 },
  mineRow: { flexDirection: "row", alignItems: "center", gap: space.sm, maxWidth: "100%" },
  mineBubble: { flexShrink: 1 },
  pending: { opacity: 0.7 },
  note: { marginTop: 3, marginRight: 4, textAlign: "right" },
  them: { alignItems: "flex-start", paddingRight: 56, gap: 2 },
  by: { marginLeft: space.md, marginBottom: 1 },
  quote: { flexDirection: "row", gap: space.sm, borderRadius: 8, paddingVertical: 4, paddingRight: space.sm, marginBottom: 6, marginTop: 2, overflow: "hidden" },
  quoteRule: { width: 3 },
  quoteText: { flexShrink: 1 },
  ask: { gap: space.sm, alignItems: "flex-start" },
  options: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  card: { marginHorizontal: -2 },
  blockCard: { alignSelf: "stretch", marginVertical: 2 },
  pr: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md },
  prIcon: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1 },
  pressed: { opacity: 0.7 },
  cardHead: { flexDirection: "row", alignItems: "baseline" },
  progressTrack: { height: 4, borderRadius: 2, overflow: "hidden" },
  progressFill: { height: 4, borderRadius: 2 },
  checklist: { gap: space.sm },
  check: { flexDirection: "row", alignItems: "center", gap: space.sm },
  event: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, marginVertical: space.sm, paddingHorizontal: space.xl },
  eventText: { textAlign: "center" },
  topFade: { position: "absolute", top: 0, left: 0, right: 0 },
  bottomFade: { position: "absolute", bottom: 0, left: 0, right: 0 },
  dock: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "flex-end" },
  down: { position: "absolute", right: space.md },
  downButton: { width: 44, height: 44, borderRadius: 22 },
  downHit: { flex: 1, alignItems: "center", justifyContent: "center" },
  downCount: { position: "absolute", top: -6, alignSelf: "center", minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  downCountText: { color: "#FFFFFF", fontWeight: "700" },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm },
  selectable: { flex: 1, paddingHorizontal: space.lg, paddingTop: space.sm },
});
