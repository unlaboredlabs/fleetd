// A project's lead chat, the app's main surface (lead-chat spec §1): the conversation with the project's lead,
// fleet activity quietly inside it (the live strip docked to the composer, PR and merge one-liners), the
// two inline items chat can't carry (a secret, a gated command), and the composer, which has the cursor as soon as
// the chat opens. Above the box, a line says what the lead waits on you for; an empty chat asks what to do. It opens
// where you stopped reading, under a "New" divider.
import { useCallback, useMemo, useState } from "react";
import { BubbleActionsContext, type BubbleActions, type ReplyTarget } from "./actions";
import { Button, FrameTitle, IdChip, StatusChip, Text, type StatusTone } from "../../ui";
import { STATE_WORDS } from "../status/rows";
import type { ProjectStateWord } from "../../src/data/selectors";
import { useData, useDataLayer } from "../../src/data/react";
import { selectNeedsYou } from "../../src/data/selectors";
import { seenOf } from "../../src/data/seen";
import { projectKey } from "../../src/data/store";
import { LiveStrip } from "../live";
import { AttentionLine } from "./Attention";
import { waitingOn } from "./attentionModel";
import { leadTurnSince, leadTurnUntil } from "./activity";
import { ChatList } from "./ChatList";
import { useChatData } from "./data";
import { EmptyChat } from "./EmptyChat";
import { arrivalsOf, chatRows, heldLabel, rowIndexOf, type Arrivals } from "./model";
import { ChatComposer } from "./Composer";
import { AgentsCapControl } from "../settings";
import type { ProjectRef } from "./slots";
import { useAsOfWords } from "../shell/offline";
import s from "./view.module.css";

const TONE: Readonly<Record<ProjectStateWord, StatusTone>> = { waiting_on_you: "needs-you", blocked: "failed", working: "working", idle: "idle" };

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
  const [opened, setOpened] = useState(() => ({ seen: seenOf(key), last: lastSeq }));
  if (opened.last === undefined && lastSeq !== undefined) setOpened({ ...opened, last: lastSeq });
  const seenSeq = opened.seen !== undefined && opened.last !== undefined && opened.last > opened.seen ? opened.seen : undefined;
  // What comes in from here on enters with motion; what the chat opens with, and what a reconnect reads back, doesn't.
  const live = view !== undefined && !view.held;
  const [arrived, setArrived] = useState<Arrivals>();
  if (view !== undefined && (arrived?.items !== view.items || arrived.live !== live)) {
    // Stamped as it comes in: a row mounted much later shows still.
    // eslint-disable-next-line react-hooks/purity
    setArrived(arrivalsOf(arrived, view.items, live, Date.now()));
  }
  const rows = useMemo(
    () =>
      view === undefined
        ? undefined
        : chatRows({
            items: view.items,
            hasOlder: view.hasOlder,
            loadingOlder: view.loadingOlder,
            held: view.held,
            offline: view.offline,
            // The live strip is docked to the composer, not a row of the conversation.
            strip: false,
            activity: data.leadWorking === true,
            workedSince,
            seenSeq,
            // "Today" is read against the clock when the chat changes; nothing ticks while it's idle.
            // eslint-disable-next-line react-hooks/purity
            nowMs: Date.now(),
          }),
    [view, data.leadWorking, workedSince, seenSeq],
  );
  const items = view?.items;
  const waiting = useMemo(
    // "asked at 09:02" (or "yesterday at …") is read when the chat changes; nothing ticks while it waits.
    // eslint-disable-next-line react-hooks/purity
    () => (needsYou === true && items !== undefined ? waitingOn(items, Date.now()) : undefined),
    [needsYou, items],
  );
  const recall = useMemo(() => items?.findLast((i) => i.author === "human" && i.text.trim() !== "")?.text, [items]);
  // Once you send, the chat follows the newest message instead.
  const target = shown?.id ?? (sent === 0 ? message : undefined);
  const newAt = sent === 0 ? rows?.findIndex((r) => r.kind === "new") : undefined;
  const openAt = rows === undefined ? undefined : target !== undefined ? rowIndexOf(rows, target) : newAt === -1 ? undefined : newAt;
  const empty = view !== undefined && view.items.length === 0 && !view.hasOlder;
  const state = data.state;
  const title = data.title ?? "";
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
    }),
    [project, waitedOn, onSent, layer, key, mark],
  );

  return (
    <div
      className={s.screen}
      data-screen={
        data.missing ? "chat.missing" : view !== undefined ? "chat" : data.loadError !== undefined ? "chat.error" : offline ? "chat.offline" : "chat.loading"
      }
    >
      <FrameTitle title={title || undefined}>
        {view?.held === true ? (
          // A held chat is as it was then, connected or not, until this connection's newest page lands; what the
          // lead is doing now isn't known from it.
          <StatusChip tone="quiet">{heldLabel(view.offline, asOf)}</StatusChip>
        ) : state ? (
          <StatusChip tone={TONE[state]}>{STATE_WORDS[state]}</StatusChip>
        ) : null}
        {data.missing ? null : <AgentsCapControl projectRef={project} />}
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
        <EmptyChat project={project} title={title} />
      ) : (
        <BubbleActionsContext.Provider value={actions}>
          <ChatList rows={rows} project={project} onLoadOlder={data.loadOlder} openAt={openAt} openSeq={shown?.n} openPart={shown?.part} sent={sent} entering={arrived?.entering} />
        </BubbleActionsContext.Provider>
      )}
      {data.missing ? null : (
        <div className={s.composer}>
          <AttentionLine
            waiting={waiting}
            // As the header chip: a held chat doesn't say what the project is now.
            blocked={view?.held === true ? undefined : data.blocked}
            which={showing >= 0 && targets !== undefined && targets.length > 1 ? `${String(showing + 1)} of ${String(targets.length)}` : undefined}
            onShow={showNext}
          />
          {strip ? <LiveStrip project={project} /> : null}
          <ChatComposer project={project} autoFocus recall={recall} onSent={onSent} replyTo={replyTo} onCancelReply={() => setReplyTo(undefined)} />
        </div>
      )}
    </div>
  );
}
