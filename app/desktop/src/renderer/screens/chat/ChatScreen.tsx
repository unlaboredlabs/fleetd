// A project's lead chat, the app's main surface (lead-chat spec §1): the conversation with the project's lead,
// fleet activity quietly inside it (the live strip under the lead's newest message, PR and merge one-liners), the
// two inline items chat can't carry (a secret, a gated command), and the composer. "What T<n> was told" opens from
// the strip's lanes.
import { useCallback, useMemo, useState } from "react";
import type { AgentLane, ThreadRef } from "../../../shared/contracts";
import { Button, FrameTitle, IdChip, StatusChip, Text, Truncate, type StatusTone } from "../../ui";
import { STATE_WORDS } from "../status/rows";
import type { ProjectStateWord } from "../../src/data/selectors";
import { ChatList } from "./ChatList";
import { useChatData } from "./data";
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
  const openAt = message === undefined || rows === undefined ? undefined : rowIndexOf(rows, message);
  const state = data.state;
  const title = data.title ?? "";
  const { loadOlder, loadNewer, jumpToLatest } = data;
  const onLoadOlder = useCallback(() => loadOlder(), [loadOlder]);
  const onLoadNewer = useCallback(() => loadNewer(), [loadNewer]);
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
      ) : (
        <ChatList
          rows={rows}
          project={project}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
          onJumpToLatest={jumpToLatest}
          onTold={onTold}
          openAt={openAt}
          sent={sent}
        />
      )}
      {data.missing ? null : (
        <div className={s.composer}>
          <ChatComposer project={project} onSent={() => setSent((n) => n + 1)} />
        </div>
      )}
      <ToldPanel open={told} projectRef={project} onClose={() => setTold(undefined)} />
    </div>
  );
}
