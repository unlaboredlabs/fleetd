// A project's lead chat, the app's main surface (lead-chat spec §1): the conversation with the project's lead, fleet
// activity quietly inside it (PR and merge one-liners), the two inline items chat can't carry (a secret, a gated
// command), and the composer, which has the cursor as soon as the chat opens. The composer floats as a glass island
// over the conversation, which runs on behind it and keeps clear of it at its end; in a band just over it, the island
// (what the lead does now, the agents at work, a red main as a dot; Island.tsx), and a capsule saying what needs you
// (what the lead waits on you for, a block, what there is to look at), shown only when something does.
// The conversation scrolls on under the window's top row too, where the chat's pill floats as a glass capsule: its
// picture and name, which opens and closes the project's panel (its agents, PRs, checklist and a way to its settings);
// an empty chat asks what to do. It opens where you stopped reading, under a "New" divider.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BubbleActionsContext, type BubbleActions, type ReplyTarget, type TagActions } from "./actions";
import { Button, FrameTitle, IdChip, StatusChip, Text, toast } from "../../ui";
import type { ChatAbout } from "../../../shared/contracts";
import { LensCapsule } from "./lens/Lens";
import { foldOrder } from "./lens/tags";
import { hubKey, useData, useDataLayer } from "../../src/data/react";
import { selectNeedsYou } from "../../src/data/selectors";
import { seenOf } from "../../src/data/seen";
import { projectKey } from "../../src/data/store";
import { Boundary } from "../../src/Boundary";
import { useNow } from "../live";
import { AttentionLine } from "./Attention";
import { lookingAt, sameLooks, waitingOn, type LookAt } from "./attentionModel";
import { hideWait, useHiddenWait } from "./hiddenWait";
import { leadLastTurnSince, leadLastTurnUntil, leadTurnUntil } from "./activity";
import { ChatList } from "./ChatList";
import { Island } from "./Island";
import { useChatData } from "./data";
import { EmptyChat } from "./EmptyChat";
import { arrivalsOf, chatRows, heldLabel, isMine, keepRows, rowIndexOf, type Arrivals, type Row } from "./model";
import { ChatComposer } from "./Composer";
import type { ProjectRef } from "./slots";
import { useAsOfWords } from "../shell/offline";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import { useJustDone } from "../projects/botState";
import { navigate } from "../shell/navigation";
import { usePanelHandle } from "../shell/panel";
import { useCommands } from "../palette";
import { display } from "../../../shared/shortcuts";
import { usePersonNames } from "../admin/names";
import { useHubRole } from "../admin/role";
import s from "./view.module.css";

/** The gap between the conversation's last row and the island's band, px (--space-2). */
const ISLAND_CLEAR = 8;

export function ChatScreen({ project, message }: { project: ProjectRef; message?: string }) {
  const data = useChatData(project);
  // Out of reach, between attempts or during one after a failure (not the first connect, which is loading).
  const offline = useData((d) => !d.fresh && (d.hub.phase === "retrying" || (d.hub.phase === "connecting" && d.hub.attempt > 0)));
  const [sent, setSent] = useState(0);
  /**
   * Show: a message brought into view (again on each press). From the waiting line, what the lead waits on, with its
   * bubble and when, for the mark.
   */
  const [shown, setShown] = useState<{ id: string; n: number; part?: string | undefined; at?: number }>();
  const needsYou = useData(selectNeedsYou(projectKey(project)));
  const view = data.view;
  const asOf = useAsOfWords(view?.asOf);
  const workedSince = useData((d) => leadLastTurnSince(d, projectKey(project)));
  const workedUntil = useData((d) => leadLastTurnUntil(d, projectKey(project)));
  const worked = useMemo(
    () => (workedSince === undefined || workedUntil === undefined ? undefined : { since: workedSince, until: workedUntil }),
    [workedSince, workedUntil],
  );
  // What you had seen when the chat opened, read before the sidebar marks it seen (a key per project remounts this),
  // and its newest seq once known: only messages already there then are new, never those arriving while it's open.
  const key = projectKey(project);
  const lastSeq = useData((d) => d.chatStates[key]?.lastSeq);
  const { hub } = useDataLayer();
  const [opened, setOpened] = useState(() => ({ seen: seenOf(hubKey(hub, key)), last: lastSeq }));
  if (opened.last === undefined && lastSeq !== undefined) setOpened({ ...opened, last: lastSeq });
  const seenSeq = opened.seen !== undefined && opened.last !== undefined && opened.last > opened.seen ? opened.seen : undefined;
  // What comes in from here on enters with motion; what the chat opens with, and what a reconnect reads back, doesn't.
  const live = view !== undefined && !view.held;
  const [arrived, setArrived] = useState<Arrivals>();
  // Whose messages are yours: in a chat the team shares, someone else's show their name.
  const me = useHubRole().me?.personId;
  const names = usePersonNames();
  // The tagged chat (the project's trial): tags name its open orders, closed ones fold, a lens shows one order.
  const tagsOn = useData((d) => d.projects[key]?.chatTags === true);
  const board = useData((d) => d.orders);
  const orders = useMemo(
    (): readonly ChatAbout[] =>
      tagsOn
        ? Object.values(board ?? {})
            .filter((o) => projectKey(o.projectRef) === key && o.state === "open")
            .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((o) => ({ workstreamId: o.workstreamId, title: o.title }))
        : [],
    [tagsOn, board, key],
  );
  /** The lens, and the message whose tag opened it: closing it goes back there. Never kept: a reload drops it. */
  const [looking, setLooking] = useState<{ about: ChatAbout; from: string }>();
  const lens = tagsOn ? looking?.about : undefined;
  const phase = useData((d) => (lens === undefined ? undefined : d.orders?.[lens.workstreamId]?.phaseDetail));
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const openItems = useData((d) => d.chatStates[key]?.openItems);
  const tags = useMemo(
    () =>
      tagsOn
        ? { named: orders.length >= 2, lens: lens?.workstreamId, opened: unfolded, openItems: new Set(openItems?.map((o) => o.messageId)) }
        : undefined,
    [tagsOn, orders, lens, unfolded, openItems],
  );
  if (view !== undefined && (arrived?.items !== view.items || arrived.live !== live)) {
    // Stamped as it comes in: a row mounted much later shows still.
    // eslint-disable-next-line react-hooks/purity
    setArrived(arrivalsOf(arrived, view.items, live, Date.now()));
  }
  const built = useMemo(
    () =>
      view === undefined
        ? undefined
        : chatRows({
            items: view.items,
            hasOlder: view.hasOlder,
            loadingOlder: view.loadingOlder,
            held: view.held,
            offline: view.offline,
            worked,
            seenSeq,
            me,
            names,
            tags,
            // "Today" is read against the clock when the chat changes; nothing ticks while it's idle.
            // eslint-disable-next-line react-hooks/purity
            nowMs: Date.now(),
          }),
    [view, worked, seenSeq, me, names, tags],
  );
  // Rows that say what they said keep their object, so a streamed word draws its own row and not the whole list.
  const [kept, setKept] = useState<{ from?: readonly Row[] | undefined; rows?: readonly Row[] | undefined }>({});
  const next = kept.from === built ? kept : { from: built, rows: built === undefined ? undefined : keepRows(kept.rows, built) };
  if (next !== kept) setKept(next);
  const rows = next.rows;
  const items = view?.items;
  const older = view?.hasOlder === true;
  const waiting = useMemo(
    // "asked at 09:02" (or "yesterday at …") is read when the chat changes; nothing ticks while it waits.
    // eslint-disable-next-line react-hooks/purity
    () => (needsYou === true && items !== undefined ? waitingOn(items, { older, open: openItems }, Date.now(), undefined, me) : undefined),
    [needsYou, items, older, openItems, me],
  );
  // Questions you hid stay off the bar until the lead asks in a newer message; the chat still waits on them.
  const hidden = useHiddenWait(key);
  const question = waiting?.question;
  const barWaiting = question !== undefined && question === hidden ? undefined : waiting;
  // Show to what isn't loaded yet (an approval pages back): older pages load until it is, or there are none.
  const away = shown !== undefined && items !== undefined && !items.some((i) => i.id === shown.id);
  // A page that failed stops it: no retrying in a loop.
  const loadOlder = data.loadOlder;
  const halted = view?.loadingOlder === true || view?.error !== undefined;
  useEffect(() => {
    if (away && older && !halted) loadOlder();
  }, [away, older, halted, loadOlder]);
  const recall = useMemo(() => items?.findLast((i) => isMine(i, me) && i.text.trim() !== "")?.text, [items, me]);
  // Once you send, the chat follows the newest message instead.
  const target = shown?.id ?? (sent === 0 ? message : undefined);
  const newAt = sent === 0 ? rows?.findIndex((r) => r.kind === "new") : undefined;
  const openAt = rows === undefined ? undefined : target !== undefined ? rowIndexOf(rows, target) : newAt === -1 ? undefined : newAt;
  // A jump to a message the tagged chat hides (a notification's, Show, a quote, a link to a card): out of a lens on
  // another order, or into the fold it is in, so the message has a row to open at. Once per jump: a fold you close
  // again, or a lens you open later, stays as you left it.
  const [jumped, setJumped] = useState<string>();
  const jump = target === undefined ? undefined : `${target} ${String(shown?.n ?? 0)}`;
  if (tags !== undefined && rows !== undefined && target !== undefined && jump !== jumped) {
    const item = rowIndexOf(rows, target) !== undefined ? undefined : items?.find((i) => i.id === target);
    const order = item === undefined ? undefined : foldOrder(item);
    if (rowIndexOf(rows, target) !== undefined) setJumped(jump);
    // Out of the lens first; the whole chat then shows whether it is folded too.
    else if (item !== undefined && looking !== undefined) setLooking(undefined);
    else if (item !== undefined) {
      setJumped(jump);
      if (order !== undefined && !unfolded.has(order)) setUnfolded(new Set(unfolded).add(order));
    }
  }
  const empty = view !== undefined && view.items.length === 0 && !view.hasOlder;
  const title = data.title ?? "";
  const summary = useData((d) => d.projects[key]);
  // Its bot: what the bar says, and done for a moment after the lead's turn ends.
  const turnUntil = useData((d) => leadTurnUntil(d, key));
  const skew = useData((d) => d.live.skewMs ?? 0);
  const justDone = useJustDone(turnUntil, skew);
  const held = view?.held === true;
  const bot = { needs: barWaiting !== undefined, blocked: !held && data.blocked !== undefined, done: justDone };
  const [replyTo, setReplyTo] = useState<ReplyTarget>();
  const onSent = useCallback(() => {
    // Back to following the newest message.
    setShown(undefined);
    setReplyTo(undefined);
    setSent((n) => n + 1);
  }, []);
  const layer = useDataLayer();
  // The island's room at the conversation's end: from its band's top to the screen's bottom, and a gap over it. The
  // band counts as tall whether anything floats in it or not, so only the pill growing with its words changes it: at
  // the end, the last message rides up with it (ChatList); scrolled up, nothing moves. The list's own box never
  // resizes. The pill's height and the room go on the stage as --island-h and --island-inset, for CSS by the island.
  const stage = useRef<HTMLDivElement>(null);
  const island = useRef<HTMLDivElement>(null);
  const [inset, setInset] = useState<number>();
  const [latestSlot, setLatestSlot] = useState<HTMLSpanElement | null>(null);
  const missing = data.missing;
  useLayoutEffect(() => {
    const st = stage.current;
    const el = island.current;
    if (st === null || el === null) return;
    const measure = () => {
      const pill = el.lastElementChild;
      if (!(pill instanceof HTMLElement)) return;
      st.style.setProperty("--island-h", `${String(pill.offsetHeight)}px`);
      // The band's own height, not as tall as it is now: the island's card opens upward over the conversation.
      const band = parseFloat(getComputedStyle(st).getPropertyValue("--island-band-h")) || 0;
      const room = st.clientHeight - (el.offsetTop + pill.offsetTop) + band + ISLAND_CLEAR;
      st.style.setProperty("--island-inset", `${String(room)}px`);
      setInset(room);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(st);
    return () => ro.disconnect();
  }, [missing]);
  const targets = waiting?.targets;
  const waitedOn = targets?.[0]?.id;
  const mark = useMemo(() => (shown?.at === undefined ? undefined : { ...shown, at: shown.at }), [shown]);
  // Which of the places it waits on Show went to last; -1 before the first press, or once that one is answered.
  const showing = mark === undefined || targets === undefined ? -1 : targets.findIndex((t) => t.id === mark.id && t.part === mark.part);
  const showNext = () => {
    const next = targets?.[(showing + 1) % targets.length];
    if (next === undefined) return;
    // What it waits on may be about another order: the whole chat shows it.
    setLooking(undefined);
    const at = Date.now();
    setShown((p) => ({ id: next.id, part: next.part, n: (p?.n ?? 0) + 1, at }));
  };
  // What there is to look at: the hub's waiting nudges, less what this chat cleared since (until the hub says so too),
  // and those a day old, read as the minute turns.
  const nudges = useData((d) => d.chatStates[key]?.nudges);
  const [cleared, setCleared] = useState<ReadonlySet<string>>(() => new Set());
  // Asked of the hub once each: a message in view says it is seen on every observer step until it re-renders.
  const asked = useRef(new Set<string>());
  const minute = useNow(nudges !== undefined, 60_000);
  const read = useMemo(() => lookingAt(nudges, items, cleared, minute), [nudges, items, cleared, minute]);
  // The same list while it says the same: a streamed word changes `items`, and a new list would make new bubble
  // actions and draw every bubble again, on every word.
  const [looks, setLooks] = useState(read);
  if (looks !== read && !sameLooks(looks, read)) setLooks(read);
  const lookAt = useMemo(() => new Set(looks.map((l) => l.id)), [looks]);
  // By the flag's key, not its message: one the lead flags again after you saw it shows again.
  const clear = useCallback(
    (look: LookAt, dismissed: boolean) => {
      const key = look.key;
      if (asked.current.has(key)) return;
      asked.current.add(key);
      setCleared((c) => new Set(c).add(key));
      void layer.call("chat_nudge_clear", { projectRef: project, messageId: look.id, ...(dismissed ? { dismissed } : {}) }).then((out) => {
        // Still waiting on the hub: it shows again.
        if (out.ok) return;
        asked.current.delete(key);
        setCleared((c) => {
          const left = new Set(c);
          left.delete(key);
          return left;
        });
      });
    },
    [layer, project],
  );
  const seen = useCallback(
    (id: string) => {
      const look = looks.find((l) => l.id === id);
      if (look !== undefined) clear(look, false);
    },
    [looks, clear],
  );
  // Show goes to the oldest and marks it; going there is seeing it.
  const showLook = () => {
    const next = looks[0];
    if (next === undefined) return;
    setLooking(undefined);
    const at = Date.now();
    setShown((p) => ({ id: next.id, part: next.part, n: (p?.n ?? 0) + 1, at }));
    clear(next, false);
  };
  const dismissLook = () => {
    const next = looks[0];
    if (next !== undefined) clear(next, true);
  };
  const closeLens = useCallback(() => {
    const from = looking?.from;
    setLooking(undefined);
    // Back to the whole chat where the lens was opened from.
    if (from !== undefined) setShown((p) => ({ id: from, n: (p?.n ?? 0) + 1 }));
  }, [looking]);
  const tagActions = useMemo(
    (): TagActions | undefined =>
      tagsOn
        ? {
            named: orders.length >= 2,
            lens: lens?.workstreamId,
            open: orders,
            look: (about, from) => {
              setShown(undefined);
              setLooking({ about, from });
            },
            retag: (messageId, workstreamId) => {
              void layer.chat.retag(key, messageId, workstreamId).then((error) => {
                if (error !== undefined) toast({ title: "Couldn’t move the message", description: error.message, key: `retag:${messageId}` });
              });
            },
            toggleFold: (id) =>
              setUnfolded((was) => {
                const next = new Set(was);
                if (!next.delete(id)) next.add(id);
                return next;
              }),
          }
        : undefined,
    [tagsOn, orders, lens, layer, key],
  );
  // Esc closes the lens, unless something in the chat took it first (a reply over the box) or the focus is elsewhere.
  const screen = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (lens === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      const at = document.activeElement;
      if (e.key !== "Escape" || e.defaultPrevented || (at !== null && at !== document.body && screen.current?.contains(at) !== true)) return;
      e.preventDefault();
      closeLens();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lens, closeLens]);
  const actions = useMemo(
    (): BubbleActions => ({
      project,
      waitedOn,
      skips: question,
      send: (text) => {
        onSent();
        void layer.chat.send(key, { text });
      },
      reply: setReplyTo,
      show: (id) => setShown((p) => ({ id, n: (p?.n ?? 0) + 1 })),
      shown: mark,
      lookAt,
      seen,
      tags: tagActions,
    }),
    [project, waitedOn, question, onSent, layer, key, mark, lookAt, seen, tagActions],
  );

  const panel = usePanelHandle();
  // Its settings left the top bar for the panel's tab row; ⌘K reaches them from anywhere in the chat too.
  const settingsShown = summary !== undefined && !data.missing;
  useCommands(
    [
      {
        id: "chat.projectSettings",
        title: "Settings for this project",
        detail: "Its connections, sign-ins, approvals and memory",
        group: "actions",
        keywords: ["preferences", "configure"],
        enabled: () => settingsShown,
        run: () => navigate({ id: "settings", tab: "projects", for: key }),
      },
    ],
    [],
  );
  // A red main: the island's dot, its reason in the island's card. The train keeps merging, so it is no block.
  const warning = view?.held === true ? undefined : data.warning;
  const notice = view?.held === true && !view.offline && data.loadError !== undefined;
  const under = !data.missing && rows !== undefined && !empty && !notice;

  return (
    <div
      ref={screen}
      className={s.screen}
      // The conversation scrolls on under the top row's glass and leaves its room itself; anything else starts below.
      data-under={under || undefined}
      data-screen={
        data.missing ? "chat.missing" : view !== undefined ? "chat" : data.loadError !== undefined ? "chat.error" : offline ? "chat.offline" : "chat.loading"
      }
    >
      <FrameTitle
        glass
        title={title || undefined}
        lead={summary === undefined || data.missing ? undefined : <ProjectAvatar project={summary} size={24} own={bot} />}
        press={
          summary === undefined || data.missing || panel === null
            ? undefined
            : {
                onPress: panel.toggle,
                pressed: panel.shown,
                label: `${title}: ${panel.shown ? "hide" : "show"} its agents, PRs and checklist`,
                tip: `${panel.shown ? "Hide" : "Show"} agents, PRs and checklist · ${display("panel.toggle", window.fleetd.platform)}`,
                opens: "panel",
                controls: "project-panel",
              }
        }
      >
        {lens === undefined ? null : <LensCapsule about={lens} phase={phase} onClose={closeLens} />}
      </FrameTitle>
      {notice ? (
        // Connected, but this chat's newest page couldn't be read: it stays marked as last known, with why.
        <div className={s.notice} role="alert">
          <Text size="sm" tone="danger">
            Couldn’t load the newest messages.
          </Text>
          <IdChip label="Details" id={data.loadError.message} kind="error" size="xs" tone="quiet" />
          <Button variant="secondary" onClick={data.retry}>
            Retry
          </Button>
        </div>
      ) : null}
      <div ref={stage} className={s.stage}>
        {data.missing ? (
          <div className={s.loading} role="status">
            <Text tone="quiet">This project isn’t on the hub. It may have been removed.</Text>
          </div>
        ) : rows === undefined && data.loadError !== undefined ? (
          <div className={s.loading} role="alert">
            <Text tone="quiet">Couldn’t load the conversation.</Text>
            <IdChip label="Details" id={data.loadError.message} kind="error" size="xs" tone="quiet" />
            <Button variant="secondary" onClick={data.retry}>
              Retry
            </Button>
          </div>
        ) : rows === undefined && offline ? (
          <div className={s.loading} role="status">
            <Text tone="quiet">Offline. The conversation shows once you’re connected.</Text>
          </div>
        ) : rows === undefined ? (
          <div className={s.loading}>
            <Text tone="quiet">{view === undefined && data.title !== undefined ? "Loading the conversation…" : "Loading…"}</Text>
          </div>
        ) : empty ? (
          <EmptyChat project={project} title={title} />
        ) : (
          <BubbleActionsContext.Provider value={actions}>
            <ChatList key={lens?.workstreamId ?? ""} rows={rows} project={project} under={under} onLoadOlder={data.loadOlder} openAt={openAt} openSeq={shown?.n} openPart={shown?.part} sent={sent} entering={arrived?.entering} inset={inset} latestSlot={latestSlot} />
          </BubbleActionsContext.Provider>
        )}
        <div className={s.fade} aria-hidden />
        {data.missing ? null : (
          // The island: the band, where the island and what needs you float, over the pill. Drawn over the
          // conversation by design (data-floats, for the QA checks).
          <div ref={island} className={s.island} data-floats="">
            <div className={s.band} data-band="">
              <Boundary part="the island">
                <Island project={project} warning={warning} />
              </Boundary>
              <span className={s.say} data-say="">
                {view?.held === true ? <StatusChip tone="quiet">{heldLabel(view.offline, asOf)}</StatusChip> : null}
                <AttentionLine
                  waiting={barWaiting}
                  // As the held chip says: a held chat doesn't say what the project is now.
                  blocked={view?.held === true ? undefined : data.blocked}
                  which={showing >= 0 && targets !== undefined && targets.length > 1 ? `${String(showing + 1)} of ${String(targets.length)}` : undefined}
                  resume={view?.held === true ? undefined : data.usagePausedOn}
                  onShow={showNext}
                  looks={looks}
                  onLook={showLook}
                  onDismiss={dismissLook}
                  onHide={question === undefined ? undefined : () => hideWait(key, question)}
                />
              </span>
              {/* Latest ↓, while scrolled up: at the band's end, the strip giving way to it. */}
              <span ref={setLatestSlot} className={s.latestSlot} />
            </div>
            <ChatComposer
              project={project}
              autoFocus
              recall={recall}
              onSent={onSent}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(undefined)}
              about={lens}
            />
          </div>
        )}
      </div>
    </div>
  );
}
