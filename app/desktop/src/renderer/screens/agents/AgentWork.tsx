// One agent's live work, read-only: what it is on, what it is doing now, and its newest steps (what it wrote, what it
// ran and edited), with the message it is writing streaming in at the end. Under it, a box steers it directly. Its
// head opens what it was told at its start: its first message and the prompts it pinned.
import { useMemo, useState } from "react";
import type { WorkStep } from "../../../shared/contracts";
import { useAgentWork, useData } from "../../src/data/react";
import { selectLiveAgent, selectLiveAgents } from "../../src/data/selectors";
import { Button, cx, EmptyState, Markdown, PROFILE_LINE, ROLE_WORD, RoleTag, Text, Truncate, VirtualList } from "../../ui";
import { roleWords } from "../chat/told";
import { ToldPanel } from "../chat/ToldPanel";
import { ActivityLine, MiddleCut } from "../live/parts";
import { SteerBox } from "../live/Steer";
import { describe, isRunning } from "../live/words";
import { navigate } from "../shell/navigation";
import { panelRoute } from "../shell/routes";
import { Elapsed } from "./AgentsPane";
import { actionLine } from "./model";
import s from "./agents.module.css";

type FeedItem = WorkStep | { readonly kind: "writing"; readonly id: string; readonly text: string };

export function AgentWork({ id }: { id: string }) {
  const agent = useData(selectLiveAgent(id));
  const listed = useData((st) => selectLiveAgents(st) !== undefined);
  const fresh = useData((st) => st.fresh);
  const work = useAgentWork(agent);
  const [told, setTold] = useState(false);
  const row = agent?.row;
  // The message being written shows only while the agent writes; once it ends, its thread's event reads it in.
  const writing = row?.live?.activity?.activity.kind === "writing" ? work.streaming : undefined;
  const feed = useMemo((): readonly FeedItem[] | undefined => {
    if (work.steps === undefined) return undefined;
    return writing === undefined || writing.text === "" ? work.steps : [...work.steps, { kind: "writing", id: `w:${writing.messageId}`, text: writing.text }];
  }, [work.steps, writing]);

  if (!listed) {
    // Nothing held and no hub to ask: a blank pane would read as loading that never ends.
    return fresh ? (
      <div className={s.workBody} aria-busy="true" />
    ) : (
      <div className={cx(s.workBody, s.note)} data-screen="agents.work.offline">
        <Text tone="quiet">This agent shows once you’re connected.</Text>
      </div>
    );
  }
  if (agent === undefined || row === undefined) {
    return (
      <div className={s.workBody} data-screen="agents.work">
        <EmptyState title="This agent isn’t running now">It finished, or the lead stopped it. The chat says how it went.</EmptyState>
      </div>
    );
  }
  const pr = row.pr;
  const thread = row.threadRef;

  return (
    <section className={s.workBody} aria-label={`What ${row.title} is doing`} data-screen="agents.work">
      <div className={s.workHead}>
        <Text as="h2" strong>
          {row.title}
        </Text>
        <span className={s.meta}>
          <RoleTag role={row.role} />
          {row.profile === undefined ? null : (
            <Text size="xs" tone="quiet">
              {PROFILE_LINE[row.profile]}
            </Text>
          )}
          {pr !== undefined ? (
            <Button variant="quiet" size="sm" onClick={() => navigate(panelRoute(row.projectRef, { tab: "prs", pr: { repo: pr.repo, number: pr.number } }))}>
              {`PR #${String(pr.number)}`}
            </Button>
          ) : null}
          {thread !== undefined ? (
            <Button variant="quiet" size="sm" onClick={() => setTold(true)}>
              What it was told
            </Button>
          ) : null}
          <Elapsed startedAt={row.startedAt} running={isRunning(row.status)} />
        </span>
        <ActivityLine line={describe(row)} />
      </div>
      <div className={s.feed}>
        {!work.hasThread ? (
          <Text size="sm" tone="quiet">
            It hasn’t started yet.
          </Text>
        ) : work.error !== null && feed === undefined ? (
          <p role="alert">
            <Text size="sm" tone="danger">
              Couldn’t read its work. The agent keeps going; this reads again at its next step.
            </Text>
          </p>
        ) : feed === undefined && !fresh ? (
          <Text size="sm" tone="quiet">
            Its work shows once you’re connected.
          </Text>
        ) : feed === undefined ? (
          <div aria-busy="true" aria-label="Loading its work" />
        ) : feed.length === 0 ? (
          <Text size="sm" tone="quiet">
            Nothing yet.
          </Text>
        ) : (
          <VirtualList items={feed} getKey={(item) => item.id} renderItem={(item) => <Step item={item} />} estimateSize={28} followOutput startAtEnd aria-label="Its work" />
        )}
      </div>
      {row.taskId !== undefined && row.workstreamId !== undefined && work.hasThread ? <SteerBox key={row.taskId} workstreamId={row.workstreamId} taskId={row.taskId} /> : null}
      <ToldPanel
        open={told && thread !== undefined ? { thread, name: roleWords(row.role), who: { project: row.projectTitle, role: ROLE_WORD[row.role] } } : undefined}
        projectRef={row.projectRef}
        onClose={() => setTold(false)}
      />
    </section>
  );
}

function Step({ item }: { item: FeedItem }) {
  if (item.kind === "writing") {
    return (
      <div className={s.message}>
        <Markdown source={item.text} />
      </div>
    );
  }
  if (item.kind === "message") {
    if (item.role === "assistant") {
      return (
        <div className={s.message}>
          <Markdown source={item.text} />
        </div>
      );
    }
    // What it was told (its brief, a steer), folded to a few lines: the agent's own words are the point here.
    return (
      <div className={cx(s.message, s.told)}>
        <Text size="xs" tone="quiet">
          {item.role === "user" ? "Told" : "Note"}
        </Text>
        <Truncate size="sm" tone="quiet" lines={3} expand="inline">
          {item.text}
        </Truncate>
      </div>
    );
  }
  const line = actionLine(item);
  return (
    <div className={s.action}>
      <span className={s.verb}>
        <Text size="xs" tone="quiet">
          {line.words}
        </Text>
      </span>
      <span className={cx(s.machine, line.tone === "danger" && s.failed)}>
        <MiddleCut text={line.machine} />
      </span>
      {line.outcome !== undefined ? (
        <Text size="xs" tone="danger">
          {line.outcome}
        </Text>
      ) : null}
    </div>
  );
}
