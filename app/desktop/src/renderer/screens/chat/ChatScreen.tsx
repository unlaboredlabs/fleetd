// A project's lead chat, the app's main surface (lead-chat spec §1): the conversation with the project's lead,
// fleet activity quietly inside it (the live strip under the lead's newest message, PR and merge one-liners), the
// two inline items chat can't carry (a secret, a gated command), and the composer. "What T<n> was told" opens from
// the strip's lanes.
import { useCallback, useMemo, useState } from "react";
import type { AgentLane, ThreadRef } from "../../../shared/contracts";
import { StatusChip, Text, Truncate, type StatusTone } from "../../ui";
import { ChatList } from "./ChatList";
import { useChatData } from "./data";
import { chatRows, rowIndexOf } from "./model";
import { ChatComposer } from "./Composer";
import { AgentsCapControl } from "../settings";
import type { ProjectRef } from "./slots";
import { roleWords, type ToldWho } from "./told";
import { ToldPanel } from "./ToldPanel";
import s from "./view.module.css";

function stateWord(needsYou: boolean | undefined, working: boolean | undefined): { word: string; tone: StatusTone } | undefined {
  if (needsYou === true) return { word: "waiting on you", tone: "needs-you" };
  if (working === true) return { word: "working", tone: "working" };
  if (needsYou === false && working === false) return { word: "idle", tone: "idle" };
  return undefined;
}

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
            strip,
            // "Today" is read against the clock when the chat changes; nothing ticks while it's idle.
            // eslint-disable-next-line react-hooks/purity
            nowMs: Date.now(),
          }),
    [view, strip],
  );
  const openAt = message === undefined || rows === undefined ? undefined : rowIndexOf(rows, message);
  const state = stateWord(data.needsYou, data.leadWorking);
  const title = data.title ?? "";
  const { loadOlder } = data;
  const onLoadOlder = useCallback(() => loadOlder(), [loadOlder]);
  const onTold = useCallback(
    (lane: AgentLane) => {
      if (!lane.threadRef) return;
      const name = lane.taskId ?? "the agent";
      setTold({ thread: lane.threadRef, name, who: { project: title, role: roleWords(lane.role, lane.taskId) } });
    },
    [title],
  );

  return (
    <div className={s.screen} data-screen={view === undefined ? "chat.loading" : "chat"}>
      <header className={s.header}>
        <span className={s.title}>{title ? <Truncate strong>{title}</Truncate> : null}</span>
        {state ? (
          <span className={s.flexNone}>
            <StatusChip tone={state.tone}>{state.word}</StatusChip>
          </span>
        ) : null}
        <AgentsCapControl projectRef={project} />
      </header>
      {rows === undefined ? (
        <div className={s.loading}>
          <Text tone="quiet">{view === undefined && data.title !== undefined ? "Loading the conversation…" : "Loading…"}</Text>
        </div>
      ) : (
        <ChatList rows={rows} project={project} onLoadOlder={onLoadOlder} onTold={onTold} openAt={openAt} sent={sent} />
      )}
      <div className={s.composer}>
        <ChatComposer project={project} onSent={() => setSent((n) => n + 1)} />
      </div>
      <ToldPanel open={told} projectRef={project} onClose={() => setTold(undefined)} />
    </div>
  );
}
