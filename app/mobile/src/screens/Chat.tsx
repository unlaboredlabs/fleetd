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
// Bubbles that arrive while you look glide in with the desktop's motion (ui/motion.ts, glide.ts). Messages written offline wait
// and go when the hub is back.
//
// With the project's tagged-chat trial on (chatTags.ts): a quiet line over a run of bubbles says who and which order,
// while two or more are open; a finished order is one line where it landed, which opens in place; tapping a tag's
// order narrows the chat to it under a glass capsule that closes it, and what you send there is about it; About… in a
// bubble's menu moves it to another open order, or to none.
//
// Smooth while a reply streams: each row draws again only when its own message changed (chatView.ts sameRow), so a
// streamed word redraws one bubble; the keyboard, the composer on it and the thread above it move together on the UI
// thread (react-native-keyboard-controller), following a finger that drags the keyboard down.
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackNavigationOptions, NativeStackScreenProps } from "@react-navigation/native-stack";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, AppState, findNodeHandle, FlatList, Linking, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ListViewToken } from "react-native";
import { KeyboardChatScrollView, KeyboardStickyView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { capsuleOf, findPinsShown } from "../messagePins";
import { arrivalsOf, ENTER_MS, rowKeyOf, type Arrival, type Arrivals } from "../arrivals";
import { aboutChoices, aboutOf, agentName, lensHides, openOrdersOf, sendAbout, tagOf, taggedItems, type ChatAbout, type OpenOrder, type Tag } from "../chatTags";
import { farFailure, farOpening, farStep, shownWindow, windowChat, aimOf, AT_NEWEST, attachmentBubbles, bubbleTime, cardOf, dayLine, arrivedSince, fullTime, holdFrom, landingOf, olderOffset, outgoing, partBubbles, quoteOf, replyOf, sameRow, seenSeq, sendNote, sendWait, streamingAt, viaNote, threadRows, type Bubble as BubbleData, type ThreadRow } from "../chatView";
import { chatItems, holds, wakeShown, type AttachmentRef, type ChatMessagePin, type BotState, type ChatItem, type CommandApprovalItem } from "../desktop";
import { useHub, useSession, type RootParams } from "../hubContext";
import { onHome } from "../split";
import { useBeside, useStrip } from "../ui/pane";
import { SheetRoom } from "../ui/StripRoom";
import { linkStatus } from "../link";
import { useHubWord } from "./linkHeader";
import { useCanStop } from "../stopProbe";
import { dispatchPrefs, usePrefs } from "../prefsStore";
import type { DraftReply } from "../drafts";
import { changeDraft } from "../draftsStore";
import { openingChat, refOf, type Key } from "../store";
import { waitsOnMe } from "../lists";
import { parseInline } from "../markdown";
import { space, type, useTheme, type Palette } from "../theme";
import { upload } from "../upload";
import { Avatar, type Pictured } from "../ui/Avatar";
import { useBot, useJustDone } from "../ui/botState";
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
import { bubbleIn, dur, ease, glide, PRESSED_OPACITY, useReduceMotion } from "../ui/motion";
import { glideOf } from "../glide";
import { SkeletonThread } from "../ui/Skeleton";
import { StateGlyph } from "../ui/StateGlyph";
import { StatusBarTap } from "../ui/StatusBarTap";
import { arrivedReplies, bubbleActions, bubbleLabel, spokenText } from "../spoken";
import { ApprovalCard, ApprovalOutcomeLine } from "./ApprovalCard";
import { ArtifactCard } from "./artifacts/ArtifactCard";
import { ImportCard } from "./vault/ImportCard";
import type { VaultImportCard } from "./vault/types";
import { linkTarget } from "./artifacts/model";
import { ScreenCards } from "./ScreenCards";
import { PIN_ROOM, PinCapsuleView, PinnedSheet } from "./PinnedMessages";
import { Symbol } from "./manage/parts";
import { machineName } from "./manage/model";
import type { SkillSaved } from "./manage/skillsModel";
import { setupLine } from "./setupChanged";
import { SetupChangedLine } from "./SetupChangedLine";
import { TURN_LINE_HEIGHT, TurnLine } from "./TurnLine";
import { WakeRow } from "./WakeRow";
import { wakeIn } from "../wake";
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
/**
 * Where the bar stands on a window with no top inset (the iPhone Duo unfolded): its buttons' middle 48 pt down, as the
 * native bars' there (measured).
 */
const BAR_TOP_BARE = 26;

/** Scrolled up further than this from the newest, the button down shows. */
const AWAY = 280;
/** How many rows a thread draws first (FlatList's own default). */
const INITIAL_ROWS = 10;

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
  /** The project's Info screen, where a setup change its lead made shows. */
  readonly openInfo: () => void;
  /** A tag's order tapped: the chat narrowed to it, from the bubble it was on (`from`), where closing it goes back to. */
  readonly lens: (about: ChatAbout, from: string | undefined) => void;
  /** About… on a bubble, in a tagged chat: moves its message to another open order or none; undefined with tags off. */
  readonly about: ((messageId: string, current: string | undefined) => void) | undefined;
  /** Pin or Unpin on a bubble, for everyone in the chat; undefined on a hub that doesn't keep pins. */
  readonly pin: ((messageId: string, on: boolean) => void) | undefined;
}

export function Chat({ navigation, route }: NativeStackScreenProps<RootParams, "Chat">) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const { state, session, paired } = useHub();
  const prefs = usePrefs();
  const chatKey = route.params.key;
  // Opened again after the app was closed: drawn where it was scrolled to from its first frame (cache.ts OpenChat).
  const [reopened] = useState(route.params.at);
  const insets = useSafeAreaInsets();
  // Beside the list (src/split.ts), a chat straight on Home has nothing to go back to: the list picks another.
  const beside = useBeside();
  const besideList = beside !== null && onHome(navigation.getState().routes, navigation.getState().routes.findIndex((r) => r.key === route.key));
  const project = state.projects?.[chatKey];
  const chatState = state.chatStates[chatKey];
  const chat = state.chats[chatKey] ?? openingChat(state.latest[chatKey]);
  const olderError = state.olderErrors[chatKey];
  const sends = state.sends[chatKey];
  // Opened at a message far back (a search hit, a pin): the page around it, until it joins the chat (chatView.ts FarWindow). Your
  // sends on their way are at the newest end, which it isn't.
  // A window still reading the page around its message isn't drawn: the chat stays as it was until the page comes.
  const opening = state.windows[chatKey];
  const win = shownWindow(opening);
  const items = useMemo(() => (win === undefined ? chatItems(chat, sends ?? []) : chatItems(windowChat(win), [])), [chat, sends, win]);
  // A window closed from here (back to the newest, a send, a jump), as against one that joined the chat as it was read on.
  const closing = useRef(false);
  const closeWindow = () => {
    closing.current = true;
    session.closeWindow(chatKey);
  };
  const pins = state.messagePins[chatKey];
  const capsule = useMemo(() => capsuleOf(pins), [pins]);
  const pinned = useMemo(() => new Set((pins ?? []).map((p) => p.messageId)), [pins]);
  const canPin = findPinsShown(state.hub);
  const [pinsOpen, setPinsOpen] = useState(false);
  const working = chatState?.leadWorking === true;
  // A cloud bot waking: shown from its start until its reply's first words do (wake.ts).
  const newest = items.at(-1);
  const writing = newest?.state === "streaming";
  const waking = wakeIn(state, chatKey, writing);
  const wake = win === undefined && wakeShown(waking) && !(writing && newest !== undefined && partBubbles(newest).length > 0) ? waking : undefined;
  const live = state.hub.phase === "live";
  // What was read when the chat opened: the unread bar stays there while it's open, as chat apps' does.
  // What was unread is what had come by then: a reply that comes while you look isn't.
  const [readAtOpen] = useState(() => prefs.read[chatKey]);
  const lastAtOpen = useRef<number | undefined>(undefined);
  if (lastAtOpen.current === undefined && chatState !== undefined) lastAtOpen.current = chatState.lastSeq;
  const unreadFrom = readAtOpen !== undefined && (lastAtOpen.current ?? 0) > readAtOpen ? readAtOpen : undefined;
  const worked = state.turnWorked[chatKey];
  // The tagged chat (chatTags.ts): off, the thread is as it always was.
  const tagsOn = project?.chatTags === true;
  const openOrders = useMemo(() => (tagsOn ? openOrdersOf(state.orders, chatKey) : NO_ORDERS), [tagsOn, state.orders, chatKey]);
  const [lensOn, setLens] = useState<ChatAbout | null>(null);
  const lens = tagsOn ? lensOn : null;
  const lensId = lens?.workstreamId;
  const me = state.me;
  const sendsAbout = useMemo(() => sendAbout(sends), [sends]);
  const shown = useMemo(() => (tagsOn ? taggedItems(items, { lens: lensId, sendAbout: sendsAbout }) : items), [tagsOn, items, lensId, sendsAbout]);
  // Lines show only while two or more orders are open.
  const showTags = tagsOn && openOrders.length >= 2;
  const tagFor = useMemo(() => (showTags ? (i: ChatItem) => tagOf(i, { show: true, me, lens: lensId }) : undefined), [showTags, me, lensId]);
  const rows = useMemo(() => threadRows(shown, worked, unreadFrom, undefined, tagFor), [shown, worked, unreadFrom, tagFor]);
  const newestFirst = useMemo(() => [...rows].reverse(), [rows]);
  // An ask's buttons answer only while nothing of yours came after it.
  const lastHuman = items.findLastIndex((i) => i.author === "human");
  const index = useMemo(() => new Map(items.map((i, n) => [i.id, n])), [items]);
  const title = project?.title ?? "Chat";
  // The iPhone Duo unfolded has no top inset (its status is a column at the right, `insets.right`), yet iOS lays its
  // own bars, the list's beside the chat among them, a status bar's height down: the chat's bar lines up with them.
  const barTop = insets.top > 0 ? insets.top : BAR_TOP_BARE;
  // Where the Duo has its control strip at the side (src/split.ts, ui/pane.ts useStrip), the thread and composer stay
  // out of it, and Back and Info go to iOS's own bar, which puts them in the strip under the status, where it puts every
  // bar's buttons in that pose: how far down the status reaches differs between poses, and only iOS knows it. Beside
  // the list, the chat touches only the right edge.
  const strip = useStrip();
  const stripLeft = strip?.left ?? 0;
  const stripRight = strip?.right ?? 0;
  const inStrip = strip !== undefined;
  const goBack = besideList ? undefined : () => navigation.goBack();
  // Where the thread starts under the bar (iOS draws it over the thread; Android's stack draws it above), and the pins'
  // and a lens's capsules under it.
  const barEnd = Platform.OS === "ios" ? barTop + BAR : 0;
  const pinRoom = capsule === undefined ? 0 : PIN_ROOM;
  const top = barEnd + pinRoom + (lens === null ? 0 : LENS_ROOM);
  // A message a jump goes to (a search hit, a push, a tapped quote) that the lens hides: the lens closed; true when it
  // was hidden.
  const showHidden = (messageId: string): boolean => {
    if (!tagsOn || !lensHides(items, messageId, { lens: lensId, sendAbout: sendsAbout })) return false;
    // The jump goes there, not back to where the lens was opened from.
    lensFrom.current = undefined;
    setLens(null);
    return true;
  };

  // Which bubbles enter with motion: what arrives while the chat is open and live (arrivals.ts).
  const arrivals = useRef<Arrivals | undefined>(undefined);
  const entering = useMemo(() => {
    // Not until its first page is in: what the chat opens with shows still.
    if (!chat.loaded) return new Map<string, { at: number; step: number }>();
    arrivals.current = arrivalsOf(arrivals.current, items, live, Date.now());
    return arrivals.current.entering;
  }, [items, live, chat.loaded]);
  // VoiceOver says each reply that comes in while you look, as Messages does.
  const heard = useRef(new Set<Arrival>());
  useEffect(() => {
    for (const said of arrivedReplies(heard.current, entering, items, title)) announce(said);
  }, [entering, items, title]);

  useEffect(() => {
    session.openChat(chatKey);
    return () => {
      session.openChat(null);
      // Opened again, it lands on the first unread or the newest, as ever.
      session.closeWindow(chatKey);
    };
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
  const quiet = project === undefined ? undefined : `on ${machineName(state.machines, project.machineId, paired.cloud === true)}`;
  const status = link?.busy === true ? (linkWord?.text ?? quiet) : link !== undefined ? "Offline" : working ? "Working…" : waitsOnMe(chatState, state.me) ? "Waiting for you" : quiet;
  // Its bot: done a moment after the lead's turn ends, as the desktop's chat title.
  const bot = useBot(chatKey, useJustDone(working));
  const openInfo = useCallback(() => navigation.navigate("ChatInfo", { screen: "Info", params: { key: chatKey } }), [navigation, chatKey]);
  // iOS's bar, in the Duo's side-strip poses only: its Back and Info in the strip, the title in it as on Android.
  useLayoutEffect(() => {
    if (Platform.OS !== "ios") return;
    navigation.setOptions(inStrip ? stripBar(t, () => <ChatTitle picture={project} bot={bot} title={title} status={status} busy={working && link === undefined} onPress={openInfo} />, openInfo) : { headerShown: false });
  }, [navigation, inStrip, t, title, status, working, link, project?.avatar, bot, openInfo]);
  // Android's stack draws the bar.
  useEffect(() => {
    if (Platform.OS === "ios") return;
    navigation.setOptions({
      headerTitle: () => <ChatTitle picture={project} bot={bot} title={title} status={status} busy={working && link === undefined} onPress={openInfo} />,
      title,
    });
    // A picture set or removed (here or on another device) draws the header again: its id is all that changes.
  }, [navigation, title, status, working, link, project?.avatar, bot, openInfo]);

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
  // Back to the newest from anywhere: from a window far back, the chat's own newest end comes in its place, at once.
  const backToNewest = () => {
    if (state.windows[chatKey] === undefined) return toNewest();
    closeWindow();
    setAwayFrom(null);
    setHeldAt(null);
    requestAnimationFrame(() => list.current?.scrollToOffset({ offset: newestEnd(), animated: false }));
  };

  const newestSeq = items.reduce((n, i) => Math.max(n, i.message?.seq ?? 0), 0);
  // Scrolled away from the newest end at all: the seq it was at. The rows hold still there (holdFrom), so a reply lands
  // under the view, and the button down shows to count it, however close to the end the reader is.
  const [heldAt, setHeldAt] = useState<number | null>(() => (reopened !== undefined && reopened.offset > AT_NEWEST ? newestSeq : null));
  // Scrolled away from the newest past AWAY: the seq it was at (where the hold started), so the button down counts what
  // came since.
  const [awayFrom, setAwayFrom] = useState<number | null>(() => (reopened !== undefined && reopened.offset > AWAY ? newestSeq : null));
  // In a window far back, the lead's messages that came since it opened count instead.
  const windowFrom = useRef<number | null>(null);
  if (win !== undefined) windowFrom.current ??= chatState?.lastSeq ?? newestSeq;
  // A window that joined the chat as it was read on: the rows keep their place as the chat's newer ones come in under
  // them, and the button down counts what came since it opened, as if the chat had been scrolled up to there.
  const hadWindow = useRef(false);
  const joining = hadWindow.current && win === undefined && !closing.current;
  hadWindow.current = win !== undefined;
  if (win === undefined) closing.current = false;
  // Closed, it counts from nothing: the next window starts its own.
  if (win === undefined && !joining) windowFrom.current = null;
  const heldFrom = win === undefined ? newestSeq : (windowFrom.current ?? newestSeq);
  const sinceWindow = useMemo(() => (win === undefined ? 0 : chat.messages.filter((m) => m.author !== "human" && m.seq > (windowFrom.current ?? Infinity)).length), [win, chat.messages]);
  const cameSince = win === undefined ? arrivedSince(items, awayFrom ?? heldAt) : sinceWindow;
  // Nothing new below while near the newest end: no button down, and what came in is read. A window far back is never
  // at the newest end.
  const atNewest = win === undefined && awayFrom === null && cameSince === 0;
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
    // In a window far back, the cache keeps the newest end: opened again, the chat lands as it always does.
    session.scrolledTo(chatKey, { offset: win !== undefined || y < AWAY / 3 ? 0 : Math.round(y) });
    if (y > AWAY && awayFrom === null) setAwayFrom(heldAt ?? heldFrom);
    else if (y < AWAY / 3 && awayFrom !== null) setAwayFrom(null);
    if (y > AT_NEWEST && heldAt === null) setHeldAt(heldFrom);
    else if (y <= AT_NEWEST && heldAt !== null) setHeldAt(null);
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
  const [placed, setPlaced] = useState(reopened !== undefined);
  const reading = placed && focused && active;
  const lastSeq = chatState?.lastSeq;
  useEffect(() => {
    if (reading && atNewest && lastSeq !== undefined && chat.loaded) dispatchPrefs({ t: "read", key: chatKey, seq: lastSeq });
  }, [reading, atNewest, lastSeq, chat.loaded, chatKey]);
  const onScreen = useRef<readonly ThreadRow[]>([]);
  const seen = useRef({ reading, chatKey, windowed: win !== undefined });
  seen.current = { reading, chatKey, windowed: win !== undefined };
  const readSeen = useCallback(() => {
    const seq = seenSeq(onScreen.current);
    if (seen.current.reading && seq !== undefined) dispatchPrefs({ t: "read", key: seen.current.chatKey, seq });
  }, []);
  // FlatList takes these once.
  const onViewable = useRef(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    onScreen.current = viewableItems.map((v) => v.item as ThreadRow);
    // What shows, for the cache: the thread opens on it again after the app is closed.
    const rows = viewableItems.reduce((n, v) => Math.max(n, (v.index ?? 0) + 1), 0);
    const seqs = onScreen.current.flatMap((r) => (r.t === "item" && r.item.message !== undefined ? [r.item.message.seq] : []));
    if (rows > 0 && !seen.current.windowed) session.scrolledTo(seen.current.chatKey, { rows, oldestSeq: seqs.length === 0 ? undefined : Math.min(...seqs) });
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
  // Opened again where it was left: it has landed already.
  const landed = useRef<string | null>(reopened === undefined ? null : `${messageId ?? ""} ${requestId ?? ""} ${String(tap ?? 0)}`);
  const [moving, setMoving] = useState(false);
  useLayoutEffect(() => {
    const wanted = `${messageId ?? ""} ${requestId ?? ""} ${String(tap ?? 0)}`;
    if (landed.current === wanted || !chat.loaded) return;
    // The page around it is on its way: landed on once it comes.
    if (messageId !== undefined && opening?.at === messageId && farOpening(opening)) return;
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
    // Outside the lens: shown first, then landed on as the thread draws again.
    if (found !== undefined && showHidden(found)) return;
    // Further back than the chat holds: the page around it is read, then landed on as it comes (chatView.ts). One that
    // can't be read lands nowhere, as one gone from the chat.
    const step = found === undefined ? "land" : farStep(chat, opening, found, items.some((i) => i.message?.messageId === found));
    // The chat's own messages have it, a window's don't: the window goes.
    if (step === "close") return closeWindow();
    if (step === "open" && found !== undefined) return void session.openAround(chatKey, found);
    if (step === "wait") return;
    if (step === "failed") {
      closeWindow();
      haptics.warning();
      Alert.alert("The message didn't open", farFailure(opening));
    }
    // Landed on in a window just read: drawn there at once, as the thread around it is new.
    const fresh = found !== undefined && win?.at === found;
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
    if (first || fresh) setMoving(true);
    setTimeout(() => {
      const there = () => {
        setMoving(false);
        setPlaced(true);
      };
      const find = (r: ThreadRow) => (target !== undefined ? r.t === "item" && r.item.message?.messageId === target : r.t === "unread");
      if (!scrollToRow(find, target !== undefined ? 0.5 : 1, !first && !fresh && !reduce, there)) there();
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
  // In a window far back every row keeps its place too, as newer pages come in under it.
  const held = holdFrom(heldAt !== null || awayFrom !== null || win !== undefined || joining, tall, streamAt);
  useEffect(() => {
    if (!joining) return;
    const from = windowFrom.current;
    if (from !== null) setHeldAt((h) => h ?? from);
  }, [joining]);
  const hold = useMemo(() => (held === undefined ? undefined : { minIndexForVisible: held }), [held]);
  // At the newest end the rows make room for a new bubble, or the reply growing, on its spring, as it rides up with
  // them. Not while held still: the list keeps its place there, and a row moving to its new place would slide.
  const spring = glideOf(newestFirst);
  const rowsGlide = useMemo(() => glide(spring), [spring]);

  // What you send shows at once, as in Messages, wherever the thread was scrolled to. The composer's words go as a
  // reply while its banner shows; a quick answer or a starter never does, and leaves the banner for what you type. In a
  // lens, it is about the lens's order.
  const send = (body: string, files: readonly AttachmentRef[] = [], reply?: DraftReply) => {
    const out = outgoing(body, files.length, reply);
    if (out === null) return;
    setAwayFrom(null);
    setHeldAt(null);
    // It goes at the newest end: a window far back makes way for it.
    const far = state.windows[chatKey] !== undefined;
    if (far) closeWindow();
    // In a frame, once the hold above is off: on, the list would keep its place as your message went in under it.
    requestAnimationFrame(() => {
      session.send(chatKey, out.text, { attachments: files, replyTo: out.replyTo, about: lensId });
      if (far) list.current?.scrollToOffset({ offset: newestEnd(), animated: false });
      else toNewest();
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
  const now = useRef({ items, title, send, scrollToRow, chatKey, openOrders, showHidden, closeWindow });
  now.current = { items, title, send, scrollToRow, chatKey, openOrders, showHidden, closeWindow };
  // A jump to a message that was hidden, or further back than the chat holds: made once the thread has drawn it (the
  // page around it read first, chatView.ts FarWindow). One that can't be read is said, and the thread stays where it was.
  const jumping = useRef<string | null>(null);
  useEffect(() => {
    const to = jumping.current;
    if (to === null) return;
    const far = opening?.at === to;
    if (far && farOpening(opening)) return;
    jumping.current = null;
    const there = () => setMoving(false);
    if (scrollToRow((r) => r.t === "item" && r.item.message?.messageId === to, 0.5, !far && !reduce, far ? there : undefined)) return void setLit(to);
    setMoving(false);
    if (!far) return;
    closeWindow();
    haptics.warning();
    Alert.alert("The message didn't open", farFailure(opening));
  });

  // A lens: on, the thread shows its order from the newest end; off, it goes back to the bubble whose tag opened it.
  const lensFrom = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lensId !== undefined) return void requestAnimationFrame(() => toNewest());
    const from = lensFrom.current;
    lensFrom.current = undefined;
    if (from !== undefined) requestAnimationFrame(() => now.current.scrollToRow((r) => r.t === "item" && r.item.message?.messageId === from, 0.5, false));
  }, [lensId]);
  const closeLens = () => {
    haptics.tap();
    setLens(null);
  };
  const actions = useMemo(
    (): ThreadActions => ({
      reply: (r) => {
        haptics.tap();
        changeDraft(now.current.chatKey, (d) => ({ ...d, reply: { id: r.id, part: r.part, who: r.who, quote: r.quote } }));
      },
      selectText: setSelecting,
      openImage: setImage,
      jumpTo: (messageId) => {
        if (now.current.scrollToRow((r) => r.t === "item" && r.item.message?.messageId === messageId, 0.5)) return setLit(messageId);
        if (now.current.showHidden(messageId)) return void (jumping.current = messageId);
        const key = now.current.chatKey;
        const chat = session.state.chats[key];
        jumping.current = messageId;
        // Held by the chat but not shown (a window is): the window goes, and the thread draws it.
        if (chat !== undefined && holds(chat, messageId)) return now.current.closeWindow();
        // Further back: hidden while the thread around it comes in, then drawn there at once.
        setMoving(true);
        void session.openAround(key, messageId);
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
      openInfo: () => {
        haptics.tap();
        navigation.navigate("ChatInfo", { screen: "Info", params: { key: now.current.chatKey } });
      },
      lens: (about, from) => {
        haptics.tap();
        lensFrom.current = from;
        setLens(about);
      },
      about: tagsOn
        ? (messageId, current) =>
            pickAbout(now.current.openOrders, current, (workstreamId) =>
              void session.retag(now.current.chatKey, messageId, workstreamId).then((r) => {
                if (r.ok) return;
                haptics.warning();
                Alert.alert("The message wasn't moved", r.error.message);
              }),
            )
        : undefined,
      pin: canPin
        ? (messageId, on) => {
            haptics.tap();
            void session.pinMessage(now.current.chatKey, messageId, on).then((r) => {
              if (r.ok) return announce(on ? "Pinned" : "Unpinned");
              haptics.warning();
              Alert.alert(on ? "The message wasn't pinned" : "The message wasn't unpinned", r.error.message);
            });
          }
        : undefined,
    }),
    [navigation, session, tagsOn, canPin],
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
        tags={showTags}
        lens={lensId}
        actions={actions}
        lit={row.t === "item" && row.item.message?.messageId !== undefined && row.item.message.messageId === lit}
        pinned={row.t === "item" && row.item.message !== undefined && pinned.has(row.item.message.messageId)}
        enter={row.t === "item" ? entering.get(rowKeyOf(row.item)) : undefined}
        reduce={reduce}
        onLayout={at === streamAt ? measureStream : row.t === "item" && hitId !== undefined && row.item.message?.messageId === hitId ? measureHit : undefined}
      />
    ),
    [chatKey, title, index, lastHuman, showTags, lensId, actions, lit, pinned, entering, reduce, streamAt, measureStream, hitId, measureHit],
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
  // A window's page that didn't come is said where the older ones would be, as theirs.
  const pageError = win === undefined ? olderError : opening?.error?.end === "around" ? undefined : opening?.error?.error;
  return (
    <View style={[styles.fill, { backgroundColor: t.thread }]}>
      <View style={[styles.fill, { marginLeft: stripLeft, marginRight: stripRight }]}>
        <RevealArea margin={metrics.margin}>
          <ArtifactLinks.Provider value={openLink}>
            <Animated.FlatList
              ref={list}
              inverted
              {...(reduce || hold !== undefined ? {} : { itemLayoutAnimation: rowsGlide })}
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
              // Opened again where it was left: there from its first frame, with every row down to the newest drawn.
              {...(reopened === undefined ? {} : { contentOffset: { x: 0, y: reopened.offset }, initialNumToRender: Math.max(INITIAL_ROWS, reopened.rows + 2) })}
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
              onEndReached={() => void (win === undefined ? session.loadOlder(chatKey) : session.pageWindow(chatKey, "older"))}
              // A window far back reads on towards the newest as it is scrolled down.
              {...(win === undefined ? {} : { onStartReached: () => void session.pageWindow(chatKey, "newer"), onStartReachedThreshold: 1 })}
              // Upside down too: the newest end, where its live screens sit over the composer.
              ListHeaderComponent={
                <View>
                  {win?.hasNewer === true ? <ActivityIndicator style={styles.older} color={t.secondary} /> : null}
                  {/* A cloud bot waking: its bot in the reply's place, under the newest message, until its words show. */}
                  {wake === undefined ? null : <WakeRow chatKey={chatKey} wake={wake} title={title} picture={project} />}
                  <ScreenCards chatKey={chatKey} />
                  {/* The composer's room and the turn line's over it, always: the thread never moves for the line. */}
                  <View style={{ height: composerHeight + TURN_BAND }} />
                </View>
              }
              {...(loading ? {} : { ListEmptyComponent: <EmptyThread picture={project} title={title} code={(project?.repos?.length ?? 0) > 0} onPick={(s) => send(s)} /> })}
              // The list is upside down: its footer is the top, under the clear header.
              ListFooterComponent={
                <View style={{ paddingTop: top + space.sm }}>
                  {loading && items.length === 0 ? (
                    <SkeletonThread />
                  ) : (win === undefined ? chat.loadingOlder : win.loadingOlder) ? (
                    <ActivityIndicator style={styles.older} color={t.secondary} />
                  ) : pageError !== undefined ? (
                    // Where the older messages would be: why they didn't come, and a tap reads them again.
                    <Pressable accessibilityRole="button" accessibilityHint="Reads them again" onPress={() => void (win === undefined ? session.loadOlder(chatKey) : session.pageWindow(chatKey, opening?.error?.end === "newer" ? "newer" : "older"))} style={styles.older}>
                      <Text style={[type.footnote, styles.olderError, { color: t.secondary }]}>
                        {`${win === undefined ? "Older messages" : "Messages"} didn't load. ${pageError.message} `}
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
            {inStrip ? null : (
              <ChatBar top={barTop} onBack={goBack} onInfo={openInfo}>
                <ChatTitle picture={project} bot={bot} title={title} status={status} busy={working && link === undefined} onPress={openInfo} />
              </ChatBar>
            )}
          </EdgeEffect>
        ) : null}
        {capsule === undefined ? null : (
          <View pointerEvents="box-none" style={[styles.lensRow, { top: barEnd + space.xs }]}>
            <PinCapsuleView capsule={capsule} onPress={() => (capsule.goesTo === undefined ? setPinsOpen(true) : actions.jumpTo(capsule.goesTo))} />
          </View>
        )}
        {lens === null ? null : (
          <View pointerEvents="box-none" style={[styles.lensRow, { top: barEnd + pinRoom + space.xs }]}>
            <LensCapsule about={lens} phase={openOrders.find((o) => o.workstreamId === lens.workstreamId)?.phaseDetail} onClose={closeLens} />
          </View>
        )}
        {/* The composer and what sits on it ride on the keyboard. */}
        <KeyboardStickyView offset={{ closed: 0, opened: lift }} style={styles.dock} pointerEvents="box-none">
          {chat.error === undefined ? null : <Text style={[type.footnote, styles.error, { color: t.danger, bottom: composerHeight + space.xs }]}>{chat.error.message}</Text>}
          {atNewest ? null : (
            // Its glass materializes rather than fading in: glass under an opacity below 1 doesn't draw (UIKit).
            <View style={[styles.down, { bottom: composerHeight + space.md }]}>
              <Glass interactive appear style={styles.downButton}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={cameSince > 0 ? `Scroll to the newest, ${String(cameSince)} new` : "Scroll to the newest"}
                  style={styles.downHit}
                  onPress={() => {
                    haptics.tap();
                    backToNewest();
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
          {/* What the lead is doing, on one line over the composer's left edge, in the room the thread keeps for it. */}
          <View pointerEvents="none" style={[styles.turnBand, { bottom: composerHeight - space.sm + TURN_GAP }]}>
            <TurnLine chatKey={chatKey} writing={items.at(-1)?.state === "streaming"} still={!focused} />
          </View>
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
              {...(lens === null ? {} : { placeholder: `Message about ${lens.title}` })}
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
      <PinnedSheet
        pins={pins ?? NO_PINS}
        open={pinsOpen}
        me={me}
        title={title}
        canUnpin={actions.pin !== undefined}
        onClose={() => setPinsOpen(false)}
        onGo={(messageId) => {
          setPinsOpen(false);
          // Once the sheet has gone down.
          setTimeout(() => actions.jumpTo(messageId), SHEET_GONE_MS);
        }}
        onUnpin={(messageId) => actions.pin?.(messageId, false)}
      />
      <ImageViewer image={image} onClose={() => setImage(null)} />
    </View>
  );
}

/** The turn line's gap over the composer's glass (the composer's own top inset is space.sm). */
const TURN_GAP = 6;
/** The room the thread keeps over the composer for the turn line, whether it shows or not: the newest message ends 10 pt over it. */
const TURN_BAND = TURN_LINE_HEIGHT + space.sm;

/** The room a lens's capsule takes under the bar, its gap under it included. */
const LENS_ROOM = 44;
const NO_ORDERS: readonly OpenOrder[] = [];
const NO_PINS: readonly ChatMessagePin[] = [];
/** How long a sheet takes to go down, before the thread under it moves. */
const SHEET_GONE_MS = 350;

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

/**
 * iOS's bar over the thread (chatOptions): glass back and Info buttons either side of the title, as the stack's own.
 * No `onBack` beside the list (src/split.ts), where the chat has nothing behind it: its room stays, the title centred.
 * Not in the Duo's side-strip poses, where iOS's own bar holds them (stripBar).
 */
function ChatBar({ top, onBack, onInfo, children }: { top: number; onBack: (() => void) | undefined; onInfo: () => void; children: ReactNode }) {
  return (
    <View style={[styles.bar, { top }]} pointerEvents="box-none">
      {onBack === undefined ? <View style={styles.barButton} /> : <BarButton label="Back" symbol="chevron.left" onPress={onBack} />}
      {children}
      <BarButton label="Info" symbol="info.circle" onPress={onInfo} />
    </View>
  );
}

/**
 * The chat's bar in the Duo's side-strip poses: iOS's own, see-through over the thread, the title capsule in it, its
 * Back and an Info button, which iOS stands in the strip under the status. Beside the list, App.tsx hides its Back.
 */
export const stripBar = (t: Palette, headerTitle: () => ReactNode, onInfo: () => void): NativeStackNavigationOptions => ({
  headerShown: true,
  headerTransparent: true,
  headerShadowVisible: false,
  headerTintColor: t.label,
  headerBackButtonDisplayMode: "minimal",
  headerTitle,
  unstable_headerRightItems: () => [{ type: "button", label: "Info", icon: { type: "sfSymbol", name: "info.circle" }, accessibilityLabel: "Info", onPress: onInfo }],
});

/** One of the bar's glass buttons. */
function BarButton({ label, symbol, onPress }: { label: string; symbol: "chevron.left" | "info.circle"; onPress: () => void }) {
  const t = useTheme();
  return (
    <Glass interactive style={styles.barButton}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} style={styles.barHit} onPress={onPress}>
        <Symbol ios={symbol} android={symbol === "info.circle" ? "info" : "arrow_back"} size={symbol === "info.circle" ? 26 : 24} color={t.label} />
      </Pressable>
    </Glass>
  );
}

/** The chat's name and how it is, in a glass capsule over the thread, as iOS 26's chat apps draw it. Tapped, its Info, as Messages'. */
function ChatTitle({ picture, bot, title, status, busy, onPress }: { picture: Pictured | undefined; bot: BotState | undefined; title: string; status: string | undefined; busy: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    // The glass gives the press its own response: no dimming, which glass doesn't draw under.
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={status === undefined ? title : `${title}, ${status}`} accessibilityHint="Shows the chat's info">
      <Glass interactive style={styles.titleGlass}>
        <View style={styles.title}>
          <Avatar name={title} size={30} picture={picture} bot={bot} />
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
  /** A tagged chat with two or more orders open: a message about several shows each bubble's order. */
  readonly tags: boolean;
  /** The order a lens is on: its name goes from the lines. */
  readonly lens: string | undefined;
  readonly actions: ThreadActions;
  readonly lit: boolean;
  /** Pinned for the chat: its menu says Unpin. */
  readonly pinned: boolean;
  readonly enter: { at: number; step: number } | undefined;
  readonly reduce: boolean;
  /** The reply streaming in, or the message the chat lands on: its height. */
  readonly onLayout: ((e: LayoutChangeEvent) => void) | undefined;
}

/** Draws again only when its own row changed: the thread's rows are made anew with each streamed word. */
const sameProps = (a: RowProps, b: RowProps): boolean =>
  a.chatKey === b.chatKey && a.title === b.title && a.canAnswer === b.canAnswer && a.tags === b.tags && a.lens === b.lens && a.actions === b.actions && a.lit === b.lit && a.pinned === b.pinned && a.enter === b.enter && a.reduce === b.reduce && a.onLayout === b.onLayout && sameRow(a.row, b.row);

const RowView = memo(function RowView({ row, chatKey, title, canAnswer, tags, lens, actions, lit, pinned, enter, reduce, onLayout }: RowProps) {
  const t = useTheme();
  const now = useNow();
  // Entering only as it mounts soon after it came: a row scrolled back to later shows still.
  const [motion] = useState(() => (enter !== undefined && Date.now() - enter.at < ENTER_MS ? enter : undefined));
  if (row.t === "day") {
    return (
      <View style={styles.timeRow} accessibilityRole="header">
        {/* Just the date, centred and quiet, as in Messages: no capsule or rule around it. */}
        <Text style={[type.caption, styles.strong, { color: t.secondary }]}>{dayLine(row.at, now)}</Text>
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
  const item = <ItemView item={row.item} side={row.side} first={row.first} tag={row.tag} tags={tags} lens={lens} chatKey={chatKey} title={title} canAnswer={canAnswer} actions={actions} pinned={pinned} />;
  const body =
    row.side === "center" ? (
      item
    ) : (
      <Revealed mine={row.side === "me"} time={bubbleTime(row.item.at, now)} worked={row.worked}>
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
        key={open.requestId}
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
  tag,
  tags,
  lens,
  chatKey,
  title,
  canAnswer,
  actions,
  pinned,
}: {
  item: ChatItem;
  side: "me" | "them" | "center";
  first: boolean;
  tag: Tag | undefined;
  tags: boolean;
  lens: string | undefined;
  chatKey: Key;
  title: string;
  canAnswer: boolean;
  actions: ThreadActions;
  pinned: boolean;
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
  const changed = setupLine(item.message);
  if (changed !== undefined && item.message !== undefined) return <SetupChangedLine chatKey={chatKey} messageId={item.message.messageId} line={changed} onOpen={actions.openInfo} />;
  const vaultImport = (item.message as { vaultImport?: VaultImportCard } | undefined)?.vaultImport;
  if (vaultImport !== undefined)
    return vaultImport.state === "open" ? (
      <View style={[styles.card, styles.groupGap]}>
        <ImportCard card={vaultImport} />
      </View>
    ) : (
      <ImportCard card={vaultImport} />
    );
  const published = item.message?.artifact;
  if (published !== undefined) return <ArtifactCard published={published} when={bubbleTime(item.at, now)} onPress={() => actions.openArtifact(published.name, published.version)} />;
  if (side === "center") return <Event text={item.text} />;

  const messageId = item.message?.messageId;
  const who = item.author === "human" ? "You" : item.author === "agent" ? agentName(item.message) : title;
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
        {tag === undefined ? null : <TagLine tag={tag} mine onLens={(about) => actions.lens(about, messageId)} />}
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
                about={messageId === undefined ? undefined : moreActions(actions, messageId, item.message, pinned)}
                onPress={
                  retry
                    ? () => {
                        haptics.tap();
                        session.resend(chatKey, item.id);
                      }
                    : undefined
                }
                bubble={
                  replied === undefined && jumbo(words) > 0 ? (
                    <Jumbo side="me" text={words} count={jumbo(words)} />
                  ) : (
                    <Bubble side="me">
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
            <MediaView bubble={b} chatKey={chatKey} mine actions={actions} when={when} said={said} target={messageId === undefined ? undefined : { id: messageId, part: 0, who }} about={messageId === undefined ? undefined : moreActions(actions, messageId, item.message, pinned)} />
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

  const parts = partBubbles(item);
  const streaming = item.state === "streaming";
  // Nothing written yet: the turn line over the composer says what the lead does.
  if (parts.length === 0 && files.length === 0 && streaming) return null;
  const about = messageId === undefined || streaming ? undefined : moreActions(actions, messageId, item.message, pinned);
  // A message about several orders: each bubble whose order differs from the one before says its own.
  const partAbout = (n: number) => (tags && item.message?.about === undefined ? item.message?.parts?.[n]?.about : undefined);
  const lensOn = (a: ChatAbout) => actions.lens(a, messageId);
  return (
    <View style={[styles.them, gap]}>
      {tag !== undefined ? (
        <TagLine tag={tag} mine={false} onLens={lensOn} />
      ) : first && item.author === "agent" ? (
        <Text style={[type.caption, styles.by, { color: t.secondary }]}>{agentName(item.message)}</Text>
      ) : null}
      {parts.map(({ bubble: b, part }, i) => {
        const own = partAbout(part);
        const before = i === 0 ? undefined : partAbout(parts[i - 1]?.part ?? 0);
        const says = i > 0 && own !== undefined && own.workstreamId !== before?.workstreamId && own.workstreamId !== lens ? own : undefined;
        return (
          <Fragment key={i}>
            {says === undefined ? null : <TagLine tag={{ key: says.workstreamId, endKey: says.workstreamId, who: undefined, order: says }} mine={false} onLens={lensOn} />}
            <BubbleView
              bubble={b}
              canAnswer={canAnswer}
              chatKey={chatKey}
              actions={actions}
              target={messageId === undefined || streaming ? undefined : { id: messageId, part: i, who }}
              about={about}
              fit={!streaming}
              when={when}
              said={said}
            />
          </Fragment>
        );
      })}
      {files.map((b, i) => (
        <MediaView key={`f${String(i)}`} bubble={b} chatKey={chatKey} mine={false} actions={actions} when={when} said={said} target={messageId === undefined ? undefined : { id: messageId, part: 0, who }} about={about} />
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

/** A text bubble that lifts with its menu when held: Reply, Copy, Select Text. */
function HeldBubble({
  bubble,
  text,
  mine,
  when,
  target,
  about,
  actions,
  onPress,
  said,
}: {
  bubble: ReactNode;
  text: string;
  mine: boolean;
  /** About… in a tagged chat (aboutAction). */
  about?: readonly MenuItem[] | undefined;
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
    ...(about ?? []),
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
      preview={bubble}
      onPress={onPress}
      accessibilityRole={onPress === undefined ? undefined : "button"}
      accessibilityHint={onPress === undefined ? undefined : "Sends it again"}
    >
      {bubble}
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
  about,
  said,
}: {
  bubble: BubbleData;
  chatKey: Key;
  mine: boolean;
  actions: ThreadActions;
  when: string;
  target?: { id: string; part: number; who: string } | undefined;
  about?: readonly MenuItem[] | undefined;
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
    ...(about ?? []),
  ];
  const view = (held: boolean) =>
    bubble.kind === "image" ? (
      <ImageBubble chatKey={chatKey} attachmentId={bubble.attachmentId} name={bubble.name} onOpen={held ? () => undefined : actions.openImage} />
    ) : (
      <FileBubble chatKey={chatKey} attachmentId={bubble.attachmentId} name={bubble.name} mime={bubble.mime} bytes={bubble.bytes} mine={mine} />
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
  canAnswer,
  chatKey,
  actions,
  target,
  about,
  when,
  fit,
  said,
}: {
  bubble: BubbleData;
  canAnswer: boolean;
  chatKey: Key;
  actions: ThreadActions;
  target: { id: string; part: number; who: string } | undefined;
  about: readonly MenuItem[] | undefined;
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
          about={about}
          bubble={
            jumbo(bubble.text) > 0 ? (
              <Jumbo side="them" text={bubble.text} count={jumbo(bubble.text)} />
            ) : (
              <Bubble side="them">
                <Markdown text={bubble.text} ink={t.label} fit={fit} streaming={!fit} />
              </Bubble>
            )
          }
        />
      );
    case "image":
    case "file":
      return <MediaView bubble={bubble} chatKey={chatKey} mine={false} actions={actions} when={when} target={target} about={about} said={said} />;
    case "ask":
      return (
        <View style={styles.ask}>
          <Bubble side="them">
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

/**
 * About… in a bubble's menu, in a tagged chat: it opens the choices in iOS's own sheet (an alert on Android) once the
 * menu has gone.
 */
const aboutAction = (actions: ThreadActions, messageId: string, message: ChatItem["message"]): readonly MenuItem[] | undefined => {
  const pick = actions.about;
  if (pick === undefined) return undefined;
  const current = aboutOf(message)?.workstreamId;
  return [{ label: "About…", icon: "tag", presents: true, onPress: () => pick(messageId, current) }];
};

/** A bubble's menu past Reply, Copy and Select Text: Pin or Unpin, then About… in a tagged chat. */
const moreActions = (actions: ThreadActions, messageId: string, message: ChatItem["message"], pinned: boolean): readonly MenuItem[] | undefined => {
  const pin = actions.pin;
  const pinItem: readonly MenuItem[] = pin === undefined ? [] : [{ label: pinned ? "Unpin" : "Pin", icon: pinned ? "unpin" : "pin", onPress: () => pin(messageId, !pinned) }];
  const all = [...pinItem, ...(aboutAction(actions, messageId, message) ?? [])];
  return all.length === 0 ? undefined : all;
};

/** The About… choices, the current one ticked; `go` with the order picked (undefined: Nothing), never with the current. */
const pickAbout = (open: readonly OpenOrder[], current: string | undefined, go: (workstreamId: string | undefined) => void): void => {
  const choices = aboutChoices(open, current);
  const labels = choices.map((c) => (c.current ? `✓ ${c.label}` : c.label));
  const chosen = (i: number) => {
    const c = choices[i];
    if (c !== undefined && !c.current) go(c.workstreamId);
  };
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions({ title: "About", options: [...labels, "Cancel"], cancelButtonIndex: labels.length }, chosen);
    return;
  }
  // Android's alert holds three buttons: every choice but the current, two at a time, then More.
  const others = choices.flatMap((c, i) => (c.current ? [] : [i]));
  const page = (from: number) => {
    const shown = others.slice(from, from + 2);
    const more = from + 2 < others.length;
    Alert.alert("About", undefined, [
      ...shown.map((i) => ({ text: choices[i]?.label ?? "", onPress: () => chosen(i) })),
      more ? { text: "More", onPress: () => page(from + 2) } : { text: "Cancel", style: "cancel" as const },
    ], { cancelable: true });
  };
  page(0);
};

/** The quiet line over a run of bubbles in a tagged chat: who, when it isn't you, and its order, which opens a lens on it. */
function TagLine({ tag, mine, onLens }: { tag: Tag; mine: boolean; onLens: (about: ChatAbout) => void }) {
  const t = useTheme();
  const order = tag.order;
  const words = (
    <Text style={[type.caption, { color: t.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>
      {tag.who ?? ""}
      {tag.who !== undefined && order !== undefined ? " · " : ""}
      {order === undefined ? "" : <Text style={styles.strong}>{order.title}</Text>}
    </Text>
  );
  return order === undefined ? (
    <View style={[styles.tag, mine && styles.tagMine]}>{words}</View>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tag.who === undefined ? order.title : `${tag.who}, ${order.title}`}
      accessibilityHint={`Shows only ${order.title}`}
      hitSlop={{ top: 8, bottom: 6, left: 8, right: 8 }}
      onPress={() => onLens(order)}
      style={({ pressed }) => [styles.tag, mine && styles.tagMine, pressed && { opacity: PRESSED_OPACITY }]}
    >
      {words}
    </Pressable>
  );
}

/** A lens's capsule under the bar: the order it shows and how it is going; tapped, the whole chat again. */
function LensCapsule({ about, phase, onClose }: { about: ChatAbout; phase: string | undefined; onClose: () => void }) {
  const t = useTheme();
  return (
    <Glass interactive appear style={styles.lensGlass}>
      <Pressable accessibilityRole="button" accessibilityLabel={phase === undefined ? about.title : `${about.title}, ${phase}`} accessibilityHint="Shows the whole chat" onPress={onClose} style={styles.lens}>
        <Text style={[type.subhead, styles.strong, styles.lensTitle, { color: t.label }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {about.title}
        </Text>
        {phase === undefined ? null : (
          <Text style={[type.footnote, styles.shrink, { color: t.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {phase}
          </Text>
        )}
        <Icon name="close" size={12} color={t.secondary} weight="bold" />
      </Pressable>
    </Glass>
  );
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
      <SheetRoom style={[styles.fill, { backgroundColor: t.bg }]} onAccessibilityEscape={onClose}>
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
      </SheetRoom>
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
  timeRow: { alignItems: "center", marginTop: space.lg + space.xs, marginBottom: space.sm },
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
  // In line with the words in the bubble under it, as an agent's name.
  tag: { marginLeft: metrics.padX, marginBottom: 1, maxWidth: "100%" },
  tagMine: { marginLeft: 0, marginRight: metrics.padX, alignSelf: "flex-end" },
  lensRow: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  lensGlass: { borderRadius: 18, borderCurve: "continuous", maxWidth: "88%" },
  lens: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 14, paddingRight: 12, height: 36 },
  lensTitle: { flexShrink: 0, maxWidth: 180 },
  skillName: { fontWeight: "600" },
  topEdge: { position: "absolute", top: 0, left: 0, right: 0 },
  topFade: { position: "absolute", top: 0, left: 0, right: 0 },
  bottomFade: { position: "absolute", bottom: 0, left: 0, right: 0 },
  dock: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "flex-end" },
  // Clear of the scroll-down button on the right.
  turnBand: { position: "absolute", left: space.md, right: space.md + 44 + space.sm },
  down: { position: "absolute", right: space.md },
  downButton: { width: 44, height: 44, borderRadius: 22 },
  downHit: { flex: 1, alignItems: "center", justifyContent: "center" },
  downCount: { position: "absolute", top: -6, alignSelf: "center", minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  downCountText: { fontWeight: "600" },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm },
  selectable: { flex: 1, paddingHorizontal: space.lg, paddingTop: space.sm },
});
