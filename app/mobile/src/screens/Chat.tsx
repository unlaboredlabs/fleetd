// One project's chat, as iOS 26's Messages draws one: the thread runs under a glass title and a
// floating glass composer, with soft edges where it meets them. Newest at the bottom, older pages as you scroll up;
// the person's bubbles on the right and the lead's on the left, grouped by burst with time chips between; pictures
// and files inline; the lead's text as it streams and the desktop's turn line while it works; blocks and approvals as
// cards; a skill its lead saved as one quiet line that opens it; a live screen as a card at the newest end
// (ScreenCards.tsx), which opens its live view.
//
// Opening it lands on the first message you haven't read, under an "Unread Messages" bar; what you scroll past is read,
// as is everything once you're at the bottom. Scrolled up, the thread holds still while replies come, and a glass
// button takes you back down and counts what came meanwhile; the status bar's tap goes a screen older. Pressing and holding a
// bubble lifts it with iOS's own menu (ui/HoldMenu.tsx): Reply (quoted above your words), Copy, and Select Text.
// Bubbles that arrive while you look rise in with the desktop's motion (ui/motion.ts). Messages written offline wait
// and go when the hub is back.
//
// Smooth while a reply streams: each row draws again only when its own message changed (chatView.ts sameRow), so a
// streamed word redraws one bubble; the keyboard, the composer on it and the thread above it move together on the UI
// thread (react-native-keyboard-controller), following a finger that drags the keyboard down.
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackNavigationOptions, NativeStackScreenProps } from "@react-navigation/native-stack";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, AppState, findNodeHandle, FlatList, Linking, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ListViewToken } from "react-native";
import { KeyboardChatScrollView, KeyboardStickyView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { arrivalsOf, ENTER_MS, rowKeyOf, type Arrivals } from "../arrivals";
import { aimOf, attachmentBubbles, bubbleTime, bubbles, cardOf, dayLine, fullTime, landingOf, olderOffset, outgoing, quoteOf, replyOf, sameRow, seenSeq, sendNote, sendWait, streamingAt, viaNote, threadRows, type Bubble as BubbleData, type ThreadRow } from "../chatView";
import { chatItems, emptyChat, type AttachmentRef, type ChatItem, type CommandApprovalItem } from "../desktop";
import { useHub, useSession, type RootParams } from "../hubContext";
import { linkStatus } from "../link";
import { useHubWord } from "./linkHeader";
import { useCanStop } from "../stopProbe";
import { dispatchPrefs, usePrefs } from "../prefsStore";
import type { DraftReply } from "../drafts";
import { changeDraft } from "../draftsStore";
import { refOf, type Key } from "../store";
import { parseInline } from "../markdown";
import { space, type, useTheme, type Palette } from "../theme";
import { upload } from "../upload";
import { Avatar, type Pictured } from "../ui/Avatar";
import { bubble as metrics, jumbo } from "../bubble";
import { Bubble, Jumbo } from "../ui/Bubble";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Composer } from "../ui/Composer";
import { announce } from "../ui/announce";
import { EdgeEffect } from "../ui/EdgeEffect";
import { Glass } from "../ui/Glass";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { HoldMenu } from "../ui/HoldMenu";
import { ArtifactLinks, Grid, Markdown } from "../ui/Markdown";
import { FileBubble, ImageBubble, ImageViewer, type OpenedImage } from "../ui/Media";
import { shareFile } from "../shareFile";
import { RevealArea, Revealed } from "../ui/Reveal";
import type { MenuItem } from "../ui/Menu";
import { bubbleIn, dur, ease, PRESSED_OPACITY, useReduceMotion } from "../ui/motion";
import { SkeletonThread } from "../ui/Skeleton";
import { StateGlyph } from "../ui/StateGlyph";
import { StatusBarTap } from "../ui/StatusBarTap";
import { arrivedReplies, bubbleActions, bubbleLabel, spokenText } from "../spoken";
import { ApprovalCard, ApprovalOutcomeLine } from "./ApprovalCard";
import { ArtifactCard } from "./artifacts/ArtifactCard";
import { linkTarget } from "./artifacts/model";
import { ScreenCards } from "./ScreenCards";
import { Symbol } from "./manage/parts";
import { machineName } from "./manage/model";
import type { SkillSaved } from "./manage/skillsModel";
import { TurnLine } from "./TurnLine";
import { useNow } from "./time";

/**
 * On iOS the chat draws its own bar (ChatBar), its glass back button, title and Info floating over the thread, which
 * blurs away under them (iOS 26's scroll edge effect, EdgeEffect) as under the system's bars. The stack's bar stays hidden, as it is over the chats list: a bar the stack shows over a chat
 * and hides again on the way back didn't leave with the chat but stood over the list sliding in, then slid off late
 * (UIKit, iOS 26). Drawn in the screen, it goes with the chat, by the back button or a swipe from the edge.
 */
export const chatOptions = (t: Palette): NativeStackNavigationOptions =>
  Platform.OS === "ios" ? { headerShown: false } : { headerBackButtonDisplayMode: "minimal", headerTintColor: t.label, headerTitleAlign: "center", headerStyle: { backgroundColor: t.bg } };

/** The bar's height under the status bar, and its glass buttons', as iOS 26's own (Messages' are 44). */
const BAR = 54;
const BAR_BUTTON = 44;

/** Scrolled up further than this from the newest, the button down shows. */
const AWAY = 280;

/**
 * What a chat's thread does that its rows need: replies, the image viewer, jumping to a message, who wrote one. The
 * same object for as long as the chat is open, so rows that didn't change don't draw again.
 */
interface ThreadActions {
  readonly reply: (target: { readonly id: string; readonly part: number; readonly who: string; readonly quote: string }) => void;
  readonly selectText: (text: string) => void;
  readonly openImage: (image: OpenedImage) => void;
  readonly jumpTo: (messageId: string) => void;
  /** Whose the message is, as a reply's quote names them: "You", or the chat's lead. */
  readonly whoWrote: (messageId: string) => string;
  readonly answer: (text: string) => void;
  /** A skill its lead saved, opened over its Info screen. */
  readonly openSkill: (name: string) => void;
  /** An artifact a card or link names, opened over its Info screen: its newest version, or `version`. */
  readonly openArtifact: (name: string, version: number | undefined) => void;
}

export function Chat({ navigation, route }: NativeStackScreenProps<RootParams, "Chat">) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const { state, session } = useHub();
  const prefs = usePrefs();
  const chatKey = route.params.key;
  const insets = useSafeAreaInsets();
  // Where the thread starts under the bar (iOS draws it over the thread; Android's stack draws it above).
  const top = Platform.OS === "ios" ? insets.top + BAR : 0;
  const project = state.projects?.[chatKey];
  const chatState = state.chatStates[chatKey];
  const chat = state.chats[chatKey] ?? emptyChat;
  const olderError = state.olderErrors[chatKey];
  const sends = state.sends[chatKey];
  const items = useMemo(() => chatItems(chat, sends ?? []), [chat, sends]);
  const working = chatState?.leadWorking === true;
  const live = state.hub.phase === "live";
  // What was read when the chat opened: the unread bar stays there while it's open, as chat apps' does.
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
  const title = project?.title ?? "Chat";

  // Which bubbles enter with motion: what arrives while the chat is open and live (arrivals.ts).
  const arrivals = useRef<Arrivals | undefined>(undefined);
  const entering = useMemo(() => {
    // Not until its first page is in: what the chat opens with shows still.
    if (!chat.loaded) return new Map<string, { at: number; step: number }>();
    arrivals.current = arrivalsOf(arrivals.current, items, live, Date.now());
    return arrivals.current.entering;
  }, [items, live, chat.loaded]);
  // VoiceOver says each reply that comes in while you look, as Messages does.
  const heard = useRef(entering);
  useEffect(() => {
    for (const said of arrivedReplies(heard.current, entering, items, title)) announce(said);
    heard.current = entering;
  }, [entering, items, title]);

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
  // "Connecting…", "Updating…" while the hub restarts for an update, or nothing for a restart's first seconds (hubWord.ts).
  const linkWord = useHubWord().word;
  // Always a line under the name, as a chat app's "online": the title never jumps when the lead starts or stops.
  const quiet = project === undefined ? undefined : `on ${machineName(state.machines, project.machineId)}`;
  const status = link?.busy === true ? (linkWord?.text ?? quiet) : link !== undefined ? "Offline" : working ? "Working…" : chatState?.needsYou === true ? "Waiting for you" : quiet;
  const openInfo = useCallback(() => navigation.navigate("ChatInfo", { screen: "Info", params: { key: chatKey } }), [navigation, chatKey]);
  // Android's stack draws the bar.
  useEffect(() => {
    if (Platform.OS === "ios") return;
    navigation.setOptions({
      headerTitle: () => <ChatTitle picture={project} title={title} status={status} busy={working && link === undefined} onPress={openInfo} />,
      title,
    });
    // A picture or icon set or removed (here or on another device) draws the header again: its id or names are all that change.
  }, [navigation, title, status, working, link, project?.avatar, project?.icon?.face, project?.icon?.color, openInfo]);

  const list = useRef<FlatList<ThreadRow>>(null);
  // The list's native tag, for the bars' scroll edge effect: it is mounted once the screen is.
  const [listTag, setListTag] = useState<number | null>(null);
  useEffect(() => setListTag(findNodeHandle(list.current) ?? null), []);
  const [composerHeight, setComposerHeight] = useState(60);
  // What you're writing here is the composer's (its draft, drafts.ts), so a letter typed draws the composer, not the
  // thread; a bubble's Reply sets the draft's quote, and a send brings it.
  const canStop = useCanStop(session, working);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [image, setImage] = useState<OpenedImage | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  // The thread's height, and what of it shows between the bar over it and the composer.
  const [height, setHeight] = useState(0);
  const room = height - top - composerHeight;

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
  // Where it's scrolled to, and how far it goes, for the status bar's tap: the length as the content grows (a chat
  // opened at its newest end never scrolls, and older pages come in without a scroll).
  const scrolled = useRef({ y: 0, length: 0 });
  const onContentSize = (_width: number, length: number) => {
    scrolled.current = { ...scrolled.current, length };
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrolled.current = { y: e.nativeEvent.contentOffset.y, length: e.nativeEvent.contentSize.height };
    // How far from the newest end, wherever the keyboard puts it.
    const y = e.nativeEvent.contentOffset.y - newestEnd();
    if (y > AWAY && awayFrom === null) setAwayFrom(newestSeq);
    else if (y < AWAY / 3 && awayFrom !== null) setAwayFrom(null);
  };
  // The status bar's tap goes a screen older, as chat apps' does, never to the newest end.
  const olderByAScreen = () => {
    const { y, length } = scrolled.current;
    list.current?.scrollToOffset({ offset: olderOffset(y, length, room, height), animated: !reduce });
  };

  // Read is what you've seen: the newest message on screen once the chat has landed where it opens, and everything at
  // the newest end. Not while the app is away or another screen covers the chat (Info, a live screen).
  const focused = useIsFocused();
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);
  const [placed, setPlaced] = useState(false);
  const reading = placed && focused && active;
  const lastSeq = chatState?.lastSeq;
  useEffect(() => {
    if (reading && awayFrom === null && lastSeq !== undefined && chat.loaded) dispatchPrefs({ t: "read", key: chatKey, seq: lastSeq });
  }, [reading, awayFrom, lastSeq, chat.loaded, chatKey]);
  const onScreen = useRef<readonly ThreadRow[]>([]);
  const seen = useRef({ reading, chatKey });
  seen.current = { reading, chatKey };
  const readSeen = useCallback(() => {
    const seq = seenSeq(onScreen.current);
    if (seen.current.reading && seq !== undefined) dispatchPrefs({ t: "read", key: seen.current.chatKey, seq });
  }, []);
  // FlatList takes these once.
  const onViewable = useRef(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    onScreen.current = viewableItems.map((v) => v.item as ThreadRow);
    readSeen();
  }).current;
  const viewability = useRef({ itemVisiblePercentThreshold: 60, minimumViewTime: 300 }).current;
  useEffect(() => {
    if (reading) readSeen();
  }, [reading, readSeen]);

  // Scrolling to a row, at `viewPosition` of what shows between the bar and the composer, or starting just under the
  // bar if it's the hit and taller than that (chatView aimOf). A row not drawn yet is gone to roughly, then again until
  // it is; `done` once it's there.
  const aim = useRef<{ viewPosition: number; animated: boolean; tries: number; reached: number; done: (() => void) | undefined } | null>(null);
  const aimAt = (index: number, a: NonNullable<typeof aim.current>) => {
    const tries = a.tries;
    const row = newestFirst[index];
    const length = row?.t === "item" && row.item.message?.messageId === hit.current?.id ? hit.current?.length : undefined;
    list.current?.scrollToIndex({ index, animated: a.animated, ...aimOf(a.viewPosition, length, height, top, composerHeight) });
    // It didn't fail (onScrollToIndexFailed counts a try): there.
    if (a.tries === tries) requestAnimationFrame(() => a.done?.());
  };
  const scrollToRow = (find: (r: ThreadRow) => boolean, viewPosition: number, animated = !reduce, done?: () => void) => {
    const at = newestFirst.findIndex(find);
    if (at < 0) return false;
    aim.current = { viewPosition, animated, tries: 0, reached: -1, done };
    aimAt(at, aim.current);
    return true;
  };

  // Opened with unread messages: land on the first of them, its bar just under the bar over the thread, rather than at
  // the very bottom. Opened at a message (a search hit) or an approval (its notification tapped, again too, while the
  // chat is open): land on it, lit, reading older pages first while the approval's card is further back than them. A
  // chat's notification tapped while it's open: its newest. The thread stays hidden for the moment it moves, so the
  // newest end doesn't show first.
  const { messageId, requestId, tap } = route.params;
  // The message it lands on, measured as it's drawn, for aimOf.
  const hitId = useMemo(() => messageId ?? (requestId === undefined ? undefined : cardOf(items, requestId)), [messageId, requestId, items]);
  const hit = useRef<{ id: string; length: number } | null>(null);
  const landed = useRef<string | null>(null);
  const [moving, setMoving] = useState(false);
  useLayoutEffect(() => {
    const wanted = `${messageId ?? ""} ${requestId ?? ""} ${String(tap ?? 0)}`;
    if (landed.current === wanted || !chat.loaded) return;
    if (newestFirst.length === 0) {
      landed.current = wanted;
      setPlaced(true);
      return;
    }
    const found = landingOf(items, { messageId, requestId }, { hasOlder: chat.hasOlder, failed: chat.error !== undefined || olderError !== undefined });
    if (found === "older") {
      if (!chat.loadingOlder) void session.loadOlder(chatKey);
      return;
    }
    const first = landed.current === null;
    landed.current = wanted;
    const target = found;
    if (target === undefined && !first) {
      setAwayFrom(null);
      toNewest();
      return;
    }
    const at = target !== undefined ? newestFirst.findIndex((r) => r.t === "item" && r.item.message?.messageId === target) : newestFirst.findIndex((r) => r.t === "unread");
    // Unread near the bottom already: nothing to jump to. A hit is gone to wherever it is, as newer rows or its own
    // length can leave it under the bar at the newest end.
    if (at < 0 || (target === undefined && at < 6)) {
      setPlaced(true);
      return;
    }
    if (first) setMoving(true);
    setTimeout(() => {
      const there = () => {
        setMoving(false);
        setPlaced(true);
      };
      const find = (r: ThreadRow) => (target !== undefined ? r.t === "item" && r.item.message?.messageId === target : r.t === "unread");
      if (!scrollToRow(find, target !== undefined ? 0.5 : 1, !first && !reduce, there)) there();
      if (target !== undefined) setLit(target);
      else if (unreadFrom !== undefined) setAwayFrom(unreadFrom);
    }, 50);
  });
  // Never hidden for long, wherever it got to.
  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(() => {
      setMoving(false);
      setPlaced(true);
    }, 1000);
    return () => clearTimeout(timer);
  }, [moving]);
  useEffect(() => {
    if (lit === null) return;
    const timer = setTimeout(() => setLit(null), 1600);
    return () => clearTimeout(timer);
  }, [lit]);

  // Holding still: scrolled up, what you read stays where it is while replies come and stream in under it; at the
  // newest end, a long reply is followed until its first line reaches the bar, then held there, as ChatGPT holds one,
  // and the button down counts on. Each by maintainVisibleContentPosition, on the first row that should keep its place.
  const streamAt = streamingAt(newestFirst);
  const [tall, setTall] = useState(false);
  useEffect(() => {
    if (streamAt === undefined) setTall(false);
  }, [streamAt]);
  const holdFrom = awayFrom !== null ? 0 : tall && streamAt !== undefined ? streamAt + 1 : undefined;
  const hold = useMemo(() => (holdFrom === undefined ? undefined : { minIndexForVisible: holdFrom }), [holdFrom]);

  // What you send shows at once, as in Messages, wherever the thread was scrolled to. The composer's words go as a
  // reply while its banner shows; a quick answer or a starter never does, and leaves the banner for what you type.
  const send = (body: string, files: readonly AttachmentRef[] = [], reply?: DraftReply) => {
    const out = outgoing(body, files.length, reply);
    if (out === null) return;
    setAwayFrom(null);
    // In a frame, once the hold above is off: on, the list would keep its place as your message went in under it.
    requestAnimationFrame(() => {
      session.send(chatKey, out.text, { attachments: files, replyTo: out.replyTo });
      toNewest();
    });
  };

  // Stop while the lead works, as the desktop's: chat_stop stops its running step and the project's agents, and its
  // line in the chat says what stopped. One press at a time, each its own request: the hub answers a request sent
  // again (the link dropped) with the line it already wrote, stopping nothing twice.
  const stopping = useRef(false);
  const stop = () => {
    if (stopping.current) return;
    stopping.current = true;
    haptics.tap();
    void session.call("chat_stop", { projectRef: refOf(chatKey), clientRequestId: stopId() }).then((r) => {
      stopping.current = false;
      if (r.ok) return;
      haptics.warning();
      Alert.alert("The lead wasn't stopped", r.error.message);
    });
  };

  // What the actions read, as of the last draw.
  const now = useRef({ items, title, send, scrollToRow, chatKey });
  now.current = { items, title, send, scrollToRow, chatKey };
  const actions = useMemo(
    (): ThreadActions => ({
      reply: (r) => {
        haptics.tap();
        changeDraft(now.current.chatKey, (d) => ({ ...d, reply: { id: r.id, part: r.part, who: r.who, quote: r.quote } }));
      },
      selectText: setSelecting,
      openImage: setImage,
      jumpTo: (messageId) => {
        if (now.current.scrollToRow((r) => r.t === "item" && r.item.message?.messageId === messageId, 0.5)) setLit(messageId);
      },
      whoWrote: (messageId) => (now.current.items.find((i) => i.id === messageId)?.author === "human" ? "You" : now.current.title),
      answer: (text) => now.current.send(text),
      openSkill: (name) => {
        haptics.tap();
        // Its Info screen under it, with its key: `initial: false` would make one without.
        const key = now.current.chatKey;
        navigation.navigate("ChatInfo", { state: { index: 1, routes: [{ name: "Info", params: { key } }, { name: "Skill", params: { key, origin: "project", name } }] } });
      },
      openArtifact: (name, version) => {
        haptics.tap();
        const key = now.current.chatKey;
        navigation.navigate("ChatInfo", { state: { index: 1, routes: [{ name: "Info", params: { key } }, { name: "Artifact", params: { key, name, version } }] } });
      },
    }),
    [navigation],
  );
  // The reply streaming in is measured, to know when its first line reaches the bar.
  const measureStream = useCallback((e: LayoutChangeEvent) => {
    if (room > 0 && e.nativeEvent.layout.height >= room) setTall(true);
  }, [room]);
  const measureHit = useCallback((e: LayoutChangeEvent) => {
    if (hitId !== undefined) hit.current = { id: hitId, length: e.nativeEvent.layout.height };
  }, [hitId]);
  const renderRow = useCallback(
    ({ item: row, index: at }: { item: ThreadRow; index: number }) => (
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
        onLayout={at === streamAt ? measureStream : row.t === "item" && hitId !== undefined && row.item.message?.messageId === hitId ? measureHit : undefined}
      />
    ),
    [chatKey, title, index, lastHuman, actions, lit, entering, reduce, awayFrom, streamAt, measureStream, hitId, measureHit],
  );

  // An artifact link in a message opens it as its card does.
  const openLink = useCallback(
    (url: string) => {
      const to = linkTarget(url);
      if (to !== undefined) actions.openArtifact(to.name, to.version);
      return to !== undefined;
    },
    [actions],
  );
  const loading = !chat.loaded && chat.cached !== true;
  return (
    <View style={[styles.fill, { backgroundColor: t.thread }]}>
      <View style={styles.fill}>
        <RevealArea margin={metrics.margin}>
          <ArtifactLinks.Provider value={openLink}>
            <FlatList
              ref={list}
              inverted
              style={moving ? styles.hidden : undefined}
              onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
              onContentSizeChange={onContentSize}
              maintainVisibleContentPosition={hold}
              onViewableItemsChanged={onViewable}
              viewabilityConfig={viewability}
              // Upside down, iOS's own status-bar tap would go to the newest end: StatusBarTap takes it instead.
              scrollsToTop={false}
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
                const a = aim.current;
                if (a === null) return;
                a.tries += 1;
                // Each try draws more of the thread, a few rows at a time (far fewer of them fit a screen at large text
                // sizes): it gives up only once one draws no more.
                const more = info.highestMeasuredFrameIndex > a.reached;
                a.reached = Math.max(a.reached, info.highestMeasuredFrameIndex);
                if (a.tries > 3 && !more) return void a.done?.();
                setTimeout(() => aimAt(info.index, a), 80);
              }}
              onEndReached={() => void session.loadOlder(chatKey)}
              // Upside down too: the newest end, where its live screens sit over the composer.
              ListHeaderComponent={
                <View>
                  <ScreenCards chatKey={chatKey} />
                  <View style={{ height: composerHeight + space.xs }} />
                </View>
              }
              {...(loading ? {} : { ListEmptyComponent: <EmptyThread picture={project} title={title} code={(project?.repos?.length ?? 0) > 0} onPick={(s) => send(s)} /> })}
              // The list is upside down: its footer is the top, under the clear header.
              ListFooterComponent={
                <View style={{ paddingTop: top + space.sm }}>
                  {loading && items.length === 0 ? (
                    <SkeletonThread />
                  ) : chat.loadingOlder ? (
                    <ActivityIndicator style={styles.older} color={t.secondary} />
                  ) : olderError !== undefined ? (
                    // Where the older messages would be: why they didn't come, and a tap reads them again.
                    <Pressable accessibilityRole="button" accessibilityHint="Reads them again" onPress={() => void session.loadOlder(chatKey)} style={styles.older}>
                      <Text style={[type.footnote, styles.olderError, { color: t.secondary }]}>
                        {`Older messages didn't load. ${olderError.message} `}
                        <Text style={{ color: t.accent }}>Try Again</Text>
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              }
              renderItem={renderRow}
            />
          </ArtifactLinks.Provider>
        </RevealArea>
        {Platform.OS === "ios" ? (
          // The list is upside down: the bar is over its bottom edge.
          <EdgeEffect
            list={listTag}
            edge="bottom"
            style={[styles.topEdge, { height: top }]}
            fallback={<LinearGradient pointerEvents="none" colors={[t.thread, withOpacity(t.thread, 0.85), withOpacity(t.thread, 0)]} locations={[0, 0.55, 1]} style={[styles.topFade, { height: top + space.lg }]} />}
          >
            <ChatBar top={insets.top} onBack={() => navigation.goBack()} onInfo={openInfo}>
              <ChatTitle picture={project} title={title} status={status} busy={working && link === undefined} onPress={openInfo} />
            </ChatBar>
          </EdgeEffect>
        ) : null}
        {/* The composer and what sits on it ride on the keyboard. */}
        <KeyboardStickyView offset={{ closed: 0, opened: lift }} style={styles.dock} pointerEvents="box-none">
          {chat.error === undefined ? null : <Text style={[type.footnote, styles.error, { color: t.danger, bottom: composerHeight + space.xs }]}>{chat.error.message}</Text>}
          {awayFrom === null ? null : (
            // Its glass materializes rather than fading in: glass under an opacity below 1 doesn't draw (UIKit).
            <View style={[styles.down, { bottom: composerHeight + space.md }]}>
              <Glass interactive appear style={styles.downButton}>
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
                  <Text style={[type.caption, styles.downCountText, { color: t.onAccent }]} maxFontSizeMultiplier={1.3}>
                    {cameSince > 99 ? "99+" : String(cameSince)}
                  </Text>
                </View>
              ) : null}
            </View>
          )}
          <EdgeEffect
            list={listTag}
            edge="top"
            fallback={
              Platform.OS === "ios" ? (
                <LinearGradient pointerEvents="none" colors={[withOpacity(t.thread, 0), withOpacity(t.thread, 0.9)]} style={[styles.bottomFade, { height: composerHeight + space.lg }]} />
              ) : null
            }
          >
            <Composer
              chatKey={chatKey}
              onSend={(text, files, reply) => send(text, files, reply)}
              upload={(bytes, name, mime, progress) => upload((tool, input, timeoutMs) => session.call(tool, input, timeoutMs), bytes, name, mime, progress)}
              bottomInset={insets.bottom}
              onStop={working && live && canStop ? stop : undefined}
              onHeight={setComposerHeight}
            />
          </EdgeEffect>
        </KeyboardStickyView>
      </View>
      {focused ? <StatusBarTap onTap={olderByAScreen} /> : null}
      <SelectText text={selecting} onClose={() => setSelecting(null)} />
      <ImageViewer image={image} onClose={() => setImage(null)} />
    </View>
  );
}

const stopId = (): string => `stop-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const withOpacity = (hex: string, alpha: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String((n >> 16) & 255)},${String((n >> 8) & 255)},${String(n & 255)},${String(alpha)})`;
};

/** A chat with nothing in it yet: who it is, and a few things to say to start. Turned upright: the list is upside down. */
function EmptyThread({ picture, title, code, onPick }: { picture: Pictured | undefined; title: string; code: boolean; onPick: (text: string) => void }) {
  const t = useTheme();
  // A project with no repo yet starts on what it can do for you; one with repos, on its code.
  const starters = code ? ["What are you working on?", "Show me the open pull requests", "What failed in CI?"] : ["What can you do for me?", "Remind me every Friday to plan my week", "How are my projects going?"];
  return (
    <View style={styles.emptyThread}>
      <Avatar name={title} size={88} picture={picture} />
      <Text style={[type.title2, { color: t.label }]}>{title}</Text>
      <Text style={[type.subhead, styles.center, { color: t.secondary }]}>{code ? "Tell the lead what to work on, or start with one of these." : "Ask it anything, or start with one of these."}</Text>
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

/** iOS's bar over the thread (chatOptions): glass back and Info buttons either side of the title, as the stack's own. */
function ChatBar({ top, onBack, onInfo, children }: { top: number; onBack: () => void; onInfo: () => void; children: ReactNode }) {
  const t = useTheme();
  const button = (label: string, symbol: "chevron.left" | "info.circle", onPress: () => void) => (
    <Glass interactive style={styles.barButton}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} style={styles.barHit} onPress={onPress}>
        <Symbol ios={symbol} android={symbol === "info.circle" ? "info" : "arrow_back"} size={symbol === "info.circle" ? 26 : 24} color={t.label} />
      </Pressable>
    </Glass>
  );
  return (
    <View style={[styles.bar, { top }]} pointerEvents="box-none">
      {button("Back", "chevron.left", onBack)}
      {children}
      {button("Info", "info.circle", onInfo)}
    </View>
  );
}

/** The chat's name and how it is, in a glass capsule over the thread, as iOS 26's chat apps draw it. Tapped, its Info, as Messages'. */
function ChatTitle({ picture, title, status, busy, onPress }: { picture: Pictured | undefined; title: string; status: string | undefined; busy: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    // The glass gives the press its own response: no dimming, which glass doesn't draw under.
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={status === undefined ? title : `${title}, ${status}`} accessibilityHint="Shows the chat's info">
      <Glass interactive style={styles.titleGlass}>
        <View style={styles.title}>
          <Avatar name={title} size={30} picture={picture} />
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
    </Pressable>
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
  /** The reply streaming in, or the message the chat lands on: its height. */
  readonly onLayout: ((e: LayoutChangeEvent) => void) | undefined;
}

/** Draws again only when its own row changed: the thread's rows are made anew with each streamed word. */
const sameProps = (a: RowProps, b: RowProps): boolean =>
  a.chatKey === b.chatKey && a.title === b.title && a.canAnswer === b.canAnswer && a.actions === b.actions && a.lit === b.lit && a.enter === b.enter && a.reduce === b.reduce && a.still === b.still && a.onLayout === b.onLayout && sameRow(a.row, b.row);

const RowView = memo(function RowView({ row, chatKey, title, canAnswer, actions, lit, enter, reduce, still, onLayout }: RowProps) {
  const t = useTheme();
  const now = useNow();
  // Entering only as it mounts soon after it came: a row scrolled back to later shows still.
  const [motion] = useState(() => (enter !== undefined && Date.now() - enter.at < ENTER_MS ? enter : undefined));
  if (row.t === "day") {
    return (
      <View style={styles.timeRow} accessibilityRole="header">
        {/* A quiet capsule, not glass: glass is for what floats over the thread, not what scrolls in it. */}
        <View style={[styles.timeChip, { backgroundColor: t.fillQuiet }]}>
          <Text style={[type.caption, styles.strong, { color: t.secondary }]}>{dayLine(row.at, now)}</Text>
        </View>
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
  const item = <ItemView item={row.item} side={row.side} first={row.first} last={row.last} chatKey={chatKey} title={title} canAnswer={canAnswer} actions={actions} />;
  const body =
    row.side === "center" ? (
      item
    ) : (
      <Revealed mine={row.side === "me"} time={bubbleTime(row.item.at, now)}>
        {item}
      </Revealed>
    );
  return (
    <Animated.View
      {...(motion === undefined ? {} : { entering: bubbleIn(row.side === "me", motion.step, reduce) })}
      onLayout={onLayout}
      style={[lit && { backgroundColor: t.accentSoft }, styles.litRow]}
    >
      {body}
    </Animated.View>
  );
}, sameProps);

/** An approval asked in the chat: its card while it's open, then a line saying how it went. */
function InlineApproval({ chatKey, item }: { chatKey: Key; item: CommandApprovalItem }) {
  // The hub's state, which a row reads only here: the rest of the thread doesn't draw again with it.
  const { state, session } = useHub();
  const open = item.state === "open" ? state.requests?.find((r) => r.requestId === item.requestId) : undefined;
  // Its card was on screen in this row: the line that takes its place is news, said as it shows.
  const hadCard = useRef(false);
  useEffect(() => {
    if (open !== undefined) hadCard.current = true;
  }, [open]);
  if (open === undefined) return <ApprovalOutcomeLine item={item} decided={state.decided[item.requestId]} justAnswered={hadCard.current} />;
  const project = state.projects?.[chatKey];
  return (
    <View style={[styles.card, styles.groupGap]}>
      <ApprovalCard
        request={open}
        projectTitle={project?.title}
        picture={project}
        answering={state.answering[open.requestId] === true}
        error={state.answerErrors[open.requestId]}
        onAnswer={(d) => session.answer(open.requestId, d)}
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
  const when = fullTime(item.at, now);
  const inline = item.message?.item;
  if (inline?.kind === "command_approval") return <InlineApproval chatKey={chatKey} item={inline} />;
  if (inline?.kind === "secret_request") {
    // A secure input says what it is and where it goes; either way the value is typed only where it is sealed.
    const input = inline.secureInput;
    const text = input === undefined ? "Asks for a secret: enter it in the desktop app." : `Asks for ${input.label} for ${input.site.name}: enter it in the desktop app.`;
    return <Event text={text} icon="lock" />;
  }
  const saved = (item.message as { skillSaved?: SkillSaved } | undefined)?.skillSaved;
  if (saved !== undefined) return <SkillLine saved={saved} onPress={() => actions.openSkill(saved.name)} />;
  const published = item.message?.artifact;
  if (published !== undefined) return <ArtifactCard published={published} when={bubbleTime(item.at, now)} onPress={() => actions.openArtifact(published.name, published.version)} />;
  if (side === "center") return <Event text={item.text} />;

  const messageId = item.message?.messageId;
  const who = item.author === "human" ? "You" : item.author === "agent" ? (item.message?.by ?? "Agent") : title;
  const said = { who, at: bubbleTime(item.at, now) };
  const files = attachmentBubbles(item);

  if (side === "me") {
    const note = sendNote(item);
    const via = viaNote(item);
    const retry = item.state === "failed" || item.state === "unanswered";
    const replied = replyOf(item.text);
    const words = replied?.body ?? item.text;
    const quotedId = item.message?.replyTo?.messageId;
    const quotedWho = quotedId === undefined ? title : actions.whoWrote(quotedId);
    return (
      <View style={[styles.me, gap]}>
        {words.trim() === "" ? null : (
          <View style={styles.mineRow}>
            {/* Held still while it goes: no dimming that lifts when the hub has it. */}
            <View style={styles.mineBubble}>
              <HeldBubble
                actions={actions}
                mine
                when={when}
                said={said}
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
                bubble={(tail) =>
                  replied === undefined && jumbo(words) > 0 ? (
                    <Jumbo side="me" text={words} count={jumbo(words)} />
                  ) : (
                    <Bubble side="me" tail={tail && last && files.length === 0}>
                      {replied === undefined ? null : <Quote who={quotedWho} quote={replied.quote} onAccent onPress={quotedId === undefined ? undefined : () => actions.jumpTo(quotedId)} />}
                      <Markdown text={words} ink={t.onAccentDeep} onAccent fit holdsBlocks={false} />
                    </Bubble>
                  )
                }
              />
              {files.length === 0 ? <SendWait state={item.state} at={item.at} /> : null}
            </View>
            {retry ? <NotSent chatKey={chatKey} id={item.id} note={note} /> : null}
          </View>
        )}
        {files.map((b, i) => (
          // Each in a view of its own, the last's holding the mark of a slow send: one tree from sending to sent.
          <View key={i}>
            <MediaView bubble={b} chatKey={chatKey} mine actions={actions} when={when} said={said} target={messageId === undefined ? undefined : { id: messageId, part: 0, who }} tail={last && i === files.length - 1} />
            {i === files.length - 1 ? <SendWait state={item.state} at={item.at} /> : null}
          </View>
        ))}
        {note === undefined ? null : (
          <View style={styles.noteRow}>
            <Text style={[type.caption, styles.note, { color: retry ? t.danger : t.secondary }]}>{note}</Text>
            {/* Only files: the ! goes by the note, as there's no text bubble to put it by. */}
            {retry && words.trim() === "" ? <NotSent chatKey={chatKey} id={item.id} note={note} /> : null}
          </View>
        )}
        {via === undefined ? null : <Text style={[type.caption, styles.note, { color: t.secondary }]}>{via}</Text>}
      </View>
    );
  }

  const parts = bubbles(item);
  const streaming = item.state === "streaming";
  // Nothing written yet: the turn line under it says what the lead does.
  if (parts.length === 0 && files.length === 0 && streaming) return null;
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
          fit={!streaming}
          when={when}
          said={said}
        />
      ))}
      {files.map((b, i) => (
        <MediaView key={`f${String(i)}`} bubble={b} chatKey={chatKey} mine={false} actions={actions} when={when} said={said} target={messageId === undefined ? undefined : { id: messageId, part: 0, who }} tail={last && i === files.length - 1} />
      ))}
    </View>
  );
}

/**
 * A send still on its way, once it's slow (sendWait): the desktop's waiting mark, an open ring of cells, beside the
 * bubble's foot, fading in on the desktop's curve. Out of the row's layout, so the bubble and the thread hold still as it
 * comes and goes; a send the hub takes within SLOW_SEND_MS never shows it.
 */
function SendWait({ state, at }: Pick<ChatItem, "state" | "at">) {
  const reduce = useReduceMotion();
  const [nowMs, setNow] = useState(Date.now);
  const wait = sendWait({ state, at }, nowMs);
  const inMs = wait?.inMs;
  useEffect(() => {
    if (inMs === undefined || inMs === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), inMs);
    return () => clearTimeout(timer);
  }, [inMs]);
  if (wait === undefined || wait.inMs > 0) return null;
  const fade = reduce ? 0 : dur.quick;
  return (
    <Animated.View entering={FadeIn.duration(fade).easing(ease.snap)} exiting={FadeOut.duration(fade).easing(ease.snap)} style={styles.wait}>
      <StateGlyph state="queued" label={wait.words} />
    </Animated.View>
  );
}

/** A send that didn't go: its red !, which offers Try Again and Delete, as Messages' does. */
function NotSent({ chatKey, id, note }: { chatKey: Key; id: string; note: string | undefined }) {
  const t = useTheme();
  const session = useSession();
  const again = () => {
    haptics.tap();
    session.resend(chatKey, id);
  };
  const remove = () => session.discard(chatKey, id);
  const open = () => {
    haptics.tap();
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ message: note, options: ["Try Again", "Delete", "Cancel"], destructiveButtonIndex: 1, cancelButtonIndex: 2 }, (i) => {
        if (i === 0) again();
        if (i === 1) remove();
      });
    } else {
      Alert.alert("Not Sent", note, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: remove },
        { text: "Try Again", onPress: again },
      ]);
    }
  };
  return (
    <Pressable onPress={open} hitSlop={11} accessibilityRole="button" accessibilityLabel="Not sent" accessibilityHint="Try again, or delete it">
      <Icon name="error" size={22} color={t.danger} />
    </Pressable>
  );
}

/** What a reply quotes, inside its bubble: whose and their first line, as chat apps show it; tapping goes to it. */
function Quote({ who, quote, onAccent, onPress }: { who: string; quote: string; onAccent: boolean; onPress: (() => void) | undefined }) {
  const t = useTheme();
  const ink = onAccent ? t.onAccentDeep : t.accent;
  return (
    <Pressable disabled={onPress === undefined} onPress={onPress} accessibilityRole="button" accessibilityLabel={`Reply to ${who}: ${quote}`} style={[styles.quote, { backgroundColor: onAccent ? "rgba(255,255,255,0.18)" : t.accentSoft }]}>
      <View style={[styles.quoteRule, { backgroundColor: ink }]} />
      <View style={styles.quoteText}>
        <Text style={[type.footnote, styles.strong, { color: ink }]} numberOfLines={1}>
          {who}
        </Text>
        <Text style={[type.footnote, { color: onAccent ? t.onAccentDeep : t.label }]} numberOfLines={1}>
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
  said,
}: {
  bubble: (tail: boolean) => ReactNode;
  text: string;
  mine: boolean;
  /** When it was sent, in full: the menu's title. */
  when: string;
  /** Who wrote it and when, for VoiceOver, which reads it as Messages does: "Ada, the words, 9:41". */
  said: Said;
  /** The hub's message and bubble a reply names; none for a send it doesn't have yet. */
  target: { id: string; part: number; who: string } | undefined;
  actions: ThreadActions;
  onPress?: (() => void) | undefined;
}) {
  const menu: MenuItem[] = [
    ...(target === undefined ? [] : [{ label: "Reply", icon: "reply" as const, instant: true, onPress: () => actions.reply({ ...target, quote: quoteOf(text) }) }]),
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
  const voice = bubbleActions(text).map((a) => ({
    label: a.label,
    onPress: a.t === "open" ? () => void Linking.openURL(a.url) : () => void Clipboard.setStringAsync(a.text).then(() => announce("Copied")),
  }));
  return (
    <HoldMenu
      items={menu}
      title={when}
      accessibilityLabel={bubbleLabel(said.who, spokenText(text), said.at)}
      voiceActions={voice}
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

/** Who wrote a message, and its time of day. */
interface Said {
  readonly who: string;
  readonly at: string;
}

/** A bubble's corners (ui/Bubble.tsx), and a picture's or a file's (ui/Media.tsx): the shape it lifts in. */
const BUBBLE_RADIUS = metrics.radius;

/** A picture or a file in the thread; held, it lifts with Reply and Share. */
function MediaView({
  bubble,
  chatKey,
  mine,
  actions,
  when,
  target,
  tail,
  said,
}: {
  bubble: BubbleData;
  chatKey: Key;
  mine: boolean;
  actions: ThreadActions;
  when: string;
  target?: { id: string; part: number; who: string } | undefined;
  /** The burst's last: it has the tail (not lifted in the menu, as a bubble's). */
  tail: boolean;
  said: Said;
}) {
  const session = useSession();
  if (bubble.kind !== "image" && bubble.kind !== "file") return null;
  const menu: MenuItem[] = [
    ...(target === undefined ? [] : [{ label: "Reply", icon: "reply" as const, instant: true, onPress: () => actions.reply({ ...target, quote: bubble.kind === "image" ? `Photo: ${bubble.name}` : bubble.name }) }]),
    {
      label: "Share",
      icon: "share",
      presents: true,
      onPress: () =>
        void session.attachment(chatKey, bubble.attachmentId).then((a) => {
          if (a.ok) void shareFile(a.output).catch(() => undefined);
        }),
    },
  ];
  const view = (held: boolean) =>
    bubble.kind === "image" ? (
      <ImageBubble chatKey={chatKey} attachmentId={bubble.attachmentId} name={bubble.name} onOpen={held ? () => undefined : actions.openImage} side={mine ? "me" : "them"} tail={tail && !held} />
    ) : (
      <FileBubble chatKey={chatKey} attachmentId={bubble.attachmentId} name={bubble.name} mime={bubble.mime} bytes={bubble.bytes} mine={mine} tail={tail && !held} />
    );
  return (
    <HoldMenu
      items={menu}
      title={when}
      radius={BUBBLE_RADIUS}
      align={mine ? "right" : "left"}
      preview={view(true)}
      accessibilityLabel={bubbleLabel(said.who, bubble.kind === "image" ? `Photo, ${bubble.name}` : `File, ${bubble.name}`, said.at)}
    >
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
  when,
  fit,
  said,
}: {
  bubble: BubbleData;
  tail: boolean;
  canAnswer: boolean;
  chatKey: Key;
  actions: ThreadActions;
  target: { id: string; part: number; who: string } | undefined;
  when: string;
  /** The words take only their longest line's width: not while they still stream in. */
  fit: boolean;
  said: Said;
}) {
  const t = useTheme();
  switch (bubble.kind) {
    case "text":
      return (
        <HeldBubble
          actions={actions}
          mine={false}
          when={when}
          said={said}
          text={bubble.text}
          target={target}
          bubble={(withTail) =>
            jumbo(bubble.text) > 0 ? (
              <Jumbo side="them" text={bubble.text} count={jumbo(bubble.text)} />
            ) : (
              <Bubble side="them" tail={withTail && tail}>
                <Markdown text={bubble.text} ink={t.label} fit={fit} streaming={!fit} />
              </Bubble>
            )
          }
        />
      );
    case "image":
    case "file":
      return <MediaView bubble={bubble} chatKey={chatKey} mine={false} actions={actions} when={when} target={target} tail={tail} said={said} />;
    case "ask":
      return (
        <View style={styles.ask}>
          <Bubble side="them" tail={tail}>
            <Markdown text={bubble.question} ink={t.label} fit />
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
          <Grid header={bubble.columns.map(parseInline)} rows={bubble.rows.map((r) => r.map(parseInline))} ink={t.label} rule={t.separator} ground={t.surface} bleed={space.lg} />
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

/** Its lead saved or changed one of its skills: one quiet line, the skill's name in the accent, that opens it. */
function SkillLine({ saved, onPress }: { saved: SkillSaved; onPress: () => void }) {
  const t = useTheme();
  const what = saved.installed !== undefined ? "Installed a skill" : saved.created ? "Saved a skill" : "Updated a skill";
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`${what}: ${saved.name}. ${saved.why}`} accessibilityHint="Opens the skill" onPress={onPress} hitSlop={6} style={({ pressed }) => [styles.event, pressed && { opacity: PRESSED_OPACITY }]}>
      <Icon name="sparkles" size={13} color={t.secondary} />
      <Text style={[type.footnote, styles.eventText, styles.shrink, { color: t.secondary }]} numberOfLines={1}>
        {what}: <Text style={[styles.skillName, { color: t.link }]}>{saved.name}</Text>
      </Text>
    </Pressable>
  );
}

/** A bubble's words to select a part of, in a sheet, as chat apps' Select Text. */
function SelectText({ text, onClose }: { text: string | null; onClose: () => void }) {
  const t = useTheme();
  if (text === null) return null;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.fill, { backgroundColor: t.bg }]} onAccessibilityEscape={onClose}>
        <View style={styles.sheetHead}>
          <Text style={[type.headline, { color: t.label }]}>Select Text</Text>
          <Button label="Done" kind="plain" onPress={onClose} />
        </View>
        <TextInput
          value={text}
          selectionColor={t.accent}
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
  hidden: { opacity: 0 },
  list: { paddingHorizontal: metrics.margin, flexGrow: 1 },
  emptyThread: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.xl, transform: [{ scaleY: -1 }] },
  center: { textAlign: "center" },
  starters: { alignSelf: "stretch", gap: space.sm, marginTop: space.lg },
  starter: { borderRadius: 18, borderCurve: "continuous", paddingHorizontal: space.lg, paddingVertical: 12 },
  older: { paddingVertical: space.md },
  olderError: { paddingHorizontal: space.lg, textAlign: "center" },
  error: { position: "absolute", left: 0, right: 0, paddingHorizontal: space.lg, paddingVertical: space.xs, textAlign: "center" },
  bar: { position: "absolute", left: 12, right: 12, height: BAR_BUTTON, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 22 - BAR_BUTTON / 2 },
  barButton: { width: BAR_BUTTON, height: BAR_BUTTON, borderRadius: BAR_BUTTON / 2 },
  barHit: { flex: 1, alignItems: "center", justifyContent: "center" },
  titleGlass: { borderRadius: 22, borderCurve: "continuous" },
  title: { flexDirection: "row", alignItems: "center", gap: space.sm, maxWidth: 240, paddingLeft: 6, paddingRight: space.lg, paddingVertical: 5 },
  titleText: { flexShrink: 1 },
  timeRow: { alignItems: "center", marginTop: space.lg, marginBottom: space.xs },
  timeChip: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  unreadBar: { alignItems: "center", paddingVertical: 5, marginTop: space.md, marginHorizontal: -space.md },
  strong: { fontWeight: "600" },
  groupGap: { marginTop: metrics.burstGap },
  tightGap: { marginTop: metrics.gap },
  litRow: { borderRadius: 20 },
  me: { alignItems: "flex-end", paddingLeft: 56, gap: metrics.gap },
  mineRow: { flexDirection: "row", alignItems: "center", gap: space.sm, maxWidth: "100%" },
  mineBubble: { flexShrink: 1 },
  // Beside the bubble's foot, in the row's left margin: out of the layout.
  wait: { position: "absolute", right: "100%", bottom: 5, paddingRight: space.sm },
  note: { marginTop: 3, marginRight: 4, textAlign: "right", flexShrink: 1 },
  noteRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.sm, maxWidth: "100%" },
  them: { alignItems: "flex-start", paddingRight: 56, gap: metrics.gap },
  // In line with the words in the bubble under it.
  by: { marginLeft: metrics.padX, marginBottom: 1 },
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
  shrink: { flexShrink: 1 },
  skillName: { fontWeight: "600" },
  topEdge: { position: "absolute", top: 0, left: 0, right: 0 },
  topFade: { position: "absolute", top: 0, left: 0, right: 0 },
  bottomFade: { position: "absolute", bottom: 0, left: 0, right: 0 },
  dock: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "flex-end" },
  down: { position: "absolute", right: space.md },
  downButton: { width: 44, height: 44, borderRadius: 22 },
  downHit: { flex: 1, alignItems: "center", justifyContent: "center" },
  downCount: { position: "absolute", top: -6, alignSelf: "center", minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  downCountText: { fontWeight: "700" },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm },
  selectable: { flex: 1, paddingHorizontal: space.lg, paddingTop: space.sm },
});
