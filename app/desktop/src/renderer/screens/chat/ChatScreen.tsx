// A project's lead chat, the app's main surface (lead-chat spec §1): the conversation with the project's lead,
// fleet activity quietly inside it (PR and merge one-liners), the two inline items chat can't carry (a secret, a
// gated command), and the composer, which has the cursor as soon as the chat opens, with the live strip docked to its
// top. The top bar says what needs you after the title (what the lead waits on you for, a block, what there is to look
// at, a red main), and is just the title when nothing does; an empty chat asks what to do. It opens where you stopped
// reading, under a "New" divider. A Navi's chat is the same screen as an assistant's: its name in the box, an
// assistant's starters, and its settings (where its connections are) a click away in the title.
import { Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BubbleActionsContext, type BubbleActions, type ReplyTarget } from "./actions";
import { Button, FrameTitle, IdChip, StatusChip, Text } from "../../ui";
import { hubKey, useData, useDataLayer } from "../../src/data/react";
import { selectNeedsYou } from "../../src/data/selectors";
import { seenOf } from "../../src/data/seen";
import { projectKey } from "../../src/data/store";
import { Boundary } from "../../src/Boundary";
import { LiveStrip, useNow } from "../live";
import { AttentionLine } from "./Attention";
import { lookingAt, sameLooks, waitingOn, type LookAt } from "./attentionModel";
import { leadTurnSince, leadTurnUntil } from "./activity";
import { ChatList } from "./ChatList";
import { useChatData } from "./data";
import { EmptyChat } from "./EmptyChat";
import { arrivalsOf, chatRows, heldLabel, isMine, keepRows, rowIndexOf, type Arrivals, type Row } from "./model";
import { ChatComposer } from "./Composer";
import type { ProjectRef } from "./slots";
import { useAsOfWords } from "../shell/offline";
import { navigate } from "../shell/navigation";
import { isNavi } from "../navi/model";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import { useHubRole } from "../admin/role";
import s from "./view.module.css";

export function ChatScreen({ project, message }: { project: ProjectRef; message?: string }) {
  const data = useChatData(project);
  // Out of reach, between attempts or during one after a failure (not the first connect, which is loading).
  const offline = useData((d) => d.hub.phase === "retrying" || (d.hub.phase === "connecting" && d.hub.attempt > 0));
  const [sent, setSent] = useState(0);
  /**
   * Show: a message brought into view (again on each press). From the waiting line, what the lead waits on, with its
   * bubble and when, for the mark.
   */
  const [shown, setShown] = useState<{ id: string; n: number; part?: string | undefined; at?: number }>();
  const needsYou = useData(selectNeedsYou(projectKey(project)));
  const view = data.view;
  const asOf = useAsOfWords(view?.asOf);
  const strip = data.strip;
  const turnSince = useData((d) => leadTurnSince(d, projectKey(project)));
  const turnOver = useData((d) => leadTurnUntil(d, projectKey(project)) !== undefined);
  const workedSince = data.leadWorking !== true && turnOver ? turnSince : undefined;
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
            activity: data.leadWorking === true,
            workedSince,
            seenSeq,
            me,
            // "Today" is read against the clock when the chat changes; nothing ticks while it's idle.
            // eslint-disable-next-line react-hooks/purity
            nowMs: Date.now(),
          }),
    [view, data.leadWorking, workedSince, seenSeq, me],
  );
  // Rows that say what they said keep their object, so a streamed word draws its own row and not the whole list.
  const [kept, setKept] = useState<{ from?: readonly Row[] | undefined; rows?: readonly Row[] | undefined }>({});
  const next = kept.from === built ? kept : { from: built, rows: built === undefined ? undefined : keepRows(kept.rows, built) };
  if (next !== kept) setKept(next);
  const rows = next.rows;
  const items = view?.items;
  const older = view?.hasOlder === true;
  const openItems = useData((d) => d.chatStates[key]?.openItems);
  const waiting = useMemo(
    // "asked at 09:02" (or "yesterday at …") is read when the chat changes; nothing ticks while it waits.
    // eslint-disable-next-line react-hooks/purity
    () => (needsYou === true && items !== undefined ? waitingOn(items, { older, open: openItems }, Date.now(), undefined, me) : undefined),
    [needsYou, items, older, openItems, me],
  );
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
  const empty = view !== undefined && view.items.length === 0 && !view.hasOlder;
  const title = data.title ?? "";
  const summary = useData((d) => d.projects[key]);
  const navi = summary !== undefined && isNavi(summary);
  const who = navi && title !== "" ? title : undefined;
  const [replyTo, setReplyTo] = useState<ReplyTarget>();
  const onSent = useCallback(() => {
    // Back to following the newest message.
    setShown(undefined);
    setReplyTo(undefined);
    setSent((n) => n + 1);
  }, []);
  const layer = useDataLayer();
  const targets = waiting?.targets;
  const waitedOn = targets?.[0]?.id;
  const mark = useMemo(() => (shown?.at === undefined ? undefined : { ...shown, at: shown.at }), [shown]);
  // Which of the places it waits on Show went to last; -1 before the first press, or once that one is answered.
  const showing = mark === undefined || targets === undefined ? -1 : targets.findIndex((t) => t.id === mark.id && t.part === mark.part);
  const showNext = () => {
    const next = targets?.[(showing + 1) % targets.length];
    if (next === undefined) return;
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
    const at = Date.now();
    setShown((p) => ({ id: next.id, part: next.part, n: (p?.n ?? 0) + 1, at }));
    clear(next, false);
  };
  const dismissLook = () => {
    const next = looks[0];
    if (next !== undefined) clear(next, true);
  };
  const actions = useMemo(
    (): BubbleActions => ({
      project,
      waitedOn,
      send: (text) => {
        onSent();
        void layer.chat.send(key, { text });
      },
      reply: setReplyTo,
      show: (id) => setShown((p) => ({ id, n: (p?.n ?? 0) + 1 })),
      shown: mark,
      lookAt,
      seen,
    }),
    [project, waitedOn, onSent, layer, key, mark, lookAt, seen],
  );

  return (
    <div
      className={s.screen}
      data-screen={
        data.missing ? "chat.missing" : view !== undefined ? "chat" : data.loadError !== undefined ? "chat.error" : offline ? "chat.offline" : "chat.loading"
      }
    >
      <FrameTitle
        title={title || undefined}
        lead={summary === undefined || data.missing ? undefined : <ProjectAvatar project={summary} size={22} />}
        detail={
          data.missing ? undefined : (
            <AttentionLine
              waiting={waiting}
              // As the held chip says: a held chat doesn't say what the project is now.
              blocked={view?.held === true ? undefined : data.blocked}
              warning={view?.held === true ? undefined : data.warning}
              which={showing >= 0 && targets !== undefined && targets.length > 1 ? `${String(showing + 1)} of ${String(targets.length)}` : undefined}
              resume={view?.held === true ? undefined : data.usagePausedOn}
              onShow={showNext}
              looks={looks}
              onLook={showLook}
              onDismiss={dismissLook}
            />
          )
        }
      >
        {view?.held === true ? (
          // A held chat is as it was then, connected or not, until this connection's newest page lands; what the
          // lead is doing now isn't known from it.
          <span className={s.state}>
            <StatusChip tone="quiet">{heldLabel(view.offline, asOf)}</StatusChip>
          </span>
        ) : null}
        {navi && !data.missing ? (
          <Button
            variant="quiet"
            iconOnly
            aria-label={`${title || "Navi"}’s settings`}
            title={`${title || "Navi"}’s settings: its connections, memory and automations`}
            onClick={() => navigate({ id: "settings", tab: "projects", for: key })}
          >
            <Settings />
          </Button>
        ) : null}
      </FrameTitle>
      {view?.held === true && !view.offline && data.loadError !== undefined ? (
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
        <EmptyChat project={project} title={title} navi={navi} />
      ) : (
        <BubbleActionsContext.Provider value={actions}>
          <ChatList rows={rows} project={project} onLoadOlder={data.loadOlder} openAt={openAt} openSeq={shown?.n} openPart={shown?.part} sent={sent} entering={arrived?.entering} />
        </BubbleActionsContext.Provider>
      )}
      {data.missing ? null : (
        <div className={s.composer}>
          <ChatComposer
            project={project}
            autoFocus
            recall={recall}
            onSent={onSent}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(undefined)}
            who={who}
            top={
              strip ? (
                <Boundary part="the live strip">
                  <LiveStrip project={project} />
                </Boundary>
              ) : null
            }
          />
        </div>
      )}
    </div>
  );
}
