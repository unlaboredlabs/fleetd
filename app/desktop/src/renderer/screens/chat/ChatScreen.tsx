// A project's lead chat, the app's main surface (lead-chat spec §1): the conversation with the project's lead,
// fleet activity quietly inside it (the live strip under the lead's newest message, PR and merge one-liners), the
// two inline items chat can't carry (a secret, a gated command), and the composer, which has the cursor as soon as
// the chat opens. Above the box, a line says what the lead waits on you for; an empty chat asks what to do.
// "What T<n> was told" opens from the strip's lanes.
import { useCallback, useMemo, useState } from "react";
import type { AgentLane, ThreadRef } from "../../../shared/contracts";
import { Button, FrameTitle, IdChip, StatusChip, Text, Truncate, type StatusTone } from "../../ui";
import { STATE_WORDS } from "../status/rows";
import type { ProjectStateWord } from "../../src/data/selectors";
import { useData } from "../../src/data/react";
import { selectNeedsYou } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { LiveStrip } from "../live";
import { AttentionLine } from "./Attention";
import { waitingOn } from "./attention";
import { ChatList } from "./ChatList";
import { useChatData } from "./data";
import { EmptyChat } from "./EmptyChat";
import { chatRows, rowIndexOf } from "./model";
import { ChatComposer } from "./Composer";
import { AgentsCapControl } from "../settings";
import type { ProjectRef } from "./slots";
import { roleWords, type ToldWho } from "./told";
import { ToldPanel } from "./ToldPanel";
import s from "./view.module.css";

const TONE: Readonly<Record<ProjectStateWord, StatusTone>> = { waiting_on_you: "needs-you", blocked: "failed", working: "working", idle: "idle" };

export function ChatScreen({ project, message }: { project: ProjectRef; message?: string }) {
  const data = useChatData(project);
  const [sent, setSent] = useState(0);
  const [told, setTold] = useState<{ thread: ThreadRef; who: ToldWho; name: string }>();
  /** Show: the item the lead waits on, brought into view (again on each press). */
  const [shown, setShown] = useState<{ id: string; n: number }>();
  const needsYou = useData(selectNeedsYou(projectKey(project)));
  const view = data.view;
  const strip = (data.agents?.length ?? 0) > 0;
  const rows = useMemo(
    () =>
      view === undefined
        ? undefined
        : chatRows({
            items: view.items,
            hasOlder: view.hasOlder,
            loadingOlder: view.loadingOlder,
            hasNewer: view.hasNewer,
            loadingNewer: view.loadingNewer,
            strip,
            // "Today" is read against the clock when the chat changes; nothing ticks while it's idle.
            // eslint-disable-next-line react-hooks/purity
            nowMs: Date.now(),
          }),
    [view, strip],
  );
  const items = view?.items;
  const waiting = useMemo(
    // "asked at 09:02" (or "yesterday at …") is read when the chat changes; nothing ticks while it waits.
    // eslint-disable-next-line react-hooks/purity
    () => (needsYou === true && items !== undefined ? waitingOn(items, Date.now()) : undefined),
    [needsYou, items],
  );
  const recall = useMemo(() => items?.findLast((i) => i.author === "human" && i.text.trim() !== "")?.text, [items]);
  const target = shown?.id ?? message;
  const openAt = target === undefined || rows === undefined ? undefined : rowIndexOf(rows, target);
  const empty = view !== undefined && view.items.length === 0 && !view.hasOlder && !view.hasNewer;
  const state = data.state;
  const title = data.title ?? "";
  const { loadOlder, loadNewer, jumpToLatest } = data;
  const onLoadOlder = useCallback(() => loadOlder(), [loadOlder]);
  const onLoadNewer = useCallback(() => loadNewer(), [loadNewer]);
  const onSent = useCallback(() => {
    // Back to following the newest message.
    setShown(undefined);
    setSent((n) => n + 1);
  }, []);
  const onTold = useCallback(
    (lane: AgentLane) => {
      if (!lane.threadRef) return;
      const name = lane.taskId ?? "the agent";
      setTold({ thread: lane.threadRef, name, who: { project: title, role: roleWords(lane.role, lane.taskId) } });
    },
    [title],
  );

  return (
    <div className={s.screen} data-screen={data.missing ? "chat.missing" : view !== undefined ? "chat" : data.loadError !== undefined ? "chat.error" : "chat.loading"}>
      {/* In the window's top row: one header, not two. */}
      <FrameTitle>
        <span className={s.title}>{title ? <Truncate strong>{title}</Truncate> : null}</span>
        {state ? (
          <span className={s.flexNone}>
            <StatusChip tone={TONE[state]}>{STATE_WORDS[state]}</StatusChip>
          </span>
        ) : null}
        {data.missing ? null : <AgentsCapControl projectRef={project} />}
      </FrameTitle>
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
      ) : rows === undefined ? (
        <div className={s.loading}>
          <Text tone="quiet">{view === undefined && data.title !== undefined ? "Loading the conversation…" : "Loading…"}</Text>
        </div>
      ) : empty ? (
        <EmptyChat project={project} title={title}>
          {strip ? <LiveStrip project={project} onTold={onTold} /> : null}
        </EmptyChat>
      ) : (
        <ChatList
          rows={rows}
          project={project}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
          onJumpToLatest={jumpToLatest}
          onTold={onTold}
          openAt={openAt}
          openSeq={shown?.n}
          sent={sent}
        />
      )}
      {data.missing ? null : (
        <div className={s.composer}>
          <AttentionLine
            waiting={waiting}
            onShow={() => {
              const id = waiting?.target;
              if (id !== undefined) setShown((p) => ({ id, n: (p?.n ?? 0) + 1 }));
            }}
          />
          <ChatComposer project={project} autoFocus recall={recall} onSent={onSent} />
        </div>
      )}
      <ToldPanel open={told} projectRef={project} onClose={() => setTold(undefined)} />
    </div>
  );
}
